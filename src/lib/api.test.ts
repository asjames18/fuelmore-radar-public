import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({ readContract: vi.fn(), getBalance: vi.fn(), getChainId: vi.fn(), getBlock: vi.fn() }))
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }))
import { fetchRadarData } from './api'
import { CONTRACTS, PAIRS } from './contracts'
let brokenHolders = false
let transferItems: unknown[] = []
beforeEach(() => {
  brokenHolders = false
  transferItems = []
  rpc.readContract.mockResolvedValue(1n)
  rpc.getBalance.mockResolvedValue(1n)
  rpc.getChainId.mockResolvedValue(4663)
  rpc.getBlock.mockResolvedValue({ number: 100n, hash: '0x' + 'a'.repeat(64), timestamp: 1700000000n })
  vi.stubGlobal('window', { setTimeout: (callback: () => void) => setTimeout(callback, 0) })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (brokenHolders && url.includes('/holders')) return new Response('{}', { status: 400 })
    let payload: unknown = { items: [] }
    if (url.endsWith('/transfers')) payload = { items: transferItems }
    else if (url.includes('/latest/dex/')) {
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
it('refuses to use an explorer credential in a browser', async()=>{
 await expect(fetchRadarData(undefined,{blockscoutApiKey:'test-only-key'})).rejects.toThrow('backend-only')
})
it('uses the documented chain-specific explorer API on the backend without exposing the key in saved data',async()=>{
 vi.stubGlobal('window',undefined)
 vi.mocked(fetch).mockImplementation(async(input)=>{
  const url=String(input)
  if(url.includes('api.blockscout.com')) {
   expect(url).toContain('/4663/api/v2/')
   expect(new URL(url).searchParams.get('apikey')).toBe('test-only-key')
   if(url.includes('/smart-contracts/')) return Response.json({is_verified:true})
   if(url.includes('/holders?')) return Response.json({items:[]})
   if(url.includes('/transfers?')) return Response.json({items:[]})
   return Response.json({total_supply:'1000',holders_count:'0'})
  }
  return Response.json({pairs:[]})
 })
 const data=await fetchRadarData(undefined,{blockscoutApiKey:'test-only-key'})
 expect(data.holders.FUEL.totalHolders).toBe(0)
 expect(data.sources.find(s=>s.name==='FUEL holders')?.status).toBe('available')
 expect(JSON.stringify(data,(_,v)=>typeof v==='bigint'?v.toString():v)).not.toContain('test-only-key')
})
it('labels dead-address transfers Removed rather than Burn', async () => {
  const dead = '0x000000000000000000000000000000000000dEaD'
  const zero = '0x0000000000000000000000000000000000000000'
  const wallet = '0x1111111111111111111111111111111111111111'
  const item = (hash: string, from: string, to: string) => ({
    transaction_hash: hash,
    timestamp: '2026-09-24T11:52:00.000Z',
    token: { symbol: 'FUEL' },
    total: { value: '1000000000000000000', decimals: '18' },
    from: { hash: from },
    to: { hash: to },
  })
  transferItems = [item('0xdeadx', wallet, dead), item('0xburnx', wallet, zero)]
  const data = await fetchRadarData()
  const byHash = Object.fromEntries(data.activity.map((a: { hash: string; event: string }) => [a.hash, a.event]))
  // Dead-address sends are supply-neutral: 'Removed' matches the burns
  // methodology and the MORE removed language; only true supply burns to the
  // zero address read as 'Burn'.
  expect(byHash['0xdeadx']).toBe('Removed')
  expect(byHash['0xburnx']).toBe('Burn')
})
