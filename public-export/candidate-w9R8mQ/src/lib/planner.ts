import { createPublicClient, http, parseAbi, parseUnits, formatUnits } from 'viem'
import { CONTRACTS, RPC_URL, robinhood } from './contracts'

const client = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { timeout: 12_000, retryCount: 2, retryDelay: 500 }) })
// Signatures from the public FUEL application; outputs read from deployed contracts.
const tokenAbi = parseAbi([
  'function mintFee(uint256) view returns (uint256)',
  'function claimFee(uint256) view returns (uint256)',
  'function getCurrentMaxTerm() view returns (uint256)',
  'function getCurrentAPY() view returns (uint256)',
])
const batchAbi = parseAbi([
  'function batchFee(uint256,uint256) view returns (uint256)',
  'function batchClaimFee(uint256,uint256) view returns (uint256)',
])
export type FeeRow = { count: number; mintFee: bigint | null; claimFee: bigint | null }
export type PlannerQuote = {
  blockNumber: bigint; timestamp: number; fetchedAt: number; gasPrice: bigint;
  maxMintTermSeconds: bigint | null; currentApy: bigint | null;
  direct: { mintFee: bigint | null; claimFee: bigint | null }; rows: FeeRow[];
}
export function parseBatchSize(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) throw Error('Enter a whole batch size from 1 to 50.')
  return Number(value)
}
export function parseStakeAmount(value: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(value) || value.length > 90) throw Error('Enter a positive FUEL amount with up to 18 decimal places.')
  const amount = parseUnits(value, 18)
  if (amount <= 0n || amount >= 2n ** 256n) throw Error('Enter a positive FUEL amount within the token limit.')
  return amount
}
export function plannedDate(timestamp: number, days: string): string | null {
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 3650) return null
  const date = new Date((timestamp + Number(days) * 86400) * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const safe = async <T>(promise: Promise<T>): Promise<T | null> => { try { return await promise } catch { return null } }
/**
 * The current per-mint fee in ETH, read live from the FUEL token contract at
 * the current gas price. Used to convert the trailing
 * mint pace into daily ETH flowing to the burners. Returns nulls (never zero)
 * when any read fails.
 */
export async function fetchMintFee(): Promise<{ mintFeeEth: number | null; gasPrice: bigint | null }> {
  if (await client.getChainId() !== robinhood.id) throw Error('Unexpected RPC network; fee withheld.')
  const gasPrice = await safe(client.getGasPrice())
  if (gasPrice === null) return { mintFeeEth: null, gasPrice: null }
  const fee = await safe(client.readContract({ address: CONTRACTS[0].address, abi: tokenAbi, functionName: 'mintFee', args: [gasPrice] }))
  if (fee === null || fee < 0n) return { mintFeeEth: null, gasPrice }
  const eth = Number(formatUnits(fee, 18))
  return { mintFeeEth: Number.isFinite(eth) && eth > 0 ? eth : null, gasPrice }
}
/**
 * Mint + claim fees in ETH at the current gas price, read live from the FUEL
 * token contract. Claim fees route through the same FeeDistributor as mint
 * fees (verified `_collectClaimFee` forwarding), so the burn upper-bound
 * scenario counts both. Returns nulls (never zero) when any read fails.
 */
export async function fetchFeePair(): Promise<{ mintFeeEth: number | null; claimFeeEth: number | null; gasPrice: bigint | null }> {
  if (await client.getChainId() !== robinhood.id) throw Error('Unexpected RPC network; fee withheld.')
  const gasPrice = await safe(client.getGasPrice())
  if (gasPrice === null) return { mintFeeEth: null, claimFeeEth: null, gasPrice: null }
  const [mintFee, claimFee] = await Promise.all([
    safe(client.readContract({ address: CONTRACTS[0].address, abi: tokenAbi, functionName: 'mintFee', args: [gasPrice] })),
    safe(client.readContract({ address: CONTRACTS[0].address, abi: tokenAbi, functionName: 'claimFee', args: [gasPrice] })),
  ])
  const toEth = (fee: bigint | null) => {
    if (fee === null || fee < 0n) return null
    const eth = Number(formatUnits(fee, 18))
    return Number.isFinite(eth) && eth > 0 ? eth : null
  }
  return { mintFeeEth: toEth(mintFee), claimFeeEth: toEth(claimFee), gasPrice }
}
export async function fetchPlannerQuote(count: number): Promise<PlannerQuote> {
  parseBatchSize(String(count))
  if (await client.getChainId() !== robinhood.id) throw Error('Unexpected RPC network; quote withheld.')
  const block = await client.getBlock()
  if (block.number === null || !block.hash) throw Error('Confirmed block unavailable.')
  const blockNumber = block.number
  const gasPrice = await client.getGasPrice()
  const token = CONTRACTS[0].address
  const batch = CONTRACTS[2].address
  const counts = [...new Set([1, 10, 25, 50, count])].sort((a, b) => a - b)
  const [mintFee, claimFee, maxMintTermSeconds, currentApy, rows] = await Promise.all([
    safe(client.readContract({ address: token, abi: tokenAbi, functionName: 'mintFee', args: [gasPrice], blockNumber })),
    safe(client.readContract({ address: token, abi: tokenAbi, functionName: 'claimFee', args: [gasPrice], blockNumber })),
    safe(client.readContract({ address: token, abi: tokenAbi, functionName: 'getCurrentMaxTerm', blockNumber })),
    safe(client.readContract({ address: token, abi: tokenAbi, functionName: 'getCurrentAPY', blockNumber })),
    Promise.all(counts.map(async size => {
      const args = [BigInt(size), gasPrice] as const
      const [mint, claim] = await Promise.all([
        safe(client.readContract({ address: batch, abi: batchAbi, functionName: 'batchFee', args, blockNumber })),
        safe(client.readContract({ address: batch, abi: batchAbi, functionName: 'batchClaimFee', args, blockNumber })),
      ])
      return { count: size, mintFee: mint, claimFee: claim }
    })),
  ])
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error('Chain changed during quote; refresh to retry.')
  return { blockNumber, timestamp: Number(block.timestamp), fetchedAt: Date.now(), gasPrice, maxMintTermSeconds, currentApy, direct: { mintFee, claimFee }, rows }
}
