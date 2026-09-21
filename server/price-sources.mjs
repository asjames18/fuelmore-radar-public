// Price-source adapters for market snapshot collection.
//
// The scheduled collector tries sources in ordered failover per pair:
//   1. Dexscreener (free, no key) — primary. Proven working from Cloudflare
//      Workers egress; throttles intermittently (observed 429 streak
//      2026-09-21 ~01:30-02:00 UTC, recovered by ~03:20 UTC).
//   2. GeckoTerminal (free, no key) — fallback. Returns HTTP 429 from
//      Cloudflare Workers shared egress (probed 2026-09-21, persistent across
//      repeated probes); kept in rotation in case its throttling is transient.
//   3. DexPaprika (free, no key) — last resort. Returns HTTP 402 from Workers
//      egress: the shared keyless monthly credit quota is exhausted
//      (probed 2026-09-21). A free DexPaprika API key (dedicated quota) would
//      make this a reliable primary; until then it fast-fails and costs one
//      subrequest per pair.
//
// Order last changed 2026-09-21: live egress probes from a Cloudflare Worker
// showed GeckoTerminal 429 and DexPaprika 402 while Dexscreener returned 200,
// so Dexscreener leads. The earlier GeckoTerminal-first ranking was based on
// probes from a non-Cloudflare VM and does not hold on Workers egress.
//
// Each adapter normalizes to { priceUsd, liquidityUsd } and runs STRICT
// identity validation: the returned pool must be on Robinhood Chain, at the
// expected pool address, and quoted for the expected base token. Anything
// else is rejected and never recorded. Token, pool, controller, proxy,
// staking, and implementation addresses are distinct identities and must
// never be confused.
//
// Pair and token addresses are canonical in src/lib/contracts.ts (PAIRS and
// CONTRACTS) and are duplicated here because the Worker runs as plain
// JavaScript. If the registry changes, update both places.

const GECKOTERMINAL_API = 'https://api.geckoterminal.com/api/v2/networks/robinhood/pools'
const GECKOTERMINAL_ACCEPT = 'application/json;version=20230302'
const DEXPAPRIKA_API = 'https://api.dexpaprika.com/networks/robinhood/pools'
const DEX_PAIR_API = 'https://api.dexscreener.com/latest/dex/pairs/robinhood'
const DEX_TOKEN_API = 'https://api.dexscreener.com/latest/dex/tokens'

export const EXPECTED_CHAIN_ID = 'robinhood'
export const EXPECTED_NETWORK_ID = 'robinhood'

export const SOURCE_ORDER = ['dexscreener', 'geckoterminal', 'dexpaprika']

const MAX_FETCH_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000

export const TOKENS = {
  fuel: {
    pairAddress: '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69',
    tokenAddress: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3',
  },
  more: {
    pairAddress: '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef',
    tokenAddress: '0xc0F1A40512114b25cc1F30b5DF0bb48691405555',
  },
}

export function asFiniteNumber(value) {
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

export function validationFailure(pairKey, check, expected, actual) {
  return new MarketValidationError(pairKey, check, expected, actual)
}

export function logValidationFailure(error, httpStatus, source) {
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
export function parseRetryAfterMs(value) {
  if (value == null) return null
  const seconds = Number(String(value).trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_MAX_DELAY_MS)
  return null
}

function exponentialDelayMs(attempt) {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
}

/**
 * GET a JSON endpoint, retrying 429/5xx and network errors up to
 * MAX_FETCH_ATTEMPTS with exponential backoff. The Retry-After header, when
 * present, overrides the computed backoff. Non-retriable statuses (404,
 * 403, …) throw immediately so the caller can move to the next step.
 */
export async function fetchJsonWithRetry(url, { pairKey, source, label, fetchImpl, sleep, headers }) {
  let lastError = null
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    let response
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error
      console.error(
        `market snapshot [${pairKey}]: ${label} (${source}) attempt ${attempt}/${MAX_FETCH_ATTEMPTS} network error: ` +
          (error instanceof Error ? error.message : error),
      )
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(exponentialDelayMs(attempt))
      continue
    }
    if (response.ok) return response
    lastError = new Error(`${label} HTTP ${response.status} for ${pairKey} (${source})`)
    if (isRetriableStatus(response.status) && attempt < MAX_FETCH_ATTEMPTS) {
      const delay = parseRetryAfterMs(response.headers.get('Retry-After')) ?? exponentialDelayMs(attempt)
      console.error(
        `market snapshot [${pairKey}]: ${label} (${source}) attempt ${attempt}/${MAX_FETCH_ATTEMPTS} ` +
          `got HTTP ${response.status}; retrying in ${delay}ms`,
      )
      await sleep(delay)
      continue
    }
    throw lastError
  }
  throw lastError ?? new Error(`${label} request failed for ${pairKey} (${source})`)
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

/**
 * GeckoTerminal pool validation. The pool resource must carry the expected
 * pool address, and its base token relationship must resolve to the
 * expected token on the robinhood network (id format "robinhood_0x…").
 */
export function validateGeckoPool(payload, pairKey, pairAddress, tokenAddress) {
  const pool = payload?.data
  if (!pool || typeof pool !== 'object' || typeof pool.attributes !== 'object') {
    throw validationFailure(
      pairKey,
      'geckoterminal.pool-returned',
      `pool resource for ${pairAddress}`,
      pool == null ? 'data missing' : 'pool attributes missing',
    )
  }
  if (String(pool.attributes.address).toLowerCase() !== pairAddress.toLowerCase()) {
    throw validationFailure(pairKey, 'geckoterminal.address', pairAddress, String(pool.attributes.address))
  }
  const baseTokenId = `robinhood_${tokenAddress}`.toLowerCase()
  const actualBaseTokenId = String(pool.relationships?.base_token?.data?.id ?? '').toLowerCase()
  if (actualBaseTokenId !== baseTokenId) {
    throw validationFailure(pairKey, 'geckoterminal.base_token.id', baseTokenId, actualBaseTokenId || 'missing')
  }
  return {
    priceUsd: pool.attributes.base_token_price_usd != null ? asFiniteNumber(pool.attributes.base_token_price_usd) : null,
    liquidityUsd: pool.attributes.reserve_in_usd != null ? asFiniteNumber(pool.attributes.reserve_in_usd) : null,
  }
}

/**
 * DexPaprika pool validation. The pool id must equal the expected pool
 * address and the token list must contain the expected base token.
 */
export function validateDexPaprikaPool(payload, pairKey, pairAddress, tokenAddress) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw validationFailure(
      pairKey,
      'dexpaprika.pool-returned',
      `pool resource for ${pairAddress}`,
      payload == null ? 'body missing' : 'body not an object',
    )
  }
  if (String(payload.id).toLowerCase() !== pairAddress.toLowerCase()) {
    throw validationFailure(pairKey, 'dexpaprika.id', pairAddress, String(payload.id))
  }
  const tokens = Array.isArray(payload.tokens) ? payload.tokens : []
  const tokenMatch = tokens.some(
    (token) => token && String(token.id).toLowerCase() === tokenAddress.toLowerCase(),
  )
  if (!tokenMatch) {
    throw validationFailure(
      pairKey,
      'dexpaprika.tokens',
      `token list containing ${tokenAddress}`,
      tokens.length ? tokens.map((t) => String(t?.id)).join(', ') : 'tokens missing or empty',
    )
  }
  return {
    priceUsd: payload.last_price_usd != null ? asFiniteNumber(payload.last_price_usd) : null,
    liquidityUsd: payload.liquidity_usd != null ? asFiniteNumber(payload.liquidity_usd) : null,
  }
}

async function fetchGeckoPairSnapshot({ pairKey, pairAddress, tokenAddress, fetchImpl, sleep }) {
  const url = `${GECKOTERMINAL_API}/${pairAddress}`
  const source = 'geckoterminal'
  const response = await fetchJsonWithRetry(url, {
    pairKey,
    source,
    label: 'GeckoTerminal',
    fetchImpl,
    sleep,
    headers: { Accept: GECKOTERMINAL_ACCEPT },
  })
  const payload = await response.json()
  try {
    return validateGeckoPool(payload, pairKey, pairAddress, tokenAddress)
  } catch (error) {
    logValidationFailure(error, response.status, source)
    throw error
  }
}

async function fetchDexPaprikaPairSnapshot({ pairKey, pairAddress, tokenAddress, fetchImpl, sleep }) {
  const url = `${DEXPAPRIKA_API}/${pairAddress}`
  const source = 'dexpaprika'
  const response = await fetchJsonWithRetry(url, { pairKey, source, label: 'DexPaprika', fetchImpl, sleep })
  const payload = await response.json()
  try {
    return validateDexPaprikaPool(payload, pairKey, pairAddress, tokenAddress)
  } catch (error) {
    logValidationFailure(error, response.status, source)
    throw error
  }
}

async function fetchDexscreenerPairSnapshot({ pairKey, pairAddress, tokenAddress, fetchImpl, sleep }) {
  const pairUrl = `${DEX_PAIR_API}/${pairAddress}`
  const tokenUrl = `${DEX_TOKEN_API}/${tokenAddress}`

  const fromPairEndpoint = async () => {
    const response = await fetchJsonWithRetry(pairUrl, { pairKey, source: 'dexscreener pair endpoint', label: 'Dexscreener', fetchImpl, sleep })
    const payload = await response.json()
    try {
      return validateDexPair(payload, pairKey, pairAddress, tokenAddress)
    } catch (error) {
      logValidationFailure(error, response.status, 'dexscreener pair endpoint')
      throw error
    }
  }

  const fromTokenEndpoint = async () => {
    const response = await fetchJsonWithRetry(tokenUrl, { pairKey, source: 'dexscreener token endpoint', label: 'Dexscreener', fetchImpl, sleep })
    const payload = await response.json()
    const entries = Array.isArray(payload?.pairs) ? payload.pairs : []
    const match = entries.find(
      (entry) =>
        entry?.chainId === EXPECTED_CHAIN_ID &&
        String(entry?.pairAddress).toLowerCase() === pairAddress.toLowerCase(),
    )
    if (!match) {
      console.error(
        `market snapshot [${pairKey}]: dexscreener token endpoint returned ${entries.length} pair entries, ` +
          `none matching expected pairAddress ${pairAddress} on chainId "${EXPECTED_CHAIN_ID}"`,
      )
      throw new Error(`market snapshot [${pairKey}]: dexscreener fallback found no matching pair`)
    }
    try {
      return validateDexPair({ pairs: [match] }, pairKey, pairAddress, tokenAddress)
    } catch (error) {
      logValidationFailure(error, response.status, 'dexscreener token endpoint')
      throw error
    }
  }

  try {
    return await fromPairEndpoint()
  } catch (error) {
    console.error(
      `market snapshot [${pairKey}]: dexscreener pair endpoint failed ` +
        `(${error instanceof Error ? error.message : error}); trying token endpoint fallback`,
    )
  }
  return fromTokenEndpoint()
}

/** Source registry in failover order. First valid result wins per pair. */
export const SOURCES = {
  geckoterminal: { label: 'GeckoTerminal', fetchPair: fetchGeckoPairSnapshot },
  dexpaprika: { label: 'DexPaprika', fetchPair: fetchDexPaprikaPairSnapshot },
  dexscreener: { label: 'Dexscreener', fetchPair: fetchDexscreenerPairSnapshot },
}
