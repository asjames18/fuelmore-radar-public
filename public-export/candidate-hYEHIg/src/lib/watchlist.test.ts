import { afterEach, expect, it, vi } from 'vitest'
import { normalizeWatchlist, readWatchlist, saveWatchlist } from './watchlist'
const address = '0x0000000000000000000000000000000000000001'
afterEach(() => vi.unstubAllGlobals())
it('validates and deduplicates saved addresses', () => {
  expect(normalizeWatchlist([address, address, 'bad', null])).toEqual([address])
  expect(normalizeWatchlist({})).toEqual([])
})
it('reports blocked persistence without crashing the watchlist', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
  expect(readWatchlist()).toEqual([])
  expect(saveWatchlist([address])).toBe(false)
})
it('loads a saved list and tolerates corrupt JSON', () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([address]) })
  expect(readWatchlist()).toEqual([address])
  vi.stubGlobal('localStorage', { getItem: () => '{' })
  expect(readWatchlist()).toEqual([])
})
it('public edition neither reads nor overwrites personal saved wallets', () => {
  vi.stubEnv('MODE', 'public')
  const values = new Map([['fuelmore-radar:watchlist:v1', JSON.stringify([address])]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  try {
    expect(readWatchlist()).toEqual([])
    expect(saveWatchlist([])).toBe(true)
    expect(values.get('fuelmore-radar:watchlist:v1')).toBe(JSON.stringify([address]))
    expect(values.get('fuelmore-radar:public:watchlist:v1')).toBe('[]')
  } finally { vi.unstubAllEnvs() }
})
