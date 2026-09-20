import { sourceCheck, hasUnavailableSources } from './sourceStatus'
import { createPublicClient, formatUnits, http, type Address } from 'viem'
import {
  BLOCKSCOUT,
  CONTRACTS,
  fuelAbi,
  fuelBurnerAbi,
  moreBurnerAbi,
  PAIRS,
  RPC_URL,
  robinhood,
  vaultAbi,
  distributorAbi,
} from './contracts'
import {
  ActivityItem,
  ContractStatus,
  HolderRow,
  HolderSummary,
  PairSnapshot,
  ProtocolSnapshot,
  RadarData,
  unavailableHolders,
} from './types'

const DEX_API = 'https://api.dexscreener.com/latest/dex/pairs/robinhood'
const BLOCKSCOUT_API = `${BLOCKSCOUT}/api/v2`

const makeClient = (rpcUrl = RPC_URL) => createPublicClient({
  chain: robinhood,
  transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
})

type DexPair = {
  chainId: string
  dexId: string
  pairAddress: string
  labels?: string[]
  baseToken: { address: string; name: string; symbol: string }
  priceUsd?: string
  priceNative?: string
  liquidity?: { usd?: number }
  marketCap?: number
  fdv?: number
  volume?: { h24?: number }
  txns?: { h24?: { buys?: number; sells?: number } }
  priceChange?: { h1?: number; h6?: number; h24?: number }
  pairCreatedAt?: number
}

type BlockscoutContract = {
  name?: string | null
  is_verified?: boolean | null
  proxy_type?: string | null
  implementations?: Array<{ address_hash?: string }>
}

type HolderItem = {
  value: string
  address: { hash: string; is_contract?: boolean }
}

type TokenMeta = { total_supply: string; holders_count: string | number }

type TransferItem = {
  transaction_hash: string
  timestamp: string
  from: { hash: string }
  to: { hash: string }
  total: { value: string; decimals: string }
  token: { symbol: string }
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function json<T>(url: string, attempt = 0): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) {
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await pause(500 * (attempt + 1))
      return json<T>(url, attempt + 1)
    }
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

async function fetchPair(pairAddress: string): Promise<PairSnapshot> {
  const payload = await json<{ pairs: DexPair[] | null }>(`${DEX_API}/${pairAddress}`)
  const pair = payload.pairs?.[0]
  if (!pair) throw new Error(`Pair not found: ${pairAddress}`)
  const tokenAddress = pairAddress.toLowerCase() === PAIRS.fuel.toLowerCase() ? CONTRACTS[0].address : CONTRACTS[1].address
  if (pair.chainId !== 'robinhood' || pair.pairAddress.toLowerCase() !== pairAddress.toLowerCase() || pair.baseToken.address.toLowerCase() !== tokenAddress.toLowerCase()) throw new Error('Market identity mismatch')
  return {
    symbol: pair.baseToken.symbol.toUpperCase() as 'FUEL' | 'MORE',
    name: pair.baseToken.name,
    tokenAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    version: pair.labels?.[0] ?? '—',
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    priceNative: pair.priceNative ? Number(pair.priceNative) : null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    marketCap: pair.marketCap ?? null,
    fdv: pair.fdv ?? null,
    volume24h: pair.volume?.h24 ?? null,
    buys24h: pair.txns?.h24?.buys ?? null,
    sells24h: pair.txns?.h24?.sells ?? null,
    change1h: pair.priceChange?.h1 ?? null,
    change6h: pair.priceChange?.h6 ?? null,
    change24h: pair.priceChange?.h24 ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null,
  }
}

async function fetchContractStatus(contract: (typeof CONTRACTS)[number]): Promise<ContractStatus> {
  const data = await json<BlockscoutContract>(`${BLOCKSCOUT_API}/smart-contracts/${contract.address}`)
  return {
    ...contract,
    reachable: true,
    verified: Boolean(data.is_verified),
    proxyType: data.proxy_type ?? null,
    implementation: data.implementations?.[0]?.address_hash ?? null,
    contractName: data.name ?? null,
  }
}

async function fetchHolderSummary(address: string): Promise<HolderSummary> {
  const [meta, holders] = await Promise.all([
    json<TokenMeta>(`${BLOCKSCOUT_API}/tokens/${address}`),
    json<{ items: HolderItem[] }>(`${BLOCKSCOUT_API}/tokens/${address}/holders`),
  ])
  const supply = BigInt(meta.total_supply)
  const percent = (value: string) => supply > 0n ? Number((BigInt(value) * 10_000n) / supply) / 100 : null
  const items = Array.isArray(holders.items) ? holders.items : []
  const top = items[0]
  const topNonContract = items.find((item) => !item.address.is_contract)
  const totalHolders = Number(meta.holders_count)
  const rows: HolderRow[] = items.slice(0, 5).map((item) => ({
    address: item.address.hash,
    percent: percent(item.value),
    isContract: item.address.is_contract == null ? null : Boolean(item.address.is_contract),
  }))
  // Empty first page with a positive holder count is an incomplete list, not “no holders.”
  const topHolders = rows.length > 0 ? rows : totalHolders === 0 ? [] : null
  return {
    totalHolders,
    topAddress: top?.address.hash ?? null,
    topPercent: top ? percent(top.value) : null,
    topIsContract: top ? Boolean(top.address.is_contract) : null,
    topNonContractPercent: topNonContract ? percent(topNonContract.value) : null,
    topHolders,
  }
}

async function fetchTransfers(address: string): Promise<ActivityItem[]> {
  const data = await json<{ items: TransferItem[] }>(`${BLOCKSCOUT_API}/tokens/${address}/transfers`)
  const zero = /^0x0{40}$/i
  const dead = /^0x0{36}dead$/i
  const poolAddresses = Object.values(PAIRS).map((item) => item.toLowerCase())
  return data.items.slice(0, 8).map((item) => {
    const from = item.from.hash
    const to = item.to.hash
    const event = zero.test(from)
      ? 'Mint'
      : dead.test(to) || zero.test(to)
        ? 'Burn'
        : poolAddresses.includes(from.toLowerCase()) || poolAddresses.includes(to.toLowerCase())
          ? 'Pool transfer'
          : 'Transfer'
    return {
      hash: item.transaction_hash,
      timestamp: item.timestamp,
      symbol: item.token.symbol,
      event,
      amount: Number(formatUnits(BigInt(item.total.value), Number(item.total.decimals))),
      from,
      to,
      status: 'Confirmed' as const,
    }
  })
}

async function safeRead<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

async function fetchProtocol(client: ReturnType<typeof makeClient>): Promise<{ values: ProtocolSnapshot; observation: { blockNumber: string; blockHash: string; blockTimestamp: string } }> {
  if (await client.getChainId() !== robinhood.id) throw new Error('Unexpected RPC network')
  const block = await client.getBlock()
  if (block.number === null || !block.hash) throw new Error('Confirmed block unavailable')
  const blockNumber = block.number
  const fuel = CONTRACTS[0].address as Address
  const distributor = CONTRACTS[3].address as Address
  const vault = CONTRACTS[4].address as Address
  const fuelBurner = CONTRACTS[5].address as Address
  const moreBurner = CONTRACTS[6].address as Address
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string) =>
    safeRead(client.readContract({ address, abi, functionName, blockNumber } as never) as Promise<T>)

  const [
    totalSupply, globalRank, activeMinters, totalStaked, activeStakes, amp, eaar,
    maxTermSeconds, fuelBurnt, moreBurnt, ethUsedFuelBurns, ethUsedMoreBurns,
    totalDistributed, vaultBalance, vaultSwept, vaultCycle, vaultCycleEnd,
  ] = await Promise.all([
    read<bigint>(fuel, fuelAbi, 'totalSupply'),
    read<bigint>(fuel, fuelAbi, 'globalRank'),
    read<bigint>(fuel, fuelAbi, 'activeMinters'),
    read<bigint>(fuel, fuelAbi, 'totalTokenStaked'),
    read<bigint>(fuel, fuelAbi, 'activeStakes'),
    read<bigint>(fuel, fuelAbi, 'getCurrentAMP'),
    read<bigint>(fuel, fuelAbi, 'getCurrentEAAR'),
    read<bigint>(fuel, fuelAbi, 'getCurrentMaxTerm'),
    read<bigint>(fuelBurner, fuelBurnerAbi, 'totalTokenBurnt'),
    read<bigint>(moreBurner, moreBurnerAbi, 'totalMoreBurnt'),
    read<bigint>(fuelBurner, fuelBurnerAbi, 'ethUsedForBurns'),
    read<bigint>(moreBurner, moreBurnerAbi, 'ethUsedForBurns'),
    read<bigint>(distributor, distributorAbi, 'totalDistributed'),
    safeRead(client.getBalance({ address: vault, blockNumber })),
    read<bigint>(vault, vaultAbi, 'totalSwept'),
    read<bigint>(vault, vaultAbi, 'currentCycle'),
    read<bigint>(vault, vaultAbi, 'currentCycleEnd'),
  ])
  if (await client.getChainId() !== robinhood.id || (await client.getBlock({ blockNumber })).hash !== block.hash) {
    throw new Error('Chain changed during protocol reads')
  }

  return { observation: { blockNumber: blockNumber.toString(), blockHash: block.hash, blockTimestamp: block.timestamp.toString() }, values: {
    totalSupply, globalRank, activeMinters, totalStaked, activeStakes, amp, eaar,
    maxTermSeconds, fuelBurnt, moreBurnt, ethUsedFuelBurns, ethUsedMoreBurns,
    totalDistributed, vaultBalance, vaultSwept, vaultCycle, vaultCycleEnd,
  } }
}

export async function fetchRadarData(rpcUrl = RPC_URL): Promise<RadarData> {
  const checked = new Map<string, string>()
  async function track<T>(name: string, promise: Promise<T>): Promise<T> {
    try { return await promise } finally { checked.set(name, new Date().toISOString()) }
  }
  const pairResults = await Promise.allSettled(Object.values(PAIRS).map(fetchPair))
  checked.set('Dexscreener markets', new Date().toISOString())
  const contractResults: PromiseSettledResult<ContractStatus>[] = []
  for (const contract of CONTRACTS) {
    try {
      contractResults.push({ status: 'fulfilled', value: await fetchContractStatus(contract) })
    } catch (reason) {
      contractResults.push({ status: 'rejected', reason })
    }
    await pause(120)
  }
  checked.set('Blockscout contracts', new Date().toISOString())
  const [fuelHolders, moreHolders, fuelActivity, moreActivity, protocol] = await Promise.allSettled([
    track('FUEL holders', fetchHolderSummary(CONTRACTS[0].address)),
    track('MORE holders', fetchHolderSummary(CONTRACTS[1].address)),
    track('FUEL transfers', fetchTransfers(CONTRACTS[0].address)),
    track('MORE transfers', fetchTransfers(CONTRACTS[1].address)),
    track('Protocol RPC reads', fetchProtocol(makeClient(rpcUrl))),
  ])

  const pairs = pairResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const contracts = contractResults.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { ...CONTRACTS[index], reachable: false, verified: false, proxyType: null, implementation: null, contractName: null })
  const activity = [
    ...(fuelActivity.status === 'fulfilled' ? fuelActivity.value : []),
    ...(moreActivity.status === 'fulfilled' ? moreActivity.value : []),
  ].sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)).slice(0, 10)

  const emptyProtocol: ProtocolSnapshot = {
    totalSupply: null, globalRank: null, activeMinters: null, totalStaked: null,
    activeStakes: null, amp: null, eaar: null, maxTermSeconds: null,
    fuelBurnt: null, moreBurnt: null, ethUsedFuelBurns: null, ethUsedMoreBurns: null,
    totalDistributed: null, vaultBalance: null, vaultSwept: null, vaultCycle: null,
    vaultCycleEnd: null,
  }

  const checkedAt = new Date().toISOString()
  const protocolValue = protocol.status === 'fulfilled' ? protocol.value.values : emptyProtocol
  const protocolFields = Object.values(protocolValue)
  const sources = [
    sourceCheck('Dexscreener markets', pairs.length, 2, checkedAt, 'Third-party mirror of on-chain pool price/liquidity; not an executable quote; fetch time is not trade time.'),
    sourceCheck('Blockscout contracts', contracts.filter(item => item.reachable).length, CONTRACTS.length, checkedAt, 'Source-verification metadata is not a security audit.'),
    ...([['FUEL holders', fuelHolders], ['MORE holders', moreHolders], ['FUEL transfers', fuelActivity], ['MORE transfers', moreActivity]] as const).map(([name, result]) => sourceCheck(name, result.status === 'fulfilled' ? 1 : 0, 1, checkedAt, 'Explorer-indexed data may lag the chain.')),
    sourceCheck('Protocol RPC reads', protocolFields.filter(value => value !== null).length, protocolFields.length, checkedAt, `${protocolFields.filter(value => value !== null).length}/${protocolFields.length} reads returned. Reads pinned to one block; hash rechecked.`),
  ]
  for (const source of sources) source.checkedAt = checked.get(source.name) ?? checkedAt
  return {
    sources,
    pairs,
    contracts,
    holders: {
      FUEL: fuelHolders.status === 'fulfilled' ? fuelHolders.value : unavailableHolders(),
      MORE: moreHolders.status === 'fulfilled' ? moreHolders.value : unavailableHolders(),
    },
    activity,
    protocol: protocol.status === 'fulfilled' ? protocol.value.values : emptyProtocol,
    protocolObservation: protocol.status === 'fulfilled' ? protocol.value.observation : undefined,
    updatedAt: new Date().toISOString(),
    partial: hasUnavailableSources(sources),
  }
}

export { fetchWalletPosition } from './wallet'
