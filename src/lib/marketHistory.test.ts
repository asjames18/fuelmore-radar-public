import { describe, expect, it } from 'vitest'
import { mergeHistories, normalizeServerHistory, toCandles } from './marketHistory'
import type { HistoryPoint } from './types'

const HOUR = 3_600_000
const DAY = 86_400_000
// Fixed base: 2026-01-01T00:00:00Z
const BASE = Date.UTC(2026, 0, 1)

function point(at: number, fuelPrice: number | null, morePrice: number | null = null): HistoryPoint {
  return { at, fuelPrice, morePrice, fuelLiquidity: null, moreLiquidity: null }
}

describe('toCandles', () => {
  it('builds OHLC candles per bucket from our own snapshots', () => {
    const history = [
      point(BASE + 5 * 60_000, 1.0),
      point(BASE + 10 * 60_000, 1.5),
      point(BASE + 20 * 60_000, 0.8),
      point(BASE + 50 * 60_000, 1.2),
      point(BASE + HOUR + 5 * 60_000, 2.0),
    ]
    const candles = toCandles(history, 'fuelPrice', HOUR)
    expect(candles).toHaveLength(2)
    expect(candles[0]).toEqual({ time: BASE / 1000, open: 1.0, high: 1.5, low: 0.8, close: 1.2 })
    expect(candles[1]).toEqual({ time: (BASE + HOUR) / 1000, open: 2.0, high: 2.0, low: 2.0, close: 2.0 })
  })

  it('skips null and non-positive prices without inventing candles', () => {
    const history = [point(BASE, null), point(BASE + 60_000, 0), point(BASE + 120_000, -1)]
    expect(toCandles(history, 'fuelPrice', HOUR)).toEqual([])
    expect(toCandles([], 'fuelPrice', HOUR)).toEqual([])
  })

  it('aggregates daily buckets across many points', () => {
    const history = [point(BASE, 1), point(BASE + 12 * HOUR, 3), point(BASE + 25 * HOUR, 2)]
    const candles = toCandles(history, 'fuelPrice', DAY)
    expect(candles).toHaveLength(2)
    expect(candles[0].high).toBe(3)
    expect(candles[0].close).toBe(3)
    expect(candles[1].open).toBe(2)
  })

  it('sorts out-of-order input before assigning open and close', () => {
    const history = [point(BASE + 30 * 60_000, 1.2), point(BASE + 5 * 60_000, 1.0)]
    const [candle] = toCandles(history, 'fuelPrice', HOUR)
    expect(candle.open).toBe(1.0)
    expect(candle.close).toBe(1.2)
  })

  it('selects the requested token field', () => {
    const history = [point(BASE, 1.0, 5.0), point(BASE + 10 * 60_000, 2.0, 6.0)]
    const [fuel] = toCandles(history, 'fuelPrice', HOUR)
    const [more] = toCandles(history, 'morePrice', HOUR)
    expect(fuel.close).toBe(2.0)
    expect(more.close).toBe(6.0)
  })
})

describe('normalizeServerHistory', () => {
  it('converts unix-second server points to millisecond HistoryPoints', () => {
    const t = Math.floor(Date.now() / 1000) - 3600
    const payload = {
      updatedAt: new Date().toISOString(),
      points: [{ t, fuelPrice: 0.01, fuelLiquidity: 100, morePrice: 0.00002, moreLiquidity: 50 }],
    }
    const [entry] = normalizeServerHistory(payload)
    expect(entry.at).toBe(t * 1000)
    expect(entry.fuelPrice).toBe(0.01)
    expect(entry.fuelLiquidity).toBe(100)
    expect(entry.morePrice).toBe(0.00002)
    expect(entry.moreLiquidity).toBe(50)
  })

  it('drops invalid, future, and stale points', () => {
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      points: [
        { t: now - 100 * 24 * 3600, fuelPrice: 1, fuelLiquidity: 1, morePrice: 1, moreLiquidity: 1 },
        { t: now + 3600, fuelPrice: 1, fuelLiquidity: 1, morePrice: 1, moreLiquidity: 1 },
        { t: 'bad', fuelPrice: 1, fuelLiquidity: 1, morePrice: 1, moreLiquidity: 1 },
        { t: now - 60, fuelPrice: -1, fuelLiquidity: 1, morePrice: 1, moreLiquidity: 1 },
      ],
    }
    expect(normalizeServerHistory(payload)).toEqual([])
    expect(normalizeServerHistory({})).toEqual([])
    expect(normalizeServerHistory(null)).toEqual([])
    expect(normalizeServerHistory({ points: 'nope' })).toEqual([])
  })

  it('dedupes repeated timestamps', () => {
    const t = Math.floor(Date.now() / 1000) - 60
    const payload = {
      points: [
        { t, fuelPrice: 1, fuelLiquidity: 1, morePrice: 1, moreLiquidity: 1 },
        { t, fuelPrice: 2, fuelLiquidity: 2, morePrice: 2, moreLiquidity: 2 },
      ],
    }
    expect(normalizeServerHistory(payload)).toHaveLength(1)
  })
})

describe('mergeHistories', () => {
  it('prefers server points on collisions and keeps sort order', () => {
    const local = [point(1000, 1), point(2000, 2)]
    const server = [point(2000, 20), point(3000, 30)]
    const merged = mergeHistories(server, local)
    expect(merged.map((entry) => entry.at)).toEqual([1000, 2000, 3000])
    expect(merged[1].fuelPrice).toBe(20)
  })

  it('handles empty inputs', () => {
    expect(mergeHistories([], [])).toEqual([])
    const local = [point(1000, 1)]
    expect(mergeHistories([], local)).toEqual(local)
  })
})
