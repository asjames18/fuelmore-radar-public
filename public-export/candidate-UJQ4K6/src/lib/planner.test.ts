import { beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), getGasPrice: vi.fn(), readContract: vi.fn() }))
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }))
import { fetchPlannerQuote, parseBatchSize, parseStakeAmount, plannedDate } from './planner'

beforeEach(() => {
  vi.resetAllMocks()
  rpc.getChainId.mockResolvedValue(4663)
  rpc.getBlock.mockResolvedValue({ number: 100n, hash: '0xabc', timestamp: 1789515452n })
  rpc.getGasPrice.mockResolvedValue(1000000000n)
  rpc.readContract.mockImplementation(async ({ functionName }) => functionName === 'batchClaimFee' ? 3n : 12n)
})
it('rejects fractional, zero, oversized and exponent batch inputs', () => {
  for (const input of ['0', '51', '1.5', '1e1', '', '-1']) expect(() => parseBatchSize(input)).toThrow()
  expect(parseBatchSize('25')).toBe(25)
})
it('preserves exact stake decimals and rejects rounding or nonpositive input', () => {
  expect(parseStakeAmount('1.000000000000000001')).toBe(1000000000000000001n)
  for (const input of ['0', '-1', '1e18', '1.0000000000000000001']) expect(() => parseStakeAmount(input)).toThrow()
})
it('calculates a UTC duration from the snapshot and rejects invalid dates', () => {
  expect(plannedDate(1789515452, '7')).toBe('2026-09-22T23:37:32.000Z')
  expect(plannedDate(1789515452, '1.5')).toBeNull()
})
it('pins reads and uses batch claim getter for comparisons', async () => {
  const quote = await fetchPlannerQuote(7)
  expect(quote.rows.map(row => row.count)).toEqual([1, 7, 10, 25, 50])
  expect(quote.rows[1]).toEqual({ count: 7, mintFee: 12n, claimFee: 3n })
  for (const [args] of rpc.readContract.mock.calls) expect(args.blockNumber).toBe(100n)
  expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'batchClaimFee', args: [7n, 1000000000n] }))
})
it('retains individual failed fees as unavailable instead of zero', async () => {
  rpc.readContract.mockImplementation(async ({ functionName }) => { if (functionName === 'batchClaimFee') throw Error('offline'); return 12n })
  const quote = await fetchPlannerQuote(10)
  expect(quote.rows.every(row => row.claimFee === null && row.mintFee === 12n)).toBe(true)
})
it('rejects the wrong network before reading contracts', async () => {
  rpc.getChainId.mockResolvedValue(1)
  await expect(fetchPlannerQuote(10)).rejects.toThrow('network')
  expect(rpc.readContract).not.toHaveBeenCalled()
})
it('withholds quotes if the pinned block changes', async () => {
  rpc.getBlock.mockResolvedValueOnce({ number: 100n, hash: '0xabc', timestamp: 1789515452n }).mockResolvedValueOnce({ hash: '0xdef' })
  await expect(fetchPlannerQuote(10)).rejects.toThrow('changed')
})
