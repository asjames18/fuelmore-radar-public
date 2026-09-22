import { createPublicClient, getAddress, http, parseAbi, type Address } from 'viem'
import { CONTRACTS, fuelAbi, RPC_URL, robinhood } from './contracts'
import type { WalletPosition } from './types'

const batchAbi = parseAbi(['function proxiesOf(address) view returns (uint256)', 'function proxyAddress(address,uint256) view returns (address)'])
const client = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { timeout: 12_000, retryCount: 2, retryDelay: 500 }) })
const token = CONTRACTS[0].address as Address
const batch = CONTRACTS[2].address as Address
const PAGE_SIZE = 25
const safe = async <T>(promise: Promise<T>): Promise<T | null> => { try { return await promise } catch { return null } }
export function decodeMint(raw: readonly [Address, bigint, bigint, bigint, bigint, bigint] | null): WalletPosition['mint'] {
  return raw && raw[0] !== '0x0000000000000000000000000000000000000000'
    ? { term: raw[1], maturityTs: raw[2], rank: raw[3], amplifier: raw[4], eaaRate: raw[5] } : null
}

export async function fetchWalletPosition(input: string, offset = 0, snapshot?: { blockNumber: bigint; blockHash: string }): Promise<WalletPosition> {
  const address = getAddress(input)
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  const block = await client.getBlock(snapshot ? { blockNumber: snapshot.blockNumber } : {})
  if (block.number === null || !block.hash || (snapshot && snapshot.blockHash !== block.hash)) throw new Error('Snapshot changed; refresh lookup')
  const blockNumber = block.number
  const [fuelBalance, mintRaw, stakeRaw, count] = await Promise.all([
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'balanceOf', args: [address], blockNumber })),
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'userMints', args: [address], blockNumber })),
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'userStakes', args: [address], blockNumber })),
    safe(client.readContract({ address: batch, abi: batchAbi, functionName: 'proxiesOf', args: [address], blockNumber })),
  ])
  const total = count !== null && count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null
  const items: WalletPosition['batch']['items'] = []
  if (total !== null) {
    for (let start = offset; start < Math.min(total, offset + PAGE_SIZE); start += 5) {
      const group = await Promise.all(Array.from({ length: Math.min(5, total - start, offset + PAGE_SIZE - start) }, async (_, n) => {
        const index = start + n
        const proxy = await safe(client.readContract({ address: batch, abi: batchAbi, functionName: 'proxyAddress', args: [address, BigInt(index)], blockNumber }))
        const raw = proxy ? await safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'userMints', args: [proxy], blockNumber })) : null
        return { index, proxy, available: raw !== null, mint: decodeMint(raw) }
      }))
      items.push(...group)
    }
  }
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('Snapshot changed; refresh lookup')
  return {
    address, blockNumber, blockHash: block.hash, fuelBalance, mint: decodeMint(mintRaw),
    stake: stakeRaw && stakeRaw[2] > 0n ? { term: stakeRaw[0], maturityTs: stakeRaw[1], amount: stakeRaw[2], apy: stakeRaw[3] } : null,
    reads: { balance: fuelBalance !== null, mint: mintRaw !== null, stake: stakeRaw !== null },
    batch: { total, offset, nextOffset: total !== null && offset + items.length < total ? offset + items.length : null, items },
  }
}
