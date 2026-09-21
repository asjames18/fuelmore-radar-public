// Server-side market snapshot collection for the Worker's scheduled handler.
//
// Pair and token addresses are canonical in src/lib/contracts.ts (PAIRS and
// CONTRACTS) and are duplicated here because the Worker runs as plain
// JavaScript. If the registry changes, update both places. Token and pair
// addresses are distinct identities and must never be confused.
//
// Collection strategy per pair:
//   1. Fetch the pair-specific Dexscreener endpoint with retries (429/5xx and
//      network errors retried up to 3 attempts with exponential backoff,
//      honoring the Retry-After response header when present).
//   2. If that still fails, fall back to the Dexscreener token endpoint and
//      select the entry matching chainId "robinhood" AND the expected
//      pairAddress.
//   3. Every accepted payload passes the strict validateDexPair identity
//      checks. Any pair failing after retry + fallback means the whole run
//      fails and the stored history is left untouched.

const DEX_PAIR_API = 'https://api.dexscreener.com/latest/dex/pairs/robinhood'
const DEX_TOKEN_API = 'https://api.dexscreener.com/latest/dex/tokens'

export const MARKET_HISTORY_KEY = 'market-history-v1'
// 90 days of 15-minute snapshots.
export const MARKET_HISTORY_MAX_POINTS = 90 * 24 * 4
export const MARKET_HISTORY_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

const MAX_FETCH_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000

const EXPECTED_CHAIN_ID = 'robinhood'

const TOKENS = {
  fuel: {
    pairAddress: '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69',
    tokenAddress: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3',
  },
  more: {
    pairAddress: '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef',
    tokenAddress: '0xc0F1A40512114b25cc1F30b5DF0bb48691405555',
  },
}

function asFiniteNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

export class MarketValidationError extends Error {
  constructor(pairKey, check, expected, actual) {
    super(`market snapshot [${pairKey}]: ${check} failed`)
    this.name = 'MarketValidationError'
    this.pairKey = pairKey
    this.check = check
    this.expected = expected
    this.actual = actual
  }
}

function validationFailure(pairKey, check, expected, actual) {
  return new MarketValidationError(pairKey, check, expected, actual)
}

/**
 * Identity validation mirroring src/lib/api.ts fetchPair: the returned pair
 * must be on Robinhood Chain, at the expected pair address, and quoted for
 * the expected base token. Anything else is rejected, never recorded.
 */
export function validateDexPair(payload, pairKey, pairAddress, tokenAddress) {
  const pair = payload?.pairs?.[0]
  if (!pair || typeof pair !== 'object') {
    throw validationFailure(
      pairKey,
      'pairs-returned',
      `at least one pair for ${pairAddress}`,
      Array.isArray(payload?.pairs) ? `pairs array length ${payload.pairs.length}` : 'pairs missing or not an array',
    )
  }
  if (pair.chainId !== EXPECTED_CHAIN_ID) {
    throw validationFailure(pairKey, 'chainId', EXPECTED_CHAIN_ID, String(pair.chainId))
  }
  if (String(pair.pairAddress).toLowerCase() !== pairAddress.toLowerCase()) {
    throw validationFailure(pairKey, 'pairAddress', pairAddress, String(pair.pairAddress))
  }
  if (String(pair.baseToken?.address).toLowerCase() !== tokenAddress.toLowerCase()) {
    throw validationFailure(pairKey, 'baseToken.address', tokenAddress, String(pair.baseToken?.address))
  }
  return {
    priceUsd: pair.priceUsd != null ? asFiniteNumber(pair.priceUsd) : null,
    liquidityUsd: pair.liquidity?.usd != null ? asFiniteNumber(pair.liquidity.usd) : null,
  }
}

function logValidationFailure(error, httpStatus, source) {
  if (error instanceof MarketValidationError) {
    console.error(
      `market snapshot [${error.pairKey}]: validation failed — ${error.check}: ` +
        `expected "${error.expected}", got "${error.actual}" (HTTP ${httpStatus} from ${source})`,
    )
  }
}

function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/** Retry-After is seconds (or an HTTP date); clamp it so one header can't stall the cron. */
function parseRetryAfterMs(value) {
  if (value == null) return null
  const seconds = Number(String(value).trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_MAX_DELAY_MS)
  return null
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function exponentialDelayMs(attempt) {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
}

/**
 * GET a Dexscreener JSON endpoint, retrying 429/5xx and network errors up to
 * MAX_FETCH_ATTEMPTS with exponential backoff. The Retry-After header, when
 * present, overrides the computed backoff. Non-retriable statuses (404,
 * 403, …) throw immediately so the caller can move to the fallback.
 */
async function fetchJsonWithRetry(url, { pairKey, source, fetchImpl, sleep }) {
  let lastError = null
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    let response
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error
      console.error(
        `market snapshot [${pairKey}]: ${source} attempt ${attempt}/${MAX_FETCH_ATTEMPTS} network error: ` +
          (error instanceof Error ? error.message : error),
      )
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(exponentialDelayMs(attempt))
      continue
    }
    if (response.ok) return response
    lastError = new Error(`Dexscreener HTTP ${response.status} for ${pairKey} (${source})`)
    if (isRetriableStatus(response.status) && attempt < MAX_FETCH_ATTEMPTS) {
      const delay = parseRetryAfterMs(response.headers.get('Retry-After')) ?? exponentialDelayMs(attempt)
      console.error(
        `market snapshot [${pairKey}]: ${source} attempt ${attempt}/${MAX_FETCH_ATTEMPTS} ` +
          `got HTTP ${response.status}; retrying in ${delay}ms`,
      )
      await sleep(delay)
      continue
    }
    throw lastError
  }
  throw lastError ?? new Error(`Dexscreener request failed for ${pairKey} (${source})`)
}

async function fetchPairSnapshot(pairKey, fetchImpl, sleep) {
  const { pairAddress, tokenAddress } = TOKENS[pairKey]
  const pairUrl = `${DEX_PAIR_API}/${pairAddress}`
  const tokenUrl = `${DEX_TOKEN_API}/${tokenAddress}`

  const fromPairEndpoint = async () => {
    const response = await fetchJsonWithRetry(pairUrl, { pairKey, source: 'pair endpoint', fetchImpl, sleep })
    const payload = await response.json()
    try {
      return validateDexPair(payload, pairKey, pairAddress, tokenAddress)
    } catch (error) {
      logValidationFailure(error, response.status, 'pair endpoint')
      throw error
    }
  }

  const fromTokenEndpoint = async () => {
    const response = await fetchJsonWithRetry(tokenUrl, { pairKey, source: 'token endpoint', fetchImpl, sleep })
    const payload = await response.json()
    const entries = Array.isArray(payload?.pairs) ? payload.pairs : []
    const match = entries.find(
      (entry) =>
        entry?.chainId === EXPECTED_CHAIN_ID &&
        String(entry?.pairAddress).toLowerCase() === pairAddress.toLowerCase(),
    )
    if (!match) {
      console.error(
        `market snapshot [${pairKey}]: token endpoint returned ${entries.length} pair entries, ` +
          `none matching expected pairAddress ${pairAddress} on chainId "${EXPECTED_CHAIN_ID}"`,
      )
      throw new Error(`market snapshot [${pairKey}]: fallback found no matching pair`)
    }
    try {
      return validateDexPair({ pairs: [match] }, pairKey, pairAddress, tokenAddress)
    } catch (error) {
      logValidationFailure(error, response.status, 'token endpoint')
      throw error
    }
  }

  try {
    return await fromPairEndpoint()
  } catch (error) {
    console.error(
      `market snapshot [${pairKey}]: pair endpoint failed (${error instanceof Error ? error.message : error}); ` +
        'trying token endpoint fallback',
    )
  }
  return fromTokenEndpoint()
}

/**
 * Collect one market snapshot point. All-or-nothing: both pairs must fetch
 * and validate. Returns null on any failure so the caller leaves the stored
 * history untouched; nulls are never persisted for a failed side.
 */
export async function collectMarketSnapshot(fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000), options = {}) {
  const sleep = options.sleep ?? defaultSleep
  const results = await Promise.allSettled([
    fetchPairSnapshot('fuel', fetchImpl, sleep),
    fetchPairSnapshot('more', fetchImpl, sleep),
  ])
  const [fuel, more] = results.map((r) => (r.status === 'fulfilled' ? r.value : null))
  // All-or-nothing: both sides must fetch and validate. On any failure the
  // caller keeps the existing history untouched.
  if (!fuel || !more) return null
  return {
    t: nowSeconds,
    fuelPrice: fuel.priceUsd ?? null,
    fuelLiquidity: fuel.liquidityUsd ?? null,
    morePrice: more.priceUsd ?? null,
    moreLiquidity: more.liquidityUsd ?? null,
  }
}

function isValidPoint(point) {
  return (
    !!point &&
    typeof point === 'object' &&
    Number.isInteger(point.t) &&
    point.t > 0 &&
    ['fuelPrice', 'fuelLiquidity', 'morePrice', 'moreLiquidity'].every(
      (key) => point[key] === null || (typeof point[key] === 'number' && Number.isFinite(point[key]) && point[key] >= 0),
    )
  )
}

function storedPoints(raw) {
  if (Array.isArray(raw?.points)) return raw.points
  if (Array.isArray(raw)) return raw
  return []
}

export async function readMarketHistory(kv) {
  // kv.get errors propagate so callers can distinguish "KV unavailable" from
  // "no history yet"; malformed payloads still degrade to an empty list.
  const raw = await kv.get(MARKET_HISTORY_KEY, 'json')
  const cutoff = Math.floor(Date.now() / 1000) - MARKET_HISTORY_MAX_AGE_SECONDS
  const byTime = new Map()
  for (const point of storedPoints(raw)) {
    if (isValidPoint(point) && point.t >= cutoff) byTime.set(point.t, point)
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-MARKET_HISTORY_MAX_POINTS)
}

export async function appendMarketHistory(kv, point) {
  const history = await readMarketHistory(kv)
  const last = history.at(-1)
  // Never record a duplicate or out-of-order observation.
  if (last && point.t <= last.t) return history
  const next = [...history, point].slice(-MARKET_HISTORY_MAX_POINTS)
  await kv.put(
    MARKET_HISTORY_KEY,
    JSON.stringify({ updatedAt: new Date(point.t * 1000).toISOString(), points: next }),
  )
  return next
}

/** Scheduled entry point: validate, append, and prune. Failures keep history untouched. */
export async function runMarketSnapshot(env, options = {}) {
  if (!env?.ACTIVITY || typeof env.ACTIVITY.get !== 'function' || typeof env.ACTIVITY.put !== 'function') {
    console.error('Market snapshot skipped: ACTIVITY KV binding unavailable')
    return { ok: false, reason: 'kv-unavailable' }
  }
  let point
  try {
    point = await collectMarketSnapshot(undefined, undefined, options)
  } catch (error) {
    console.error('Market snapshot failed:', error instanceof Error ? error.message : error)
    return { ok: false, reason: 'fetch-failed' }
  }
  if (!point) {
    console.error('Market snapshot failed: pair validation failed; history untouched')
    return { ok: false, reason: 'validation-failed' }
  }
  try {
    await appendMarketHistory(env.ACTIVITY, point)
  } catch (error) {
    // KV read/write failed: never write a partial entry, keep history untouched.
    console.error('Market snapshot storage failed:', error instanceof Error ? error.message : error)
    return { ok: false, reason: 'storage-failed' }
  }
  return { ok: true, t: point.t }
}
