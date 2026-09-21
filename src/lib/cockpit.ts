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
const multicallAddress = robinhood.contracts?.multicall3?.address as Address | undefined
const safe = async <T>(promise: Promise<T>): Promise<T | null> => { try { return await promise } catch { return null } }

/** Subcalls per aggregate3 eth_call — stays comfortably under eth_call gas caps. */
const MULTICALL_CHUNK = 120

type MulticallCall = {
  address: Address
  abi: typeof fuelAbi | typeof batchAbi | typeof rewardAbi
  functionName: string
  args: readonly unknown[]
}

type MulticallOutcome =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: Error }

type LooseMulticall = (args: {
  contracts: { address: Address; abi: unknown; functionName: string; args: unknown[] }[]
  allowFailure: true
  blockNumber: bigint
  multicallAddress: Address
}) => Promise<MulticallOutcome[]>

/**
 * Run view calls through Multicall3.aggregate3 in ~120-call chunks.
 * allowFailure is always true: one bad subcall marks that slot unknown,
 * it never poisons the rest of the batch.
 */
async function runMulticall(
  client: ReturnType<typeof createClient>,
  calls: MulticallCall[],
  blockNumber: bigint,
  report?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<MulticallOutcome[]> {
  if (!multicallAddress) throw new Error('Multicall3 not configured for Robinhood Chain')
  const multicall = client.multicall.bind(client) as unknown as LooseMulticall
  const out: MulticallOutcome[] = []
  for (let start = 0; start < calls.length; start += MULTICALL_CHUNK) {
    report?.signal?.throwIfAborted()
    const slice = calls.slice(start, start + MULTICALL_CHUNK)
    const results = await multicall({
      contracts: slice.map(c => ({ address: c.address, abi: c.abi, functionName: c.functionName, args: [...c.args] })),
      allowFailure: true,
      blockNumber,
      multicallAddress,
    })
    if (!Array.isArray(results) || results.length !== slice.length) throw new Error('Multicall result mismatch')
    out.push(...results)
    report?.onProgress?.(Math.min(start + MULTICALL_CHUNK, calls.length), calls.length)
  }
  return out
}

/** Guard a multicall userMints tuple before handing it to decodeMint. */
function decodeMintOutcome(result: unknown): ReturnType<typeof decodeMint> {
  if (!Array.isArray(result) || result.length < 6) return null
  return decodeMint(result as [Address, bigint, bigint, bigint, bigint, bigint])
}

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
  /** Block the slot inventory was pinned at — equals blockNumber on a full scan,
   *  older on an incremental refresh that reused a previous inventory. */
  slotsPinnedBlockNumber: bigint
  slotsPinnedBlockHash: string
}

export type CockpitRefreshOptions = {
  signal?: AbortSignal
  /**
   * Previous snapshot for the same wallet. The 5 cheap reads always run first;
   * mint slots are only rescanned when the proxy count changed. Slots are never
   * silently mixed across blocks: reuse keeps the previous slotsPinned* pin.
   */
  previous?: CockpitSnapshot | null
}

export type CockpitSnapshotSource = 'server' | 'direct'

function bucketKey(maturityTs: number, now: number): 'due' | 'd7' | 'd30' | 'later' {
  if (maturityTs <= now) return 'due'
  const days = (maturityTs - now) / 86_400
  if (days <= 7) return 'd7'
  if (days <= 30) return 'd30'
  return 'later'
}

function utcDay(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

function summarizeSlots(slots: CockpitMintSlot[], now: number) {
  const counts = { due: 0, d7: 0, d30: 0, later: 0 }
  const earliest: Record<'due' | 'd7' | 'd30' | 'later', number | null> = { due: null, d7: null, d30: null, later: null }
  let maxLatePenaltyPct = 0
  for (const slot of slots) {
    const ts = Number(slot.maturityTs)
    const key = bucketKey(ts, now)
    counts[key]++
    if (earliest[key] == null || ts < earliest[key]!) earliest[key] = ts
    if (ts <= now) maxLatePenaltyPct = Math.max(maxLatePenaltyPct, lateClaimPenaltyPct(now - ts))
  }
  const upcomingOnly = slots.map(slot => Number(slot.maturityTs)).filter(ts => ts > now)
  const dueTs = slots.map(slot => Number(slot.maturityTs)).filter(ts => ts <= now)
  const nextUp = upcomingOnly.length ? Math.min(...upcomingOnly) : null
  return {
    dueOrLate: counts.due,
    upcoming7d: counts.d7,
    upcoming30d: counts.d30,
    later: counts.later,
    nextMaturityTs: nextUp ?? (dueTs.length ? Math.min(...dueTs) : null),
    maxLatePenaltyPct,
    buckets: [
      { key: 'due', label: 'Due / late', count: counts.due, earliestTs: earliest.due },
      { key: 'd7', label: 'Next 7 days', count: counts.d7, earliestTs: earliest.d7 },
      { key: 'd30', label: '8–30 days', count: counts.d30, earliestTs: earliest.d30 },
      { key: 'later', label: 'Later', count: counts.later, earliestTs: earliest.later },
    ] as MaturityBucket[],
  }
}

/**
 * Personal cockpit read: balance + direct state + full batch inventory.
 * Inventory and reward reads go through Multicall3 (~120 subcalls per
 * eth_call); a failed subcall marks that slot unknown, never zero.
 * Preserves per-slot mint rows for day-level sell insight.
 */
export async function fetchCockpitSnapshot(input: string, onProgress?: (message: string) => void, options: CockpitRefreshOptions = {}): Promise<CockpitSnapshot> {
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

  let slotsPinnedBlockNumber: bigint
  let slotsPinnedBlockHash: string
  const previous = options.previous
  const sameWallet = !!previous && previous.address.toLowerCase() === address.toLowerCase()
  if (sameWallet && previous.batchTotal !== null && batchTotal !== null && previous.batchTotal === batchTotal && previous.slotsPinnedBlockHash) {
    // Incremental refresh: mint count unchanged, reuse the pinned inventory.
    for (const slot of previous.slots) if (slot.source === 'batch') slots.push(slot)
    sampleIncomplete = sampleIncomplete || previous.sampleIncomplete
    slotsPinnedBlockNumber = previous.slotsPinnedBlockNumber ?? previous.blockNumber
    slotsPinnedBlockHash = previous.slotsPinnedBlockHash
    onProgress?.('Mint count unchanged — reusing pinned slot inventory')
  } else if (batchTotal !== null && batchTotal > 0) {
    // Pass 1: proxy addresses for every mint index.
    const proxyOutcomes = await runMulticall(
      client,
      Array.from({ length: batchTotal }, (_, index) => ({
        address: batch,
        abi: batchAbi,
        functionName: 'proxyAddress',
        args: [address, BigInt(index)],
      })),
      blockNumber,
      { signal: options.signal, onProgress: (done, total) => onProgress?.(`Reading mint slots · ${done}/${total} complete`) },
    )
    const proxies = proxyOutcomes.map(outcome => {
      if (outcome.status === 'success' && typeof outcome.result === 'string' && outcome.result.startsWith('0x')) {
        return outcome.result as Address
      }
      sampleIncomplete = true
      return null
    })
    // Pass 2: mint state per proxy.
    const targets: { index: number; proxy: Address }[] = []
    proxies.forEach((proxy, index) => { if (proxy) targets.push({ index, proxy }) })
    const mintOutcomes = await runMulticall(
      client,
      targets.map(t => ({ address: token, abi: fuelAbi, functionName: 'userMints', args: [t.proxy] })),
      blockNumber,
      { signal: options.signal, onProgress: (done, total) => onProgress?.(`Reading slot mints · ${done}/${total} complete`) },
    )
    mintOutcomes.forEach((outcome, n) => {
      const { index, proxy } = targets[n]
      if (outcome.status !== 'success') { sampleIncomplete = true; return }
      const mint = decodeMintOutcome(outcome.result)
      if (!mint) return
      slots.push({
        id: `batch:${index}`,
        source: 'batch',
        index,
        proxy,
        term: mint.term,
        maturityTs: mint.maturityTs,
        rank: mint.rank,
        amplifier: mint.amplifier,
        eaaRate: mint.eaaRate,
      })
    })
    slotsPinnedBlockNumber = blockNumber
    slotsPinnedBlockHash = block.hash
  } else {
    slotsPinnedBlockNumber = blockNumber
    slotsPinnedBlockHash = block.hash
  }

  // Start AND end pin checks; chain-id recheck. No per-chunk block re-fetch:
  // a pinned block hash is immutable, so the end check is sufficient.
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('Snapshot changed; refresh cockpit')

  options.signal?.throwIfAborted()
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  slots.sort((a, b) => Number(a.maturityTs - b.maturityTs) || (a.index ?? -1) - (b.index ?? -1))

  const summary = summarizeSlots(slots, now)

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
    ...summary,
    sampleIncomplete,
    slots,
    slotsPinnedBlockNumber,
    slotsPinnedBlockHash,
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
  const defs = slots.map(slot => {
    const rankDelta = globalRank > slot.rank ? globalRank - slot.rank : 0n
    const safeDelta = rankDelta < 2n ? 2n : rankDelta
    const eaa = 1000n + slot.eaaRate
    const maturity = Number(slot.maturityTs)
    const secsLate = maturity <= nowTs ? nowTs - maturity : 0
    const penaltyPct = maturity <= nowTs ? lateClaimPenaltyPct(secsLate) : 0
    return {
      id: slot.id,
      penaltyPct,
      call: {
        address: token,
        abi: rewardAbi,
        functionName: 'getGrossReward',
        args: [safeDelta, slot.amplifier, slot.term, eaa],
      } as MulticallCall,
    }
  })
  const outcomes = await runMulticall(
    client,
    defs.map(d => d.call),
    pinned.number,
    { signal, onProgress: (done, total) => onProgress?.(`Reading reward amounts · ${done}/${total} complete`) },
  )
  signal?.throwIfAborted()
  outcomes.forEach((outcome, n) => {
    const { id, penaltyPct } = defs[n]
    if (outcome.status !== 'success' || typeof outcome.result !== 'bigint') {
      perSlot.push({ id, grossWei: null, netWei: null, penaltyPct })
      incomplete = true
      return
    }
    const gross = outcome.result * 10n ** 18n
    const net = (gross * BigInt(100 - penaltyPct)) / 100n
    perSlot.push({ id, grossWei: gross, netWei: net, penaltyPct })
    grossWei += gross
    netWei += net
  })
  signal?.throwIfAborted()
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected network')
  if ((await client.getBlock({ blockNumber: pinned.number })).hash !== pinned.hash) throw new Error('Snapshot changed; refresh cockpit')
  return { grossWei, netWei, incomplete, perSlot }
}

/**
 * Server snapshot path: GET /api/cockpit?address=0x… served by the Worker
 * (cached in KV). Bigints travel as { $bigint: "<decimal>" } tags — the same
 * tags server/cockpit-cache.mjs writes.
 */
export async function fetchCockpitSnapshotViaServer(input: string, options: { signal?: AbortSignal } = {}): Promise<CockpitSnapshot> {
  const address = getAddress(input)
  const response = await fetch(`/api/cockpit?address=${address}`, {
    signal: options.signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Cockpit snapshot endpoint responded ${response.status}`)
  const snapshot = JSON.parse(await response.text(), (_key: string, value: unknown) =>
    typeof value === 'object' && value !== null && '$bigint' in value &&
      typeof (value as Record<string, unknown>).$bigint === 'string'
      ? BigInt((value as Record<string, string>).$bigint)
      : value,
  ) as CockpitSnapshot
  if (!snapshot || typeof snapshot !== 'object' || snapshot.address?.toLowerCase() !== address.toLowerCase() ||
    typeof snapshot.blockHash !== 'string' || !Array.isArray(snapshot.slots)) {
    throw new Error('Cockpit snapshot endpoint returned an unexpected shape')
  }
  return snapshot
}

/**
 * Try the server snapshot cache first; on any failure fall back to direct
 * multicall reads. The fallback is honest: the returned source says which
 * path served the data.
 */
export async function fetchCockpitSnapshotSmart(
  input: string,
  onProgress?: (message: string) => void,
  options: CockpitRefreshOptions = {},
): Promise<{ snapshot: CockpitSnapshot; source: CockpitSnapshotSource }> {
  try {
    const snapshot = await fetchCockpitSnapshotViaServer(input, options)
    console.debug('[cockpit] snapshot served by server cache')
    return { snapshot, source: 'server' }
  } catch (error) {
    console.debug('[cockpit] server snapshot unavailable; falling back to direct reads', error)
    const snapshot = await fetchCockpitSnapshot(input, onProgress, options)
    return { snapshot, source: 'direct' }
  }
}
