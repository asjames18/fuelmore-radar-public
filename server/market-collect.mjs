// Server-side market snapshot collection for the Worker's scheduled handler.
//
// Pair and token addresses are canonical in src/lib/contracts.ts (PAIRS and
// CONTRACTS) and are duplicated in server/price-sources.mjs because the
// Worker runs as plain JavaScript. If the registry changes, update both
// places. Token and pair addresses are distinct identities and must never
// be confused.
//
// Collection strategy per pair (server/price-sources.mjs):
//   1. Try each price source in ordered failover — GeckoTerminal, then
//      DexPaprika, then Dexscreener. First valid result wins. Every source
//      retries 429/5xx and network errors up to 3 attempts with exponential
//      backoff, honoring the Retry-After response header when present.
//   2. The Dexscreener source itself keeps its internal fallback: pair
//      endpoint first, then the token endpoint with strict matching of
//      chainId "robinhood" AND the expected pairAddress.
//   3. Every accepted payload passes strict identity validation. A pair that
//      fails on every source means the whole run fails and the stored
//      history is left untouched (all-or-nothing).

import {
  SOURCES,
  SOURCE_ORDER,
  TOKENS,
} from './price-sources.mjs'

// Re-exported for tests and any existing importers.
export {
  MarketValidationError,
  SOURCE_ORDER,
  validateDexPair,
} from './price-sources.mjs'

export const MARKET_HISTORY_KEY = 'market-history-v1'
// 90 days of 15-minute snapshots.
export const MARKET_HISTORY_MAX_POINTS = 90 * 24 * 4
export const MARKET_HISTORY_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function fetchPairSnapshot(pairKey, fetchImpl, sleep, sources) {
  const { pairAddress, tokenAddress } = TOKENS[pairKey]
  for (const sourceName of sources) {
    const source = SOURCES[sourceName]
    if (!source) {
      console.error(`market snapshot [${pairKey}]: unknown price source "${sourceName}"; skipping`)
      continue
    }
    try {
      const result = await source.fetchPair({ pairKey, pairAddress, tokenAddress, fetchImpl, sleep })
      console.log(
        `market snapshot [${pairKey}]: source ${sourceName} succeeded ` +
          `(price ${result.priceUsd}, liquidity ${result.liquidityUsd})`,
      )
      return result
    } catch (error) {
      console.error(
        `market snapshot [${pairKey}]: source ${sourceName} failed ` +
          `(${error instanceof Error ? error.message : error}); trying next source`,
      )
    }
  }
  return null
}

/**
 * Collect one market snapshot point. All-or-nothing: both pairs must fetch
 * and validate. Returns null on any failure so the caller leaves the stored
 * history untouched; nulls are never persisted for a failed side.
 */
export async function collectMarketSnapshot(fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000), options = {}) {
  const sleep = options.sleep ?? defaultSleep
  const sources = Array.isArray(options.sources) && options.sources.length > 0 ? options.sources : SOURCE_ORDER
  const results = await Promise.allSettled([
    fetchPairSnapshot('fuel', fetchImpl, sleep, sources),
    fetchPairSnapshot('more', fetchImpl, sleep, sources),
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
