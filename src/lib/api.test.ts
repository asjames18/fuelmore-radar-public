import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({ readContract: vi.fn(), getBalance: vi.fn(), getChainId: vi.fn(), getBlock: vi.fn() }))
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }))
import { fetchRadarData } from './api'
import { CONTRACTS, PAIRS } from './contracts'
let brokenHolders = false
beforeEach(() => {
  brokenHolders = false
  rpc.readContract.mockResolvedValue(1n)
  rpc.getBalance.mockResolvedValue(1n)
  rpc.getChainId.mockResolvedValue(4663)
  rpc.getBlock.mockResolvedValue({ number: 100n, hash: '0x' + 'a'.repeat(64), timestamp: 1700000000n })
  vi.stubGlobal('window', { setTimeout: (callback: () => void) => setTimeout(callback, 0) })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (brokenHolders && url.includes('/holders')) return new Response('{}', { status: 400 })
    let payload: unknown = { items: [] }
    if (url.includes('/latest/dex/')) {
      const fuel = url.toLowerCase().endsWith(PAIRS.fuel.toLowerCase())
      payload = { pairs: [{ chainId: 'robinhood', pairAddress: fuel ? PAIRS.fuel : PAIRS.more, baseToken: { address: CONTRACTS[fuel ? 0 : 1].address, symbol: fuel ? 'FUEL' : 'MORE', name: 'Token' }, dexId: 'uniswap', priceUsd: '1' }] }
    } else if (url.includes('/smart-contracts/')) payload = { is_verified: true }
    else if (url.endsWith('/holders')) {
      payload = {
        items: [
          { value: '400', address: { hash: '0x1111111111111111111111111111111111111111', is_contract: true } },
          { value: '100', address: { hash: '0x2222222222222222222222222222222222222222', is_contract: false } },
        ],
      }
    }
    else if (!url.endsWith('/transfers')) payload = { total_supply: '1000', holders_count: '2' }
    return new Response(JSON.stringify(payload))
  }))
})
afterEach(() => vi.unstubAllGlobals())
it('holder failures set partial coverage and remain unknown rather than zero', async () => {
  brokenHolders = true
  const data = await fetchRadarData()
  expect(data.partial).toBe(true)
  expect(data.holders.FUEL.totalHolders).toBeNull()
  expect(data.holders.FUEL.topIsContract).toBeNull()
  expect(data.holders.FUEL.topHolders).toBeNull()
  expect(data.sources.find(source => source.name === 'FUEL holders')?.status).toBe('unavailable')
})
it('an individual failed protocol read marks RPC partial even when market requests succeed', async () => {
  rpc.readContract.mockImplementation(async ({ functionName }) => { if (functionName === 'activeMinters') throw new Error('offline'); return 1n })
  const data = await fetchRadarData()
  expect(data.protocol.activeMinters).toBeNull()
  expect(data.partial).toBe(true)
  expect(data.sources.find(source => source.name === 'Protocol RPC reads')?.status).toBe('partial')
  expect(data.holders.FUEL.totalHolders).toBe(2)
  expect(data.holders.FUEL.topHolders).toHaveLength(2)
  expect(data.holders.FUEL.topHolders?.[1]?.isContract).toBe(false)
  expect(rpc.readContract.mock.calls.every(([call]) => call.blockNumber === 100n)).toBe(true)
})
it('withholds protocol reads on the wrong network instead of mixing chains', async () => {
  rpc.getChainId.mockResolvedValue(1)
  const data = await fetchRadarData()
  expect(data.protocol.activeMinters).toBeNull()
  expect(data.protocol.totalSupply).toBeNull()
  expect(data.sources.find(source => source.name === 'Protocol RPC reads')?.status).toBe('unavailable')
  expect(rpc.readContract).not.toHaveBeenCalled()
})
