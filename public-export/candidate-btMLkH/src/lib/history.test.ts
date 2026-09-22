import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairSnapshot } from './types'

const now = 1_800_000_000_000
const point = (at: number) => ({ at, fuelPrice: 1, morePrice: null, fuelLiquidity: 100, moreLiquidity: null })
const pair = { symbol: 'FUEL', priceUsd: 1, liquidityUsd: 100 } as PairSnapshot

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('local market history', () => {
  it('retains observations in memory when storage reads and writes fail', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('blocked') })
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('quota') })
    const { recordHistory, readHistory } = await import('./history')
    expect(recordHistory([pair])).toEqual([point(now)])
    vi.advanceTimersByTime(30_000)
    expect(recordHistory([pair])).toEqual([point(now), point(now + 30_000)])
    expect(readHistory()).toHaveLength(2)
  })

  it('rejects malformed entries, expired dates, and future observations', async () => {
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify([
      null, {}, { ...point(now), fuelPrice: '1' }, { ...point(now), fuelLiquidity: -1 },
      point(now - 31 * 86400_000), point(now + 30_000), point(now),
    ]))
    const { readHistory } = await import('./history')
    expect(readHistory()).toEqual([point(now)])
  })

  it('handles corrupt JSON and non-array storage', async () => {
    const { readHistory } = await import('./history')
    for (const value of ['{', 'null', '{}', '123']) {
      vi.mocked(localStorage.getItem).mockReturnValue(value)
      expect(readHistory()).toEqual([])
    }
  })

  it('sorts, deduplicates, and bounds saved history', async () => {
    const points = Array.from({ length: 725 }, (_, index) => point(now - index * 30_000))
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify([...points, points[0]]))
    const { readHistory } = await import('./history')
    const result = readHistory()
    expect(result).toHaveLength(720)
    expect(result[0].at).toBe(now - 719 * 30_000)
    expect(result.at(-1)?.at).toBe(now)
  })

  it('throttles rapid refreshes and skips missing markets', async () => {
    const { recordHistory } = await import('./history')
    expect(recordHistory([])).toEqual([])
    recordHistory([pair])
    vi.advanceTimersByTime(10_000)
    expect(recordHistory([pair])).toHaveLength(1)
    expect(localStorage.setItem).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(20_000)
    expect(recordHistory([pair])).toHaveLength(2)
  })
})
