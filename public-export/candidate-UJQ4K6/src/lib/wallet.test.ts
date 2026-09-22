import { beforeEach, describe, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn() }))
vi.mock('viem', async importOriginal => ({ ...await importOriginal<typeof import('viem')>(), createPublicClient: () => rpc }))
import { fetchWalletPosition } from './wallet'
const address = '0x0000000000000000000000000000000000000001'
const emptyMint = ['0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0n, 0n]
beforeEach(() => {
  vi.clearAllMocks()
  rpc.getChainId.mockResolvedValue(4663)
  rpc.getBlock.mockResolvedValue({ number: 100n, hash: '0xabc' })
  rpc.readContract.mockImplementation(async ({ functionName, args }) => {
    if (functionName === 'balanceOf') return 0n
    if (functionName === 'proxiesOf') return 27n
    if (functionName === 'proxyAddress') return `0x${(Number(args[1]) + 10).toString(16).padStart(40, '0')}`
    if (functionName === 'userMints') return emptyMint
    return [0n, 0n, 0n, 0n]
  })
})
describe('wallet coverage', () => {
  it('paginates proxy slots with explicit remaining coverage at a fixed block', async () => {
    const page = await fetchWalletPosition(address)
    expect(page.batch.items).toHaveLength(25)
    expect(page.batch.total).toBe(27)
    expect(page.batch.nextOffset).toBe(25)
    expect(page.blockHash).toBe('0xabc')
    expect(page.reads).toEqual({ balance: true, mint: true, stake: true })
    const next = await fetchWalletPosition(address, 25, { blockNumber: page.blockNumber, blockHash: page.blockHash })
    expect(next.batch.items.map(item => item.index)).toEqual([25, 26])
    expect(next.batch.nextOffset).toBeNull()
    expect(rpc.getBlock.mock.calls.some(([call]) => call?.blockNumber === 100n)).toBe(true)
    expect(rpc.readContract.mock.calls.every(([call]) => call.blockNumber === 100n)).toBe(true)
  })
  it('distinguishes failed reads from confirmed zero balances and empty mints', async () => {
    rpc.readContract.mockRejectedValue(new Error('offline'))
    const page = await fetchWalletPosition(address)
    expect(page.reads).toEqual({ balance: false, mint: false, stake: false })
    expect(page.fuelBalance).toBeNull()
    expect(page.batch.total).toBeNull()
  })
  it('keeps an individual failed proxy read visible', async () => {
    const previous = rpc.readContract.getMockImplementation()!
    rpc.readContract.mockImplementation(async input => {
      if (input.functionName === 'proxyAddress' && input.args[1] === 2n) throw new Error('unavailable')
      return previous(input)
    })
    const page = await fetchWalletPosition(address)
    expect(page.batch.items[2].available).toBe(false)
    expect(page.batch.items[1].available).toBe(true)
  })
  it('rejects changed snapshots and wrong networks', async () => {
    await expect(fetchWalletPosition(address, 0, { blockNumber: 100n, blockHash: '0xold' })).rejects.toThrow('Snapshot changed')
    rpc.getChainId.mockResolvedValue(1)
    await expect(fetchWalletPosition(address)).rejects.toThrow('Unexpected network')
  })
})
