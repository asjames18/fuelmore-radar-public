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
