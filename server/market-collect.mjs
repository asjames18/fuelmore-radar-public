// Server-side market snapshot collection for the Worker's scheduled handler.
//
// Pair and token addresses are canonical in src/lib/contracts.ts (PAIRS and
// CONTRACTS) and are duplicated here because the Worker runs as plain
// JavaScript. If the registry changes, update both places.

const DEX_API = 'https://api.dexscreener.com/latest/dex/pairs/robinhood'

export const MARKET_HISTORY_KEY = 'market-history-v1'
// 90 days of 15-minute snapshots.
export const MARKET_HISTORY_MAX_POINTS = 90 * 24 * 4
export const MARKET_HISTORY_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

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

/**
 * Identity validation mirroring src/lib/api.ts fetchPair: the returned pair
 * must be on Robinhood Chain, at the expected pair address, and quoted for
 * the expected base token. Anything else is rejected, never recorded.
 */
export function validateDexPair(payload, pairAddress, tokenAddress) {
  const pair = payload?.pairs?.[0]
  if (!pair) throw new Error(`Pair not found: ${pairAddress}`)
  if (
    pair.chainId !== 'robinhood' ||
    String(pair.pairAddress).toLowerCase() !== pairAddress.toLowerCase() ||
    String(pair.baseToken?.address).toLowerCase() !== tokenAddress.toLowerCase()
  ) {
    throw new Error('Market identity mismatch')
  }
  return {
    priceUsd: pair.priceUsd != null ? asFiniteNumber(pair.priceUsd) : null,
    liquidityUsd: pair.liquidity?.usd != null ? asFiniteNumber(pair.liquidity.usd) : null,
  }
}

async function fetchPairSnapshot(key, fetchImpl) {
  const { pairAddress, tokenAddress } = TOKENS[key]
  const response = await fetchImpl(`${DEX_API}/${pairAddress}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Dexscreener ${response.status} for ${key}`)
  return validateDexPair(await response.json(), pairAddress, tokenAddress)
}

/**
 * Collect one market snapshot point. All-or-nothing: both pairs must fetch
 * and validate. Returns null on any failure so the caller leaves the stored
 * history untouched; nulls are never persisted for a failed side.
 */
export async function collectMarketSnapshot(fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000)) {
  const results = await Promise.allSettled([
    fetchPairSnapshot('fuel', fetchImpl),
    fetchPairSnapshot('more', fetchImpl),
  ])
  const [fuel, more] = results.map((r) => (r.status === 'fulfilled' ? r.value : null))
  // All-or-nothing: both sides must fetch and validate. On any failure the
  // caller keeps the existing history untouched.
  if (!fuel || !more) return null
  return {
    t: nowSeconds,
    fuelPrice: fuel?.priceUsd ?? null,
    fuelLiquidity: fuel?.liquidityUsd ?? null,
    morePrice: more?.priceUsd ?? null,
    moreLiquidity: more?.liquidityUsd ?? null,
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
export async function runMarketSnapshot(env) {
  if (!env?.ACTIVITY || typeof env.ACTIVITY.get !== 'function' || typeof env.ACTIVITY.put !== 'function') {
    console.error('Market snapshot skipped: ACTIVITY KV binding unavailable')
    return { ok: false, reason: 'kv-unavailable' }
  }
  let point
  try {
    point = await collectMarketSnapshot()
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
