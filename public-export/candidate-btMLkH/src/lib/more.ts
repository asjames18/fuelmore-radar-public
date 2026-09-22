import { createPublicClient, getAddress, http, parseAbi } from 'viem'
import { CONTRACTS, RPC_URL, robinhood } from './contracts'

// Robinhood mapping and ABI from app.moretokens.com, inspected 2026-09-15.
export const MORE_STAKING = '0xCC22e7f65bEF29aa21f6F59b9363fdc26005dE31'
const abi = parseAbi([
  'function getStakerID(address) view returns (uint256[])',
  'function getStakeInfo(uint256) view returns ((address staker,uint256 amount,uint256 startTime,uint256 endTime,uint256 claimTime,uint256 duration,uint256 rewardPerToken,uint256 claimed,uint256 penalty,bool status))',
])
const tokenAbi = parseAbi(['function decimals() view returns(uint8)'])
const client = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { timeout: 12_000, retryCount: 2, retryDelay: 500 }) })
export type MoreStake = { id: bigint; amount: bigint; startTime: bigint; endTime: bigint; claimTime: bigint; active: boolean }
export type MorePage = { address: string; blockNumber: bigint; blockHash: string; decimals: number; total: number; nextOffset: number | null; items: Array<{ id: bigint; stake: MoreStake | null }> }
export async function fetchMoreStakes(input: string, offset = 0, snapshot?: { blockNumber: bigint; blockHash: string }): Promise<MorePage> {
  const address = getAddress(input)
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid page offset')
  if (await client.getChainId() !== robinhood.id) throw Error('Unexpected network')
  const block = await client.getBlock(snapshot ? { blockNumber: snapshot.blockNumber } : {})
  if (block.number === null || !block.hash || (snapshot && snapshot.blockHash !== block.hash)) throw Error('Snapshot changed; refresh lookup')
  const blockNumber = block.number
  const [ids, decimals] = await Promise.all([
    client.readContract({ address: MORE_STAKING, abi, functionName: 'getStakerID', args: [address], blockNumber }),
    client.readContract({ address: CONTRACTS[1].address, abi: tokenAbi, functionName: 'decimals', blockNumber }),
  ])
  if (new Set(ids.map(String)).size !== ids.length || offset > ids.length) throw Error('Inconsistent stake inventory')
  const items: MorePage['items'] = []
  for (let start = offset; start < Math.min(ids.length, offset + 25); start += 5) {
    items.push(...await Promise.all(ids.slice(start, Math.min(start + 5, offset + 25)).map(async id => {
      try {
        const raw = await client.readContract({ address: MORE_STAKING, abi, functionName: 'getStakeInfo', args: [id], blockNumber })
        if (raw.staker.toLowerCase() !== address.toLowerCase()) throw Error('Stake owner mismatch')
        return { id, stake: { id, amount: raw.amount, startTime: raw.startTime, endTime: raw.endTime, claimTime: raw.claimTime, active: raw.status } }
      } catch { return { id, stake: null } }
    })))
  }
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error('Snapshot changed; refresh lookup')
  return { address, blockNumber, blockHash: block.hash, decimals, total: ids.length, nextOffset: offset + items.length < ids.length ? offset + items.length : null, items }
}
