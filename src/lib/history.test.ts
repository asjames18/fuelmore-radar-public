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

describe('remote market history', () => {
  const remote = (t: number, extra: Record<string, unknown> = {}) => ({
    t,
    fuelPrice: 0.004, morePrice: 0.00003, fuelLiquidity: 1200, moreLiquidity: 900,
    fuelSource: 'dexscreener', moreSource: 'geckoterminal',
    fuelObservedAt: t - 60, moreObservedAt: null,
    ...extra,
  })

  it('normalizes server v2 points to ms timestamps with attribution', async () => {
    const { normalizeRemotePoint } = await import('./history')
    const p = normalizeRemotePoint(remote(1_700_000_000))
    expect(p).toMatchObject({
      at: 1_700_000_000_000,
      fuelPrice: 0.004,
      fuelSource: 'dexscreener',
      moreSource: 'geckoterminal',
      fuelObservedAt: 1_699_999_940_000,
    })
    expect(p!.moreObservedAt).toBeUndefined()
  })

  it('rejects malformed server points', async () => {
    const { normalizeRemotePoint } = await import('./history')
    expect(normalizeRemotePoint(null)).toBeNull()
    expect(normalizeRemotePoint({ t: 'soon' })).toBeNull()
    expect(normalizeRemotePoint(remote(1_700_000_000, { fuelPrice: -1 }))).toBeNull()
    expect(normalizeRemotePoint(remote(1_700_000_000, { fuelSource: 42 }))).toBeNull()
  })

  it('fetches and normalizes the server series, degrading to [] on failure', async () => {
    const { fetchRemoteHistory } = await import('./history')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ points: [remote(Math.floor(now / 1000) - 900), { t: 'bad' }] })))
    const points = await fetchRemoteHistory()
    expect(points).toHaveLength(1)
    expect(points[0].at).toBe((Math.floor(now / 1000) - 900) * 1000)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await fetchRemoteHistory()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    expect(await fetchRemoteHistory()).toEqual([])
  })

  it('merges remote under local: remote wins timestamp collisions, result is sorted and persisted', async () => {
    const { mergeHistory } = await import('./history')
    const local = [point(now - 60_000), { ...point(now - 120_000), fuelSource: 'stale-local' }]
    const remotePt = { at: now - 120_000, fuelPrice: 9, morePrice: null, fuelLiquidity: 100, moreLiquidity: null, fuelSource: 'dexpaprika' }
    const merged = mergeHistory([remotePt], local)
    expect(merged.map(p => p.at)).toEqual([now - 120_000, now - 60_000])
    expect(merged[0].fuelSource).toBe('dexpaprika')
    expect(vi.mocked(localStorage.setItem)).toHaveBeenCalled()
  })
})
