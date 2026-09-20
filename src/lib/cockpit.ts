import { createPublicClient, getAddress, http, parseAbi, type Address } from 'viem'
import { CONTRACTS, fuelAbi, RPC_URL, robinhood } from './contracts'
import { lateClaimPenaltyPct } from './provenance'
import { decodeMint } from './wallet'
import { cockpitFetch } from './cockpitTransport'

const batchAbi = parseAbi([
  'function proxiesOf(address) view returns (uint256)',
  'function proxyAddress(address,uint256) view returns (address)',
])

const rewardAbi = parseAbi([
  'function getGrossReward(uint256 rankDelta, uint256 amplifier, uint256 term, uint256 eaa) pure returns (uint256)',
])

const createClient = (signal?: AbortSignal) => createPublicClient({
  chain: robinhood,
  transport: http(RPC_URL, { timeout: 90_000, retryCount: 0, fetchFn: cockpitFetch, fetchOptions: { signal } }),
})

const token = CONTRACTS[0].address as Address
const batch = CONTRACTS[2].address as Address
const safe = async <T>(promise: Promise<T>): Promise<T | null> => { try { return await promise } catch { return null } }

export type MaturityBucket = {
  key: string
  label: string
  count: number
  earliestTs: number | null
}

export type CockpitMintSlot = {
  id: string
  source: 'direct' | 'batch'
  index: number | null
  proxy: Address | null
  term: bigint
  maturityTs: bigint
  rank: bigint
  amplifier: bigint
  eaaRate: bigint
}

export type CockpitSnapshot = {
  address: string
  blockNumber: bigint
  blockHash: string
  observedAt: number
  fuelBalance: bigint | null
  globalRank: bigint | null
  directMint: ReturnType<typeof decodeMint>
  directStake: { term: bigint; maturityTs: bigint; amount: bigint; apy: bigint } | null
  batchTotal: number | null
  activeMints: number
  dueOrLate: number
  upcoming7d: number
  upcoming30d: number
  later: number
  nextMaturityTs: number | null
  maxLatePenaltyPct: number
  sampleIncomplete: boolean
  buckets: MaturityBucket[]
  slots: CockpitMintSlot[]
}

function bucketKey(maturityTs: number, now: number): MaturityBucket['key'] {
  if (maturityTs <= now) return 'due'
  const days = (maturityTs - now) / 86_400
  if (days <= 7) return 'd7'
  if (days <= 30) return 'd30'
  return 'later'
}

function utcDay(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

/**
 * Personal cockpit read: balance + direct state + full batch inventory.
 * Preserves per-slot mint rows for day-level sell insight.
 */
export async function fetchCockpitSnapshot(input: string, onProgress?: (message: string) => void, options: { signal?: AbortSignal } = {}): Promise<CockpitSnapshot> {
  options.signal?.throwIfAborted()
  const client = createClient(options.signal)
  const address = getAddress(input)
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  const block = await client.getBlock()
  if (block.number === null || !block.hash) throw new Error('Confirmed block unavailable')
  const blockNumber = block.number
  const now = Number(block.timestamp)

  const [fuelBalance, mintRaw, stakeRaw, count, globalRank] = await Promise.all([
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'balanceOf', args: [address], blockNumber })),
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'userMints', args: [address], blockNumber })),
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'userStakes', args: [address], blockNumber })),
    safe(client.readContract({ address: batch, abi: batchAbi, functionName: 'proxiesOf', args: [address], blockNumber })),
    safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'globalRank', blockNumber })),
  ])

  const batchTotal = count !== null && count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null
  const slots: CockpitMintSlot[] = []
  let sampleIncomplete = mintRaw === null || count === null || batchTotal === null || stakeRaw === null
  const directMint = decodeMint(mintRaw)
  if (directMint) {
    slots.push({
      id: 'direct',
      source: 'direct',
      index: null,
      proxy: null,
      term: directMint.term,
      maturityTs: directMint.maturityTs,
      rank: directMint.rank,
      amplifier: directMint.amplifier,
      eaaRate: directMint.eaaRate,
    })
  }

  if (batchTotal !== null && batchTotal > 0) {
    const chunk = 6
    for (let start = 0; start < batchTotal; start += chunk) {
      options.signal?.throwIfAborted()
      onProgress?.(`Reading mint slots · ${start}/${batchTotal} complete`)
      const slice = await Promise.all(Array.from({ length: Math.min(chunk, batchTotal - start) }, async (_, n) => {
        const index = start + n
        const proxy = await safe(client.readContract({ address: batch, abi: batchAbi, functionName: 'proxyAddress', args: [address, BigInt(index)], blockNumber }))
        if (!proxy) { sampleIncomplete = true; return null }
        const raw = await safe(client.readContract({ address: token, abi: fuelAbi, functionName: 'userMints', args: [proxy], blockNumber }))
        if (raw === null) { sampleIncomplete = true; return null }
        const mint = decodeMint(raw)
        if (!mint) return null
        return {
          id: `batch:${index}`,
          source: 'batch' as const,
          index,
          proxy,
          term: mint.term,
          maturityTs: mint.maturityTs,
          rank: mint.rank,
          amplifier: mint.amplifier,
          eaaRate: mint.eaaRate,
        }
      }))
      options.signal?.throwIfAborted()
      onProgress?.(`Reading mint slots · ${Math.min(start + chunk, batchTotal)}/${batchTotal} complete`)
      for (const slot of slice) if (slot) slots.push(slot)
      if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('Snapshot changed; refresh cockpit')
    }
  }

  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('Snapshot changed; refresh cockpit')

  options.signal?.throwIfAborted()
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  slots.sort((a, b) => Number(a.maturityTs - b.maturityTs) || (a.index ?? -1) - (b.index ?? -1))

  const counts = { due: 0, d7: 0, d30: 0, later: 0 }
  const earliest: Record<string, number | null> = { due: null, d7: null, d30: null, later: null }
  let maxLatePenaltyPct = 0
  for (const slot of slots) {
    const ts = Number(slot.maturityTs)
    const key = bucketKey(ts, now)
    counts[key as keyof typeof counts]++
    if (earliest[key] == null || ts < earliest[key]!) earliest[key] = ts
    if (ts <= now) maxLatePenaltyPct = Math.max(maxLatePenaltyPct, lateClaimPenaltyPct(now - ts))
  }

  const upcomingOnly = slots.map(slot => Number(slot.maturityTs)).filter(ts => ts > now)
  const nextUp = upcomingOnly.length ? Math.min(...upcomingOnly) : null
  const dueTs = slots.map(slot => Number(slot.maturityTs)).filter(ts => ts <= now)

  return {
    address,
    blockNumber,
    blockHash: block.hash,
    observedAt: now,
    fuelBalance,
    globalRank,
    directMint,
    directStake: stakeRaw && stakeRaw[2] > 0n ? { term: stakeRaw[0], maturityTs: stakeRaw[1], amount: stakeRaw[2], apy: stakeRaw[3] } : null,
    batchTotal,
    activeMints: slots.length,
    dueOrLate: counts.due,
    upcoming7d: counts.d7,
    upcoming30d: counts.d30,
    later: counts.later,
    nextMaturityTs: nextUp ?? (dueTs.length ? Math.min(...dueTs) : null),
    maxLatePenaltyPct,
    sampleIncomplete,
    buckets: [
      { key: 'due', label: 'Due / late', count: counts.due, earliestTs: earliest.due },
      { key: 'd7', label: 'Next 7 days', count: counts.d7, earliestTs: earliest.d7 },
      { key: 'd30', label: '8–30 days', count: counts.d30, earliestTs: earliest.d30 },
      { key: 'later', label: 'Later', count: counts.later, earliestTs: earliest.later },
    ],
    slots,
  }
}

export function groupSlotsByUtcDay(slots: CockpitMintSlot[]) {
  const map = new Map<string, CockpitMintSlot[]>()
  for (const slot of slots) {
    const day = utcDay(Number(slot.maturityTs))
    const list = map.get(day) ?? []
    list.push(slot)
    map.set(day, list)
  }
  return [...map.entries()]
    .map(([date, items]) => ({ date, count: items.length, slots: items }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Estimate claimable FUEL (wei) for selected slots using verified Token formulas via eth_call. */
export async function estimateSlotRewards(args: {
  slots: CockpitMintSlot[]
  globalRank: bigint
  nowTs: number
  blockNumber?: bigint
  blockHash?: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<{ grossWei: bigint; netWei: bigint; incomplete: boolean; perSlot: Array<{ id: string; grossWei: bigint | null; netWei: bigint | null; penaltyPct: number }> }> {
  const { slots, globalRank, nowTs, blockNumber, onProgress, signal } = args
  signal?.throwIfAborted()
  const client = createClient(signal)
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  const pinned = await client.getBlock(blockNumber === undefined ? {} : { blockNumber })
  if (pinned.number === null || !pinned.hash || (args.blockHash && pinned.hash !== args.blockHash)) throw new Error('Snapshot changed; refresh cockpit')
  const perSlot: Array<{ id: string; grossWei: bigint | null; netWei: bigint | null; penaltyPct: number }> = []
  let grossWei = 0n
  let netWei = 0n
  let incomplete = false
  const chunk = 6
  for (let start = 0; start < slots.length; start += chunk) {
    signal?.throwIfAborted()
    onProgress?.(`Reading reward amounts · ${start}/${slots.length} complete`)
    const batchSlots = slots.slice(start, start + chunk)
    const results = await Promise.all(batchSlots.map(async slot => {
      const rankDelta = globalRank > slot.rank ? globalRank - slot.rank : 0n
      const safeDelta = rankDelta < 2n ? 2n : rankDelta
      const eaa = 1000n + slot.eaaRate
      const maturity = Number(slot.maturityTs)
      const secsLate = maturity <= nowTs ? nowTs - maturity : 0
      const penaltyPct = maturity <= nowTs ? lateClaimPenaltyPct(secsLate) : 0
      const grossWhole = await safe(client.readContract({
        address: token,
        abi: rewardAbi,
        functionName: 'getGrossReward',
        args: [safeDelta, slot.amplifier, slot.term, eaa],
        blockNumber: pinned.number,
      }))
      if (grossWhole == null) return { id: slot.id, grossWei: null, netWei: null, penaltyPct }
      const gross = grossWhole * 10n ** 18n
      const net = (gross * BigInt(100 - penaltyPct)) / 100n
      return { id: slot.id, grossWei: gross, netWei: net, penaltyPct }
    }))
    signal?.throwIfAborted()
    onProgress?.(`Reading reward amounts · ${Math.min(start + chunk, slots.length)}/${slots.length} complete`)
    for (const row of results) {
      perSlot.push(row)
      if (row.grossWei == null || row.netWei == null) incomplete = true
      else {
        grossWei += row.grossWei
        netWei += row.netWei
      }
    }
  }
  signal?.throwIfAborted()
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  if ((await client.getBlock({blockNumber:pinned.number})).hash !== pinned.hash) throw new Error('Snapshot changed; refresh cockpit')
  return { grossWei, netWei, incomplete, perSlot }
}
