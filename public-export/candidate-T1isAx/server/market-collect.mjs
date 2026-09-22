// Server-side market snapshot collection for the Worker's scheduled handler.
//
// Pair and token addresses are canonical in src/lib/contracts.ts (PAIRS and
// CONTRACTS) and are duplicated in server/price-sources.mjs because the
// Worker runs as plain JavaScript. If the registry changes, update both
// places. Token and pair addresses are distinct identities and must never
// be confused.
//
// Collection strategy per pair (server/price-sources.mjs):
//   1. Try each price source in ordered failover — Dexscreener, then
//      GeckoTerminal, then DexPaprika. First valid result wins. Every source
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
  checkQuoteFreshness,
} from './price-sources.mjs'

// Re-exported for tests and any existing importers.
export {
  MarketValidationError,
  SOURCE_ORDER,
  validateDexPair,
} from './price-sources.mjs'

export const MARKET_HISTORY_KEY = 'market-history-v2'
// v2: points carry per-point source attribution (fuelSource/moreSource plus
// the upstream quote timestamps when published) and the freshness gate
// rejects stale quotes before they are stored. The v1 feed's last points
// were recorded from a ~2h-stale DexPaprika read and are abandoned rather
// than migrated.
export const MARKET_HISTORY_MAX_POINTS = 90 * 24 * 4
export const MARKET_HISTORY_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

/**
 * Deviation guard: a fresh last point (within DEVIATION_FRESH_SECONDS)
 * against which a new price moved more than DEVIATION_RATIO on either side
 * must be corroborated by a second source before it is stored. A >50% move
 * on one source's word alone is exactly the E1 failure mode; dropping the
 * point keeps the history untouched (null-never-zero) until the move is
 * confirmed by independent data.
 */
export const DEVIATION_FRESH_SECONDS = 90 * 60
export const DEVIATION_RATIO = 0.5

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function fetchPairSnapshot(pairKey, fetchImpl, sleep, sources, dexpaprikaApiKey, nowSeconds) {
  const { pairAddress, tokenAddress } = TOKENS[pairKey]
  for (const sourceName of sources) {
    const source = SOURCES[sourceName]
    if (!source) {
      console.error(`market snapshot [${pairKey}]: unknown price source "${sourceName}"; skipping`)
      continue
    }
    try {
      const raw = await source.fetchPair({ pairKey, pairAddress, tokenAddress, fetchImpl, sleep, dexpaprikaApiKey })
      // Freshness gate: a stale upstream quote fails over to the next source
      // instead of becoming a stored point.
      const result = checkQuoteFreshness(raw, pairKey, sourceName, nowSeconds)
      console.log(
        `market snapshot [${pairKey}]: source ${sourceName} succeeded ` +
          `(price ${result.priceUsd}, liquidity ${result.liquidityUsd})`,
      )
      return { ...result, source: sourceName }
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
  // Only DexPaprika consumes this; other sources ignore the extra argument.
  // The raw value is never logged.
  const dexpaprikaApiKey =
    typeof options.dexpaprikaApiKey === 'string' && options.dexpaprikaApiKey.length > 0
      ? options.dexpaprikaApiKey
      : null
  const results = await Promise.allSettled([
    fetchPairSnapshot('fuel', fetchImpl, sleep, sources, dexpaprikaApiKey, nowSeconds),
    fetchPairSnapshot('more', fetchImpl, sleep, sources, dexpaprikaApiKey, nowSeconds),
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
    // Per-point source attribution: which upstream each side's quote came
    // from, plus the upstream quote timestamp when the source publishes one.
    fuelSource: fuel.source,
    moreSource: more.source,
    fuelObservedAt: fuel.observedAt ?? null,
    moreObservedAt: more.observedAt ?? null,
  }
}

function isValidPoint(point) {
  const validSource = (value) => value === undefined || value === null || typeof value === 'string'
  const validObservedAt = (value) =>
    value === undefined || value === null || (Number.isInteger(value) && value > 0)
  return (
    !!point &&
    typeof point === 'object' &&
    Number.isInteger(point.t) &&
    point.t > 0 &&
    ['fuelPrice', 'fuelLiquidity', 'morePrice', 'moreLiquidity'].every(
      (key) => point[key] === null || (typeof point[key] === 'number' && Number.isFinite(point[key]) && point[key] >= 0),
    ) &&
    validSource(point.fuelSource) &&
    validSource(point.moreSource) &&
    validObservedAt(point.fuelObservedAt) &&
    validObservedAt(point.moreObservedAt)
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

/** Which sides moved more than DEVIATION_RATIO vs a fresh last point (prices only; liquidity swings legitimately). */
export function deviatingSides(point, last) {
  if (!last || typeof last.t !== 'number' || point.t - last.t > DEVIATION_FRESH_SECONDS) return []
  const out = []
  for (const [side, priceKey] of [['fuel', 'fuelPrice'], ['more', 'morePrice']]) {
    const prev = last[priceKey]
    const next = point[priceKey]
    if (typeof prev === 'number' && prev > 0 && typeof next === 'number' && next > 0) {
      if (Math.abs(next - prev) / prev > DEVIATION_RATIO) out.push(side)
    }
  }
  return out
}

/**
 * Corroborate a deviating side with a *different* source than the one that
 * won failover. Returns true only when a second source independently
 * reports a price within DEVIATION_RATIO of the candidate. Any failure —
 * no second source answers, it disagrees, or its quote is stale — means
 * "unconfirmed": the point is withheld and history stays untouched.
 */
export async function corroborateDeviation(side, point, sources, fetchImpl, sleep, dexpaprikaApiKey, nowSeconds) {
  const winner = side === 'fuel' ? point.fuelSource : point.moreSource
  const others = sources.filter((name) => name !== winner)
  if (others.length === 0) return false
  const confirm = await fetchPairSnapshot(side, fetchImpl, sleep, others, dexpaprikaApiKey, nowSeconds)
  if (!confirm) {
    console.error(`market snapshot [${side}]: deviation uncorroborated — no second source answered`)
    return false
  }
  const candidate = side === 'fuel' ? point.fuelPrice : point.morePrice
  const second = confirm.priceUsd
  if (!(typeof candidate === 'number' && candidate > 0 && typeof second === 'number' && second > 0)) return false
  if (Math.abs(candidate - second) / second > DEVIATION_RATIO) {
    console.error(
      `market snapshot [${side}]: deviation uncorroborated — ${winner} says ${candidate}, ` +
        `${confirm.source} says ${second}`,
    )
    return false
  }
  console.log(`market snapshot [${side}]: deviation corroborated by ${confirm.source}`)
  return true
}

/** Scheduled entry point: validate, append, and prune. Failures keep history untouched. */
export async function runMarketSnapshot(env, options = {}) {
  if (!env?.ACTIVITY || typeof env.ACTIVITY.get !== 'function' || typeof env.ACTIVITY.put !== 'function') {
    console.error('Market snapshot skipped: ACTIVITY KV binding unavailable')
    return { ok: false, reason: 'kv-unavailable' }
  }
  // DEXPAPRIKA_API_KEY is a Worker secret set in the Cloudflare dashboard.
  // An explicit options.dexpaprikaApiKey (tests, manual runs) wins. The raw
  // value is never logged — only whether keyed mode is active.
  const merged = { ...options }
  if (merged.dexpaprikaApiKey == null) {
    const envKey = env?.DEXPAPRIKA_API_KEY
    if (typeof envKey === 'string' && envKey.length > 0) merged.dexpaprikaApiKey = envKey
  }
  const sources = Array.isArray(merged.sources) && merged.sources.length > 0 ? merged.sources : SOURCE_ORDER
  const fetchImpl = merged.fetchImpl ?? fetch
  console.log(`market snapshot: DexPaprika ${merged.dexpaprikaApiKey ? 'keyed' : 'keyless'} mode`)
  let history
  try {
    history = await readMarketHistory(env.ACTIVITY)
  } catch (error) {
    console.error('Market snapshot failed: history read failed:', error instanceof Error ? error.message : error)
    return { ok: false, reason: 'history-unreadable' }
  }
  let point
  try {
    point = await collectMarketSnapshot(fetchImpl, undefined, merged)
  } catch (error) {
    console.error('Market snapshot failed:', error instanceof Error ? error.message : error)
    return { ok: false, reason: 'fetch-failed' }
  }
  if (!point) {
    console.error('Market snapshot failed: pair validation failed; history untouched')
    return { ok: false, reason: 'validation-failed' }
  }
  // Deviation guard: a >50% price move vs a fresh last point needs a second
  // source's confirmation, otherwise the point is withheld (E1).
  const deviating = deviatingSides(point, history.at(-1))
  if (deviating.length > 0) {
    const sleep = merged.sleep ?? defaultSleep
    const results = await Promise.all(
      deviating.map((side) =>
        corroborateDeviation(side, point, sources, fetchImpl, sleep, merged.dexpaprikaApiKey),
      ),
    )
    if (results.some((ok) => !ok)) {
      console.error(
        `Market snapshot withheld: ${deviating.join(', ')} moved >${DEVIATION_RATIO * 100}% vs the last fresh point ` +
          'without corroboration; history untouched',
      )
      return { ok: false, reason: 'deviation-uncorroborated' }
    }
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
