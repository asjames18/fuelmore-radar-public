import { CONTRACTS } from './contracts'
import { MORE_STAKING } from './more'

/** Sourcify / source-code provenance for configured Robinhood contracts. Not a security audit. */
export type ProvenanceStatus = 'exact_match' | 'unverified' | 'not_checked'

export type ContractProvenance = {
  key: string
  name: string
  address: `0x${string}`
  sourcify: ProvenanceStatus
  verifiedAt: string | null
  sourcePath: string | null
  notes: string
}

/** Mint-fee split confirmed in FeeDistributor.sol (Sourcify exact_match). */
export const FEE_SPLIT = [
  { bps: 4500, percent: '45%', label: 'MintVault / Pump Fund', key: 'vault' as const },
  { bps: 2500, percent: '25%', label: 'FUEL Buy & Burn', key: 'fuelBurner' as const },
  { bps: 3000, percent: '30%', label: 'MORE Buy & Burn', key: 'moreBurner' as const },
] as const

export const FEE_SPLIT_BPS_DENOM = 10_000
export const CLAIM_FEE_BPS = 2_500
export const WITHDRAWAL_WINDOW_DAYS = 7
export const MAX_PENALTY_PCT = 99

export const CONTRACT_PROVENANCE: ContractProvenance[] = [
  {
    key: 'fuel',
    name: 'FUEL Token',
    address: CONTRACTS[0].address,
    sourcify: 'exact_match',
    verifiedAt: '2026-09-14T21:51:32Z',
    sourcePath: 'docs/provenance/sources/fuel/Token.sol',
    notes: 'Ranked minting, fees, late-claim penalty, stake APY parameter.',
  },
  {
    key: 'more',
    name: 'MORE Token',
    address: CONTRACTS[1].address,
    sourcify: 'unverified',
    verifiedAt: null,
    sourcePath: null,
    notes: 'Minimal proxy (~45 bytes). Implementation source not matched on Sourcify.',
  },
  {
    key: 'batch',
    name: 'BatchMinter',
    address: CONTRACTS[2].address,
    sourcify: 'exact_match',
    verifiedAt: '2026-09-15T20:07:15Z',
    sourcePath: 'docs/provenance/sources/batch/BatchMinter.sol',
    notes: 'Each proxy pays full per-address mint/claim fee; MAX_BATCH 100.',
  },
  {
    key: 'distributor',
    name: 'FeeDistributor',
    address: CONTRACTS[3].address,
    sourcify: 'exact_match',
    verifiedAt: null,
    sourcePath: 'docs/provenance/sources/distributor/FeeDistributor.sol',
    notes: 'Immutable 45/25/30 ETH split to vault / FUEL burner / MORE burner.',
  },
  {
    key: 'vault',
    name: 'MintVault',
    address: CONTRACTS[4].address,
    sourcify: 'exact_match',
    verifiedAt: null,
    sourcePath: 'docs/provenance/sources/vault/MintVault.sol',
    notes: 'Receives 45% of distributed mint fees.',
  },
  {
    key: 'fuelBurner',
    name: 'FUEL Buy & Burn',
    address: CONTRACTS[5].address,
    sourcify: 'exact_match',
    verifiedAt: null,
    sourcePath: 'docs/provenance/sources/fuelBurner/TokenBuyAndBurn.sol',
    notes: 'Receives 25% of distributed mint fees.',
  },
  {
    key: 'moreBurner',
    name: 'MORE Buy & Burn',
    address: CONTRACTS[6].address,
    sourcify: 'exact_match',
    verifiedAt: null,
    sourcePath: 'docs/provenance/sources/moreBurner/MoreBurner.sol',
    notes: 'Receives 30% of distributed mint fees. Not the MORE token.',
  },
  {
    key: 'moreStaking',
    name: 'MORE Staking',
    address: MORE_STAKING,
    sourcify: 'exact_match',
    verifiedAt: null,
    sourcePath: 'docs/provenance/sources/moreStaking/rhmoreteststk.sol',
    notes: 'Early/late exit penalties recycle into the reward pool.',
  },
]

export function feeSplitTotalBps(entries = FEE_SPLIT): number {
  return entries.reduce((sum, entry) => sum + entry.bps, 0)
}

export type FeeSplitAllocation = {
  shares: Array<{
    key: (typeof FEE_SPLIT)[number]['key']
    label: string
    percent: string
    bps: number
    share: bigint
  }>
  remainder: bigint
}

/**
 * Integer BPS allocation of a quoted ETH fee. Null in, null out — a failed
 * quote is never replaced with zero shares. Remainder is truncated wei from
 * integer division and must stay visible when nonzero.
 */
export function allocateFeeSplit(amount: bigint | null): FeeSplitAllocation | null {
  if (amount === null) return null
  if (amount < 0n) throw new Error('Invalid fee amount')
  const shares = FEE_SPLIT.map((entry) => ({
    key: entry.key,
    label: entry.label,
    percent: entry.percent,
    bps: entry.bps,
    share: (amount * BigInt(entry.bps)) / BigInt(FEE_SPLIT_BPS_DENOM),
  }))
  const allocated = shares.reduce((sum, entry) => sum + entry.share, 0n)
  return { shares, remainder: amount - allocated }
}

/** Late-claim penalty percent from Token._penalty (verified source). */
export function lateClaimPenaltyPct(secsLate: number): number {
  if (!Number.isFinite(secsLate) || secsLate < 0) throw new Error('Invalid lateness')
  const daysLate = Math.floor(secsLate / 86_400)
  if (daysLate > WITHDRAWAL_WINDOW_DAYS - 1) return MAX_PENALTY_PCT
  const penalty = Math.floor((2 ** (daysLate + 3)) / WITHDRAWAL_WINDOW_DAYS) - 1
  return Math.min(penalty, MAX_PENALTY_PCT)
}
