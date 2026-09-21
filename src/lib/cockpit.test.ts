import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn(), multicall: vi.fn() }))
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }))
import type { Address } from 'viem'
import { fetchCockpitSnapshot, estimateSlotRewards, fetchCockpitSnapshotSmart, type CockpitSnapshot } from './cockpit'
const address = '0x0000000000000000000000000000000000000001'
const proxyA = '0x00000000000000000000000000000000000000a1' as Address
const proxyB = '0x00000000000000000000000000000000000000a2' as Address
const mintTuple = (maturity: bigint) => ['0x00000000000000000000000000000000000000b1', 30n, maturity, 7n, 2n, 100n]
const ok = (result: unknown) => ({ status: 'success', result })
const fail = () => ({ status: 'failure', error: new Error('reverted') })

/** Cheap-call defaults: no direct mint/stake, `count` proxies, rank 50. */
function mockCheap(count: bigint) {
  rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'userMints') return ['0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0n, 0n]
    if (functionName === 'userStakes') return [0n, 0n, 0n, 0n]
    if (functionName === 'proxiesOf') return count
    if (functionName === 'globalRank') return 50n
    return 0n
  })
}

/** Route multicall batches by the first contract's function name. */
function mockMulticall(handlers: Record<string, (calls: Array<{ args: readonly unknown[] }>) => unknown[]>) {
  rpc.multicall.mockImplementation(async ({ contracts }: { contracts: Array<{ functionName: string; args: readonly unknown[] }> }) => {
    const handler = handlers[contracts[0].functionName]
    if (!handler) throw new Error(`unexpected multicall fn ${contracts[0].functionName}`)
    return handler(contracts)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  rpc.getChainId.mockResolvedValue(4663)
  rpc.getBlock.mockResolvedValue({ number: 100n, hash: '0xabc', timestamp: 1000n })
  mockCheap(0n)
  rpc.multicall.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})
it('marks failed mint/count reads incomplete, never a confirmed empty inventory', async () => {
  rpc.readContract.mockRejectedValue(new Error('offline'))
  expect((await fetchCockpitSnapshot(address)).sampleIncomplete).toBe(true)
})
it('cancels before any RPC when the lookup was superseded', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(fetchCockpitSnapshot(address, undefined, { signal: controller.signal })).rejects.toThrow()
  expect(rpc.getChainId).not.toHaveBeenCalled()
})
it('rechecks chain identity at the end of a snapshot', async () => {
  rpc.getChainId.mockResolvedValueOnce(4663).mockResolvedValue(1)
  await expect(fetchCockpitSnapshot(address)).rejects.toThrow('Unexpected network')
})
it('rejects reward estimates against a different block hash', async () => {
  await expect(estimateSlotRewards({ slots: [], globalRank: 1n, nowTs: 1000, blockNumber: 100n, blockHash: '0xchanged' })).rejects.toThrow('Snapshot changed')
})
it('batches the mint inventory through multicall with the same slots as per-call reads', async () => {
  mockCheap(2n)
  mockMulticall({
    proxyAddress: calls => calls.map(c => ok(c.args[1] === 0n ? proxyA : proxyB)),
    userMints: () => [ok(mintTuple(2000n)), ok(mintTuple(3000n))],
  })
  const snapshot = await fetchCockpitSnapshot(address)
  expect(rpc.multicall).toHaveBeenCalledTimes(2)
  expect(snapshot.batchTotal).toBe(2)
  expect(snapshot.activeMints).toBe(2)
  expect(snapshot.sampleIncomplete).toBe(false)
  expect(snapshot.slots.map(s => s.id)).toEqual(['batch:0', 'batch:1'])
  expect(snapshot.slots[0].proxy).toBe(proxyA)
  expect(snapshot.slots[0].maturityTs).toBe(2000n)
  expect(snapshot.slotsPinnedBlockNumber).toBe(100n)
  expect(snapshot.slotsPinnedBlockHash).toBe('0xabc')
})
it('marks a failed proxy subcall unknown without zeroing the rest', async () => {
  mockCheap(2n)
  mockMulticall({
    proxyAddress: calls => calls.map(c => (c.args[1] === 0n ? fail() : ok(proxyB))),
    userMints: () => [ok(mintTuple(2000n))],
  })
  const snapshot = await fetchCockpitSnapshot(address)
  expect(snapshot.sampleIncomplete).toBe(true)
  expect(snapshot.slots.map(s => s.id)).toEqual(['batch:1'])
  expect(snapshot.slots[0].proxy).toBe(proxyB)
})
it('marks a failed mint subcall unknown without zeroing the rest', async () => {
  mockCheap(2n)
  mockMulticall({
    proxyAddress: calls => calls.map(c => ok(c.args[1] === 0n ? proxyA : proxyB)),
    userMints: calls => calls.map(c => (c.args[0] === proxyA ? fail() : ok(mintTuple(3000n)))),
  })
  const snapshot = await fetchCockpitSnapshot(address)
  expect(snapshot.sampleIncomplete).toBe(true)
  expect(snapshot.slots.map(s => s.id)).toEqual(['batch:1'])
})
it('treats an unreadable proxy count as incomplete, never an empty inventory', async () => {
  rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'proxiesOf') throw new Error('offline')
    if (functionName === 'userStakes') return [0n, 0n, 0n, 0n]
    if (functionName === 'userMints') return ['0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0n, 0n]
    return 0n
  })
  const snapshot = await fetchCockpitSnapshot(address)
  expect(snapshot.batchTotal).toBeNull()
  expect(snapshot.sampleIncomplete).toBe(true)
  expect(rpc.multicall).not.toHaveBeenCalled()
})
it('skips the mint rescan on refresh when the proxy count is unchanged', async () => {
  mockCheap(2n)
  mockMulticall({
    proxyAddress: calls => calls.map(c => ok(c.args[1] === 0n ? proxyA : proxyB)),
    userMints: () => [ok(mintTuple(2000n)), ok(mintTuple(3000n))],
  })
  const first = await fetchCockpitSnapshot(address)
  expect(rpc.multicall).toHaveBeenCalledTimes(2)
  rpc.multicall.mockClear()
  rpc.getBlock.mockResolvedValue({ number: 101n, hash: '0xdef', timestamp: 1100n })
  const second = await fetchCockpitSnapshot(address, undefined, { previous: first })
  expect(rpc.multicall).not.toHaveBeenCalled()
  expect(second.slots.map(s => s.id)).toEqual(['batch:0', 'batch:1'])
  // Slots stay pinned at the original block; cheap reads moved to the new one.
  expect(second.slotsPinnedBlockNumber).toBe(100n)
  expect(second.slotsPinnedBlockHash).toBe('0xabc')
  expect(second.blockNumber).toBe(101n)
})
it('rescans mint slots on refresh when the proxy count changed', async () => {
  mockCheap(1n)
  mockMulticall({
    proxyAddress: () => [ok(proxyA)],
    userMints: () => [ok(mintTuple(2000n))],
  })
  const first = await fetchCockpitSnapshot(address)
  rpc.multicall.mockClear()
  mockCheap(2n)
  mockMulticall({
    proxyAddress: calls => calls.map(c => ok(c.args[1] === 0n ? proxyA : proxyB)),
    userMints: () => [ok(mintTuple(2000n)), ok(mintTuple(3000n))],
  })
  const second = await fetchCockpitSnapshot(address, undefined, { previous: first })
  expect(rpc.multicall).toHaveBeenCalled()
  expect(second.batchTotal).toBe(2)
  expect(second.slotsPinnedBlockNumber).toBe(100n)
})
it('estimates rewards through multicall and flags failed slots incomplete', async () => {
  const slots = [
    { id: 'batch:0', source: 'batch' as const, index: 0, proxy: proxyA, term: 30n, maturityTs: 2000n, rank: 10n, amplifier: 2n, eaaRate: 100n },
    { id: 'batch:1', source: 'batch' as const, index: 1, proxy: proxyB, term: 30n, maturityTs: 3000n, rank: 60n, amplifier: 2n, eaaRate: 100n },
  ]
  rpc.multicall.mockResolvedValue([ok(5n), fail()])
  const estimate = await estimateSlotRewards({ slots, globalRank: 50n, nowTs: 1000, blockNumber: 100n, blockHash: '0xabc' })
  expect(rpc.multicall).toHaveBeenCalledTimes(1)
  expect(estimate.incomplete).toBe(true)
  expect(estimate.perSlot[0]).toMatchObject({ id: 'batch:0', grossWei: 5n * 10n ** 18n, netWei: 5n * 10n ** 18n, penaltyPct: 0 })
  expect(estimate.perSlot[1]).toMatchObject({ id: 'batch:1', grossWei: null, netWei: null })
  expect(estimate.grossWei).toBe(5n * 10n ** 18n)
})
it('serves the server snapshot first and revives bigint tags', async () => {
  const serverJson = JSON.stringify({
    address, blockNumber: { $bigint: '100' }, blockHash: '0xabc', observedAt: 1000,
    fuelBalance: { $bigint: '42' }, globalRank: null, directMint: null, directStake: null,
    batchTotal: 1, activeMints: 1, dueOrLate: 0, upcoming7d: 1, upcoming30d: 0, later: 0,
    nextMaturityTs: 2000, maxLatePenaltyPct: 0, sampleIncomplete: false, buckets: [],
    slots: [{ id: 'batch:0', source: 'batch', index: 0, proxy: proxyA, term: { $bigint: '30' }, maturityTs: { $bigint: '2000' }, rank: { $bigint: '7' }, amplifier: { $bigint: '2' }, eaaRate: { $bigint: '100' } }],
    slotsPinnedBlockNumber: { $bigint: '100' }, slotsPinnedBlockHash: '0xabc',
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(serverJson, { status: 200 })))
  const { snapshot, source } = await fetchCockpitSnapshotSmart(address)
  expect(source).toBe('server')
  expect(snapshot.blockNumber).toBe(100n)
  expect(snapshot.fuelBalance).toBe(42n)
  expect(snapshot.slots[0].term).toBe(30n)
  expect(rpc.getChainId).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
it('falls back to direct reads when the server endpoint fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  mockCheap(1n)
  mockMulticall({
    proxyAddress: () => [ok(proxyA)],
    userMints: () => [ok(mintTuple(2000n))],
  })
  const { snapshot, source } = await fetchCockpitSnapshotSmart(address)
  expect(source).toBe('direct')
  expect(snapshot.slots.map(s => s.id)).toEqual(['batch:0'])
  vi.unstubAllGlobals()
})
it('falls back to direct reads when the server shape is unexpected', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ address: '0xwrong' }), { status: 200 })))
  mockCheap(0n)
  const { snapshot, source } = await fetchCockpitSnapshotSmart(address)
  expect(source).toBe('direct')
  expect(snapshot.address).toBe(address)
  vi.unstubAllGlobals()
})
it('keeps a previous server snapshot usable for incremental refresh', async () => {
  mockCheap(2n)
  const previous = {
    address, blockNumber: 100n, blockHash: '0xabc', observedAt: 1000,
    fuelBalance: null, globalRank: 50n, directMint: null, directStake: null,
    batchTotal: 2, activeMints: 2, dueOrLate: 0, upcoming7d: 2, upcoming30d: 0, later: 0,
    nextMaturityTs: 2000, maxLatePenaltyPct: 0, sampleIncomplete: false, buckets: [],
    slots: [
      { id: 'batch:0', source: 'batch' as const, index: 0, proxy: proxyA, term: 30n, maturityTs: 2000n, rank: 7n, amplifier: 2n, eaaRate: 100n },
      { id: 'batch:1', source: 'batch' as const, index: 1, proxy: proxyB, term: 30n, maturityTs: 3000n, rank: 7n, amplifier: 2n, eaaRate: 100n },
    ],
    slotsPinnedBlockNumber: 100n, slotsPinnedBlockHash: '0xabc',
  } satisfies CockpitSnapshot
  const snapshot = await fetchCockpitSnapshot(address, undefined, { previous })
  expect(rpc.multicall).not.toHaveBeenCalled()
  expect(snapshot.slots).toHaveLength(2)
})
