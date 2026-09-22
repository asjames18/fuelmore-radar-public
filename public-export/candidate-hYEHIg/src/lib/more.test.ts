import { beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn() }))
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }))
import { fetchMoreStakes } from './more'
const wallet = '0x8599A6cab9617FFb12E6f11aD119caeE7323a2c4'
let ids: bigint[]
beforeEach(() => {
  vi.resetAllMocks(); ids = [1n]
  rpc.getChainId.mockResolvedValue(4663)
  rpc.getBlock.mockResolvedValue({ number: 100n, hash: '0xabc' })
  rpc.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'decimals') return 18
    if (functionName === 'getStakerID') return ids
    return { staker: wallet, amount: 1000000000000000001n, startTime: 100n, endTime: 200n, claimTime: 0n, status: true }
  })
})
it('reads exact amounts and pins every contract read to the snapshot', async () => {
  const result = await fetchMoreStakes(wallet)
  expect(result.items[0].stake?.amount).toBe(1000000000000000001n)
  expect(result.items[0].stake?.active).toBe(true)
  for (const [call] of rpc.readContract.mock.calls) expect(call.blockNumber).toBe(100n)
})
it('paginates 25 records and preserves the snapshot on later pages', async () => {
  ids = Array.from({ length: 27 }, (_, i) => BigInt(i + 1))
  const first = await fetchMoreStakes(wallet)
  expect(first.items).toHaveLength(25)
  expect(first.nextOffset).toBe(25)
  const second = await fetchMoreStakes(wallet, 25, first)
  expect(second.items.map(item => item.id)).toEqual([26n, 27n])
  expect(second.nextOffset).toBeNull()
})
it('returns confirmed empty inventory only on a successful read', async () => {
  ids = []
  expect((await fetchMoreStakes(wallet)).total).toBe(0)
  rpc.readContract.mockRejectedValue(Error('offline'))
  await expect(fetchMoreStakes(wallet)).rejects.toThrow('offline')
})
it('withholds records belonging to another wallet', async () => {
  rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'decimals' ? 18 : functionName === 'getStakerID' ? [1n] : { staker: '0x0000000000000000000000000000000000000001' })
  expect((await fetchMoreStakes(wallet)).items[0].stake).toBeNull()
})
it('rejects changed snapshots and wrong networks', async () => {
  await expect(fetchMoreStakes(wallet, 0, { blockNumber: 100n, blockHash: '0xold' })).rejects.toThrow('Snapshot changed')
  rpc.getChainId.mockResolvedValue(1)
  await expect(fetchMoreStakes(wallet)).rejects.toThrow('Unexpected network')
})
it('rejects duplicate inventory rather than double counting', async () => {
  ids = [1n, 1n]
  await expect(fetchMoreStakes(wallet)).rejects.toThrow('Inconsistent')
})
