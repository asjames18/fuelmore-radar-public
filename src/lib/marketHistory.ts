import type { HistoryPoint } from './types'

/** One server-collected market observation. `t` is unix seconds. */
export type MarketServerPoint = {
  t: number
  fuelPrice: number | null
  fuelLiquidity: number | null
  morePrice: number | null
  moreLiquidity: number | null
}

export type MarketCandle = {
  /** Bucket start as unix seconds (UTC). */
  time: number
  open: number
  high: number
  low: number
  close: number
}

export type CandleField = 'fuelPrice' | 'morePrice'

/** 90-day retention matches the Worker's market-history window. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

function isMarketNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isServerPoint(value: unknown): value is MarketServerPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return Number.isInteger(point.t) && (point.t as number) > 0
    && (point.fuelPrice === null || isMarketNumber(point.fuelPrice))
    && (point.fuelLiquidity === null || isMarketNumber(point.fuelLiquidity))
    && (point.morePrice === null || isMarketNumber(point.morePrice))
    && (point.moreLiquidity === null || isMarketNumber(point.moreLiquidity))
}

/** Normalize the Worker's `{ updatedAt, points }` payload into HistoryPoint (`at` in ms). */
export function normalizeServerHistory(payload: unknown): HistoryPoint[] {
  const raw = (payload as { points?: unknown } | null)?.points
  if (!Array.isArray(raw)) return []
  const now = Date.now()
  const byTime = new Map<number, HistoryPoint>()
  for (const entry of raw) {
    if (!isServerPoint(entry)) continue
    const at = entry.t * 1000
    if (at < now - MAX_AGE_MS || at > now) continue
    byTime.set(at, {
      at,
      fuelPrice: entry.fuelPrice,
      fuelLiquidity: entry.fuelLiquidity,
      morePrice: entry.morePrice,
      moreLiquidity: entry.moreLiquidity,
    })
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}

export async function fetchMarketHistory(signal?: AbortSignal): Promise<HistoryPoint[]> {
  const response = await fetch('/api/market-history', { signal })
  if (!response.ok) throw new Error(`Market history ${response.status}`)
  return normalizeServerHistory(await response.json())
}

/**
 * Merge server and browser-local histories. Server points win on timestamp
 * collisions; the result stays sorted for the comparison charts.
 */
export function mergeHistories(server: HistoryPoint[], local: HistoryPoint[]): HistoryPoint[] {
  const byTime = new Map<number, HistoryPoint>()
  for (const point of local) byTime.set(point.at, point)
  for (const point of server) byTime.set(point.at, point)
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}

/**
 * Aggregate price observations into OHLC candles. Each candle is built only
 * from this Radar's own snapshots (open = first, close = last observed price
 * in the bucket), never synthesized exchange candles.
 */
export function toCandles(history: HistoryPoint[], field: CandleField, bucketMs: number): MarketCandle[] {
  const buckets = new Map<number, { open: number; high: number; low: number; close: number }>()
  const ordered = [...history].sort((a, b) => a.at - b.at)
  for (const point of ordered) {
    const price = point[field]
    if (price === null || price <= 0) continue
    const bucket = Math.floor(point.at / bucketMs) * bucketMs
    const candle = buckets.get(bucket)
    if (!candle) {
      buckets.set(bucket, { open: price, high: price, low: price, close: price })
    } else {
      candle.high = Math.max(candle.high, price)
      candle.low = Math.min(candle.low, price)
      candle.close = price
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, candle]) => ({ time: Math.floor(bucket / 1000), ...candle }))
}

export const CANDLE_BUCKETS = {
  '1H': 3_600_000,
  '1D': 86_400_000,
} as const
export type CandleBucket = keyof typeof CANDLE_BUCKETS
