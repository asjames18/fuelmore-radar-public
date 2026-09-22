import type { HistoryPoint, PairSnapshot } from './types'

import { storageKey } from './storage'
const key = () => storageKey('history')
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
