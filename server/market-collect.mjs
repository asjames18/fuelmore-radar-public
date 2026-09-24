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
//      backoff, honoring a positive Retry-After response header when present
//      (zero/negative values are ignored so retries actually back off).
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
import { storeGetJson, storePut } from './d1-store.mjs'

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

async function fetchPairSnapshot(pairKey, fetchImpl, sleep, sources, dexpaprikaApiKey, nowSeconds, onAttempt) {
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
      if (typeof onAttempt === 'function') onAttempt(pairKey, sourceName, true)
      return { ...result, source: sourceName }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `market snapshot [${pairKey}]: source ${sourceName} failed ` + `(${message}); trying next source`,
      )
      if (typeof onAttempt === 'function') onAttempt(pairKey, sourceName, false, message)
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
  const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : undefined
  // Only DexPaprika consumes this; other sources ignore the extra argument.
  // The raw value is never logged.
  const dexpaprikaApiKey =
    typeof options.dexpaprikaApiKey === 'string' && options.dexpaprikaApiKey.length > 0
      ? options.dexpaprikaApiKey
      : null
  const results = await Promise.allSettled([
    fetchPairSnapshot('fuel', fetchImpl, sleep, sources, dexpaprikaApiKey, nowSeconds, onAttempt),
    fetchPairSnapshot('more', fetchImpl, sleep, sources, dexpaprikaApiKey, nowSeconds, onAttempt),
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

export async function readMarketHistory(env) {
  // Storage errors propagate so callers can distinguish "unavailable" from
  // "no history yet"; malformed payloads still degrade to an empty list.
  const raw = await storeGetJson(env, MARKET_HISTORY_KEY)
  const cutoff = Math.floor(Date.now() / 1000) - MARKET_HISTORY_MAX_AGE_SECONDS
  const byTime = new Map()
  for (const point of storedPoints(raw)) {
    if (isValidPoint(point) && point.t >= cutoff) byTime.set(point.t, point)
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-MARKET_HISTORY_MAX_POINTS)
}

export async function appendMarketHistory(env, point) {
  const history = await readMarketHistory(env)
  const last = history.at(-1)
  // Never record a duplicate or out-of-order observation.
  if (last && point.t <= last.t) return history
  const next = [...history, point].slice(-MARKET_HISTORY_MAX_POINTS)
  await storePut(
    env,
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
/**
 * Scheduled-entry wrapper: runs one market snapshot and persists a compact
 * run record (outcome + per-side, per-source attempt results) to the
 * `market-snapshot-last-run` KV key, rolling the last 24 runs. Diagnostics
 * are private — they are not surfaced in the public UI — and best-effort:
 * a KV failure never changes the snapshot outcome. Error text is truncated
 * and never contains secrets (the DexPaprika key travels in an
 * Authorization header, never in a URL or message).
 */
export async function runMarketSnapshot(env, options = {}) {
  const attempts = []
  const recordAttempt = (side, source, ok, error) => {
    attempts.push({ side, source, ok, ...(ok ? {} : { error: String(error ?? '').slice(0, 160) }) })
  }
  const prevOnAttempt = options.onAttempt
  const outcome = await collectAndStoreMarketSnapshot(env, {
    ...options,
    onAttempt: (...args) => {
      recordAttempt(...args)
      if (typeof prevOnAttempt === 'function') prevOnAttempt(...args)
    },
  })
  try {
    const kv = env?.ACTIVITY
    if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
      const entry = {
        msg: 'market-snapshot-run',
        at: new Date().toISOString(),
        ok: outcome.ok,
        reason: outcome.reason ?? null,
        pointT: outcome.t ?? null,
        attempts,
      }
      let runs = []
      try {
        const parsed = JSON.parse((await kv.get('market-snapshot-last-run')) ?? 'null')
        if (parsed && Array.isArray(parsed.runs)) runs = parsed.runs
      } catch {
        // Corrupted diagnostic state starts fresh; the run record itself is fine.
      }
      runs = [...runs, entry].slice(-24)
      await kv.put('market-snapshot-last-run', JSON.stringify({ runs }))
    }
  } catch {
    // Diagnostics are best-effort; the snapshot result stands.
  }
  return outcome
}

async function collectAndStoreMarketSnapshot(env, options = {}) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') {
    console.error('Market snapshot skipped: D1 binding unavailable')
    return { ok: false, reason: 'd1-unavailable' }
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
    history = await readMarketHistory(env)
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
    await appendMarketHistory(env, point)
  } catch (error) {
    // Storage read/write failed: never write a partial entry, keep history untouched.
    console.error('Market snapshot storage failed:', error instanceof Error ? error.message : error)
    return { ok: false, reason: 'storage-failed' }
  }
  return { ok: true, t: point.t }
}
