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

  it('ignores the pre-v2 local series that may hold the poisoned quote', async () => {
    // Data written under the old key is never read back; only the v2 key is used.
    const calls: string[] = []
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => {
      calls.push(k)
      return k.includes('history-v2') ? null : JSON.stringify([point(now)])
    })
    const { readHistory } = await import('./history')
    expect(readHistory()).toEqual([])
    expect(calls.some((k) => k.includes('history-v2'))).toBe(true)
    expect(calls.some((k) => !k.includes('history-v2') && k.includes('history'))).toBe(false)
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

describe('latestQuotes', () => {
  const day = 24 * 60 * 60 * 1000
  const pt = (at: number, over: Partial<Record<string, number | string | null>>) => ({ at, fuelPrice: null, morePrice: null, fuelLiquidity: null, moreLiquidity: null, ...over })

  it('takes each field from its newest non-null point per side', async () => {
    const { latestQuotes } = await import('./history')
    const remote = [
      pt(now - day, { fuelPrice: 4, fuelLiquidity: 40, fuelSource: 'dexscreener' }),
      pt(now - 900_000, { fuelPrice: null, fuelLiquidity: 55 }),
      pt(now, { fuelPrice: 5, fuelLiquidity: null }),
    ]
    const quotes = latestQuotes(remote)
    expect(quotes.FUEL.priceUsd).toBe(5)
    expect(quotes.FUEL.liquidityUsd).toBe(55)
    expect(quotes.FUEL.observedAt).toBe(now)
    expect(quotes.MORE.priceUsd).toBeNull()
  })

  it('computes 24h change against the newest point at or before 24h earlier', async () => {
    const { latestQuotes } = await import('./history')
    const remote = [
      pt(now - day - 60_000, { fuelPrice: 4 }),
      pt(now - day + 60_000, { fuelPrice: 100 }),
      pt(now, { fuelPrice: 5 }),
    ]
    const { change24h } = latestQuotes(remote).FUEL
    expect(change24h).toBeCloseTo(((5 - 4) / 4) * 100, 10)
  })

  it('keeps change24h null when the series cannot support the comparison', async () => {
    const { latestQuotes } = await import('./history')
    const remote = [pt(now - 3_600_000, { fuelPrice: 4 }), pt(now, { fuelPrice: 5 })]
    expect(latestQuotes(remote).FUEL.change24h).toBeNull()
    expect(latestQuotes([]).FUEL.priceUsd).toBeNull()
    expect(latestQuotes([]).MORE.priceUsd).toBeNull()
  })

  it('keeps sides independent and carries attribution', async () => {
    const { latestQuotes } = await import('./history')
    const remote = [
      pt(now - day, { morePrice: 2, moreSource: 'geckoterminal' }),
      pt(now, { fuelPrice: 5, fuelSource: 'dexscreener' }),
    ]
    const quotes = latestQuotes(remote)
    expect(quotes.FUEL.priceUsd).toBe(5)
    expect(quotes.FUEL.source).toBe('dexscreener')
    expect(quotes.MORE.priceUsd).toBe(2)
    expect(quotes.MORE.source).toBe('geckoterminal')
    expect(quotes.MORE.observedAt).toBe(now - day)
  })
})
