export type PairSnapshot = {
  symbol: 'FUEL' | 'MORE'
  name: string
  tokenAddress: string
  pairAddress: string
  dexId: string
  version: string
  priceUsd: number | null
  priceNative: number | null
  liquidityUsd: number | null
  marketCap: number | null
  fdv: number | null
  volume24h: number | null
  buys24h: number | null
  sells24h: number | null
  change1h: number | null
  change6h: number | null
  change24h: number | null
  pairCreatedAt: number | null
}

export type ContractStatus = {
  key: string
  name: string
  type: string
  address: string
  reachable: boolean
  verified: boolean
  proxyType: string | null
  implementation: string | null
  contractName: string | null
}

export type HolderRow = {
  address: string
  percent: number | null
  isContract: boolean | null
}

export type HolderSummary = {
  totalHolders: number | null
  topAddress: string | null
  topPercent: number | null
  topIsContract: boolean | null
  topNonContractPercent: number | null
  /** First page of Blockscout holders (up to 5). null = list unavailable; [] = confirmed empty. */
  topHolders: HolderRow[] | null
}

export const unavailableHolders = (): HolderSummary => ({
  totalHolders: null,
  topAddress: null,
  topPercent: null,
  topIsContract: null,
  topNonContractPercent: null,
  topHolders: null,
})

export type ActivityItem = {
  hash: string
  timestamp: string
  symbol: string
  event: string
  amount: number
  from: string
  to: string
  status: 'Confirmed'
}

export type ProtocolSnapshot = {
  totalSupply: bigint | null
  /** MORE total supply, read through the ERC-20 proxy. Added 2026-09-21. */
  moreTotalSupply: bigint | null
  globalRank: bigint | null
  activeMinters: bigint | null
  totalStaked: bigint | null
  activeStakes: bigint | null
  amp: bigint | null
  eaar: bigint | null
  maxTermSeconds: bigint | null
  fuelBurnt: bigint | null
  moreBurnt: bigint | null
  ethUsedFuelBurns: bigint | null
  ethUsedMoreBurns: bigint | null
  totalDistributed: bigint | null
  vaultBalance: bigint | null
  vaultSwept: bigint | null
  vaultCycle: bigint | null
  vaultCycleEnd: bigint | null
}

export type RadarData = {
  sources: import('./sourceStatus').SourceCheck[]
  pairs: PairSnapshot[]
  contracts: ContractStatus[]
  holders: Record<string, HolderSummary>
  activity: ActivityItem[]
  protocolObservation?: { blockNumber: string; blockHash: string; blockTimestamp: string }
  protocol: ProtocolSnapshot
  updatedAt: string
  partial: boolean
}

export type HistoryPoint = {
  at: number
  fuelPrice: number | null
  morePrice: number | null
  fuelLiquidity: number | null
  moreLiquidity: number | null
  // Optional server-side attribution (market-history v2): which upstream
  // source each side's quote came from, plus the upstream quote timestamp
  // when the source publishes one. Absent for browser-recorded points.
  fuelSource?: string | null
  moreSource?: string | null
  fuelObservedAt?: number | null
  moreObservedAt?: number | null
}

export type WalletPosition = {
  address: string
  fuelBalance: bigint | null
  blockNumber: bigint
  blockHash: string
  reads: { balance: boolean; mint: boolean; stake: boolean }
  batch: { total: number | null; offset: number; nextOffset: number | null; items: Array<{ index: number; proxy: string | null; available: boolean; mint: WalletPosition['mint'] }> }
  mint: {
    term: bigint
    maturityTs: bigint
    rank: bigint
    amplifier: bigint
    eaaRate: bigint
  } | null
  stake: {
    term: bigint
    maturityTs: bigint
    amount: bigint
    apy: bigint
  } | null
}
