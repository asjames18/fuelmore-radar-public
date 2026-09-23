import type { HistoryPoint, PairSnapshot } from './types'

import { storageKey } from './storage'
// v2: the pre-fix local series could contain the poisoned FUEL quote served by
// the v1 market-history API, so it is never carried forward. Fresh browser
// points accumulate from the honest feed and merge with server v2 history.
const key = () => storageKey('history-v2')
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
const MAX_POINTS = 720
let sessionHistory: HistoryPoint[] = []

function isHistoryPoint(value: unknown): value is HistoryPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return typeof point.at === 'number' && Number.isFinite(point.at)
    && ['fuelPrice', 'morePrice', 'fuelLiquidity', 'moreLiquidity'].every((key) =>
      point[key] === null || (typeof point[key] === 'number' && Number.isFinite(point[key]) && point[key] >= 0))
}

function normalizeHistory(value: unknown): HistoryPoint[] {
  if (!Array.isArray(value)) return []
  const now = Date.now()
  const byTime = new Map<number, HistoryPoint>()
  for (const point of value) {
    if (isHistoryPoint(point) && point.at >= now - MAX_AGE && point.at <= now) {
      byTime.set(point.at, point)
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at).slice(-MAX_POINTS)
}

export function readHistory(): HistoryPoint[] {
  let saved: HistoryPoint[] = []
  try {
    saved = normalizeHistory(JSON.parse(localStorage.getItem(key()) ?? '[]'))
  } catch {
    // History remains available for this session when storage is inaccessible.
  }
  sessionHistory = normalizeHistory([...saved, ...sessionHistory])
  return [...sessionHistory]
}

export function recordHistory(pairs: PairSnapshot[], observedAt = Date.now()): HistoryPoint[] {
  const fuel = pairs.find((pair) => pair.symbol === 'FUEL')
  const more = pairs.find((pair) => pair.symbol === 'MORE')
  if (!fuel && !more) return readHistory()

  const history = readHistory()
  const last = history.at(-1)
  const now = observedAt
  if (last && now - last.at < 20_000) return history

  const next = normalizeHistory([...history, {
    at: now,
    fuelPrice: fuel?.priceUsd ?? null,
    morePrice: more?.priceUsd ?? null,
    fuelLiquidity: fuel?.liquidityUsd ?? null,
    moreLiquidity: more?.liquidityUsd ?? null,
  }])
  sessionHistory = next
  try {
    localStorage.setItem(key(), JSON.stringify(next))
  } catch {
    // A quota or privacy restriction must not fail an otherwise successful refresh.
  }
  return [...next]
}

/** Server market-history v2 point: seconds-based, with per-side attribution. */
type RemotePoint = {
  t: number
  fuelPrice: number | null
  morePrice: number | null
  fuelLiquidity: number | null
  moreLiquidity: number | null
  fuelSource?: string | null
  moreSource?: string | null
  fuelObservedAt?: number | null
  moreObservedAt?: number | null
}

function isRemotePoint(value: unknown): value is RemotePoint {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  const num = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
  const src = (v: unknown) => v === undefined || v === null || typeof v === 'string'
  const ts = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0)
  return typeof p.t === 'number' && Number.isFinite(p.t) && p.t > 0
    && num(p.fuelPrice) && num(p.morePrice) && num(p.fuelLiquidity) && num(p.moreLiquidity)
    && src(p.fuelSource) && src(p.moreSource) && ts(p.fuelObservedAt) && ts(p.moreObservedAt)
}

/** Normalize one server point into client HistoryPoint shape (ms timestamps). */
export function normalizeRemotePoint(value: unknown): HistoryPoint | null {
  if (!isRemotePoint(value)) return null
  const point: HistoryPoint = {
    at: value.t * 1000,
    fuelPrice: value.fuelPrice,
    morePrice: value.morePrice,
    fuelLiquidity: value.fuelLiquidity,
    moreLiquidity: value.moreLiquidity,
  }
  if (value.fuelSource) point.fuelSource = value.fuelSource
  if (value.moreSource) point.moreSource = value.moreSource
  if (value.fuelObservedAt) point.fuelObservedAt = value.fuelObservedAt * 1000
  if (value.moreObservedAt) point.moreObservedAt = value.moreObservedAt * 1000
  return isHistoryPoint(point) ? point : null
}

function persistHistory(points: HistoryPoint[]): void {
  try {
    localStorage.setItem(key(), JSON.stringify(points))
  } catch {
    // A quota or privacy restriction must not fail an otherwise successful refresh.
  }
}

/**
 * Fetch the server-collected market history (market-history v2: ordered
 * failover, quote-freshness guarded, per-point source attribution).
 * Progressive enhancement — resolves to [] on any failure so the caller
 * keeps the browser-local series.
 */
export async function fetchRemoteHistory(signal?: AbortSignal): Promise<HistoryPoint[]> {
  try {
    const response = await fetch('/api/market-history', signal ? { signal } : undefined)
    if (!response.ok) return []
    const payload = (await response.json()) as { points?: unknown }
    if (!payload || !Array.isArray(payload.points)) return []
    const points: HistoryPoint[] = []
    for (const raw of payload.points) {
      const point = normalizeRemotePoint(raw)
      if (point) points.push(point)
    }
    return normalizeHistory(points)
  } catch {
    return []
  }
}

/**
 * Merge the server-collected series with the browser-local series into one
 * chartable history. The server series is authoritative (failover-guarded,
 * attributed); local points fill the gaps between collector runs. On an
 * exact timestamp collision the attributed server point wins. The merged
 * series is persisted so the chart is warm on the next load.
 */
export function mergeHistory(remote: HistoryPoint[], local: HistoryPoint[]): HistoryPoint[] {
  const byTime = new Map<number, HistoryPoint>()
  for (const point of local) byTime.set(point.at, point)
  for (const point of remote) byTime.set(point.at, point)
  // normalizeHistory re-applies the age cap, sorts, and caps the length.
  const merged = normalizeHistory([...byTime.values()])
  sessionHistory = merged
  persistHistory(merged)
  return [...merged]
}

/**
 * Per-side quote derived from the worker-owned market series — the same feed
 * that backs the Markets chart. Feeding the token cards from these quotes
 * means cards and chart cannot disagree on price.
 */
export type SideQuote = {
  /** Newest worker-observed price for the side; null when the series has none. */
  priceUsd: number | null
  /** Newest worker-observed liquidity for the side; null when the series has none. */
  liquidityUsd: number | null
  /**
   * Percent change between the newest price and the newest series point at or
   * before 24h earlier. Stays null when the series cannot support the
   * comparison — never invented from an incompatible feed.
   */
  change24h: number | null
  /** Timestamp (ms) of the point the price came from. */
  observedAt: number | null
  /** Attribution of the price point (e.g. 'dexscreener'), when the server sent one. */
  source: string | null
}

const SIDE_FIELDS = {
  FUEL: { price: 'fuelPrice', liquidity: 'fuelLiquidity', source: 'fuelSource' },
  MORE: { price: 'morePrice', liquidity: 'moreLiquidity', source: 'moreSource' },
} as const

function pickSide(points: HistoryPoint[], key: 'FUEL' | 'MORE'): { pricePoint: HistoryPoint | null; liquidityPoint: HistoryPoint | null } {
  const fields = SIDE_FIELDS[key]
  let pricePoint: HistoryPoint | null = null
  let liquidityPoint: HistoryPoint | null = null
  // Newest first: each field takes its newest non-null value independently.
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    if (!pricePoint && point[fields.price] != null) pricePoint = point
    if (!liquidityPoint && point[fields.liquidity] != null) liquidityPoint = point
    if (pricePoint && liquidityPoint) break
  }
  return { pricePoint, liquidityPoint }
}

/**
 * Derive the freshest per-side quotes from the worker-owned series. Callers
 * should pass only server-collected (remote) points — never the merged
 * series, whose browser-recorded points track the external dashboard
 * pipeline the cards are being moved away from.
 */
export function latestQuotes(remote: HistoryPoint[]): Record<'FUEL' | 'MORE', SideQuote> {
  const side = (key: 'FUEL' | 'MORE'): SideQuote => {
    const fields = SIDE_FIELDS[key]
    const { pricePoint, liquidityPoint } = pickSide(remote, key)
    const price = pricePoint?.[fields.price] ?? null
    let change24h: number | null = null
    if (pricePoint && price != null && price > 0) {
      const target = pricePoint.at - 24 * 60 * 60 * 1000
      let reference: HistoryPoint | null = null
      for (let i = remote.length - 1; i >= 0; i--) {
        const candidate = remote[i]
        if (candidate.at <= target && candidate[fields.price] != null) { reference = candidate; break }
      }
      const referencePrice = reference?.[fields.price] ?? null
      if (referencePrice != null && referencePrice > 0) change24h = ((price - referencePrice) / referencePrice) * 100
    }
    return {
      priceUsd: price,
      liquidityUsd: liquidityPoint?.[fields.liquidity] ?? null,
      change24h,
      observedAt: pricePoint?.at ?? null,
      source: pricePoint?.[fields.source] ?? null,
    }
  }
  return { FUEL: side('FUEL'), MORE: side('MORE') }
}
