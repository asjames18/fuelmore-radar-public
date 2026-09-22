import { describe, expect, it } from 'vitest'
import {
  CLAIM_FEE_BPS,
  CONTRACT_PROVENANCE,
  FEE_SPLIT,
  FEE_SPLIT_BPS_DENOM,
  feeSplitTotalBps,
  lateClaimPenaltyPct,
  MAX_PENALTY_PCT,
  allocateFeeSplit,
} from './provenance'
import { CONTRACTS } from './contracts'
import { MORE_STAKING } from './more'

describe('contract provenance registry', () => {
  it('covers every configured registry address plus MORE staking', () => {
    const addresses = new Set(CONTRACT_PROVENANCE.map(entry => entry.address.toLowerCase()))
    for (const contract of CONTRACTS) expect(addresses.has(contract.address.toLowerCase())).toBe(true)
    expect(addresses.has(MORE_STAKING.toLowerCase())).toBe(true)
  })

  it('keeps MORE token marked unverified while FeeDistributor is exact_match', () => {
    expect(CONTRACT_PROVENANCE.find(entry => entry.key === 'more')?.sourcify).toBe('unverified')
    expect(CONTRACT_PROVENANCE.find(entry => entry.key === 'distributor')?.sourcify).toBe('exact_match')
    expect(CONTRACT_PROVENANCE.find(entry => entry.key === 'fuel')?.sourcify).toBe('exact_match')
  })

  it('encodes the verified 45/25/30 fee split', () => {
    expect(feeSplitTotalBps()).toBe(FEE_SPLIT_BPS_DENOM)
    expect(FEE_SPLIT.map(entry => entry.bps)).toEqual([4500, 2500, 3000])
    expect(CLAIM_FEE_BPS).toBe(2500)
  })

  it('matches Token._penalty for late claim days', () => {
    expect(lateClaimPenaltyPct(0)).toBe(0)
    expect(lateClaimPenaltyPct(86_400)).toBe(1) // day 1: 2^4/7 - 1 = 1
    expect(lateClaimPenaltyPct(2 * 86_400)).toBe(3) // 2^5/7 - 1 = 3
    expect(lateClaimPenaltyPct(6 * 86_400)).toBe(72) // 2^9/7 - 1 = 72
    expect(lateClaimPenaltyPct(7 * 86_400)).toBe(MAX_PENALTY_PCT)
  })

  it('allocates quoted fees by verified BPS without turning a failed quote into zero', () => {
    expect(allocateFeeSplit(null)).toBeNull()
    const split = allocateFeeSplit(10_000n)
    expect(split?.shares.map(entry => entry.share)).toEqual([4500n, 2500n, 3000n])
    expect(split?.remainder).toBe(0n)
    expect(allocateFeeSplit(1n)?.remainder).toBe(1n)
  })
})
