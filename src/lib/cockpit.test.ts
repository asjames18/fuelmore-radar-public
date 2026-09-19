import { beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => ({getChainId:vi.fn(),getBlock:vi.fn(),readContract:vi.fn()}))
vi.mock('viem',async original=>({...await original<typeof import('viem')>(),createPublicClient:()=>rpc}))
import { fetchCockpitSnapshot, estimateSlotRewards } from './cockpit'
const address='0x0000000000000000000000000000000000000001'
beforeEach(()=>{
 vi.clearAllMocks();rpc.getChainId.mockResolvedValue(4663);rpc.getBlock.mockResolvedValue({number:100n,hash:'0xabc',timestamp:1000n})
 rpc.readContract.mockImplementation(async ({functionName})=>{
  if (functionName==='userMints') return ['0x0000000000000000000000000000000000000000',0n,0n,0n,0n,0n]
  if (functionName==='userStakes') return [0n,0n,0n,0n]
  return 0n
 })
})
it('marks failed mint/count reads incomplete, never a confirmed empty inventory',async()=>{
 rpc.readContract.mockRejectedValue(new Error('offline'))
 expect((await fetchCockpitSnapshot(address)).sampleIncomplete).toBe(true)
})
it('cancels before any RPC when the lookup was superseded',async()=>{
 const controller=new AbortController();controller.abort()
 await expect(fetchCockpitSnapshot(address,undefined,{signal:controller.signal})).rejects.toThrow()
 expect(rpc.getChainId).not.toHaveBeenCalled()
})
it('rechecks chain identity at the end of a snapshot',async()=>{
 rpc.getChainId.mockResolvedValueOnce(4663).mockResolvedValue(1)
 await expect(fetchCockpitSnapshot(address)).rejects.toThrow('Unexpected network')
})
it('rejects reward estimates against a different block hash',async()=>{
 await expect(estimateSlotRewards({slots:[],globalRank:1n,nowTs:1000,blockNumber:100n,blockHash:'0xchanged'})).rejects.toThrow('Snapshot changed')
})
