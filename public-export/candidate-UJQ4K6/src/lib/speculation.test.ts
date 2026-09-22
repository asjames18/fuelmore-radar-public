import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import {
  trailingStats, projectSupply, projectNetSupply, projectBurns, projectSupplies, projectPrices, projectLiquidity,
  tokens, formatTokens, formatUsd,
  todayPartialStats, detectClaimRegimeChange, observedBurnPace,
  supplyVelocityWarning,
  FUEL_BURN_SHARE, MORE_BURN_SHARE,
} from './speculation'
import type { ActivityDay } from './speculation'

const E18 = 10n ** 18n
const days = (n: number) => Array.from({ length: n }, (_, i) => ({
  date: `2026-09-${String(10 + i).padStart(2, '0')}`,
  mints: 10, claims: 5, claimedFuel: '1000',
}))

describe('trailingStats', () => {
  it('averages complete days and excludes the incomplete latest day', () => {
    const stats = trailingStats([...days(7), { date: '2026-09-17', mints: 999, claims: 999, claimedFuel: '999999' }])
    expect(stats).not.toBeNull()
    expect(stats!.daysUsed).toBe(7)
    expect(stats!.avgMintsPerDay).toBe(10)
    expect(stats!.avgClaimsPerDay).toBe(5)
    expect(stats!.avgClaimedPerDay).toBe(1000)
    expect(stats!.avgClaimSize).toBe(200)
  })
  it('returns null with no complete days or invalid data', () => {
    expect(trailingStats([])).toBeNull()
    expect(trailingStats([{ date: '2026-09-17', mints: 1, claims: 1, claimedFuel: '10' }])).toBeNull()
    expect(trailingStats([{ date: '2026-09-09', mints: 1, claims: 1, claimedFuel: 'NaN' }, ...days(2), { date: '2026-09-17', mints: 1, claims: 1, claimedFuel: '10' }])).toBeNull()
    expect(trailingStats([{ date: '2026-09-15', mints: -1, claims: 1, claimedFuel: '10' }, ...days(2).slice(0, 1), { date: '2026-09-17', mints: 1, claims: 1, claimedFuel: '10' }])).toBeNull()
  })
  it('leaves average claim size unknown when nothing was claimed', () => {
    const quiet = days(3).map(d => ({ ...d, claims: 0, claimedFuel: '0' }))
    const stats = trailingStats([...quiet, { date: '2026-09-17', mints: 0, claims: 0, claimedFuel: '0' }])
    expect(stats!.avgClaimSize).toBeNull()
    expect(stats!.avgClaimedPerDay).toBe(0)
  })
})

describe('projectSupply', () => {
  const maturity = [
    { date: '2026-09-20', scheduled: 4 },
    { date: '2026-09-25', scheduled: 6 },
  ]
  it('builds cumulative scheduled and paced series from the start date', () => {
    const points = projectSupply({ maturityDays: maturity, startDate: '2026-09-19', horizonDays: 10, avgClaimSize: 200, avgClaimedPerDay: 1000 })
    expect(points).not.toBeNull()
    expect(points!).toHaveLength(10)
    expect(points![0]).toEqual({ date: '2026-09-20', scheduled: 800, paced: 1000 })
    expect(points![4]).toEqual({ date: '2026-09-24', scheduled: 800, paced: 5000 })
    expect(points![5]).toEqual({ date: '2026-09-25', scheduled: 2000, paced: 6000 })
    expect(points![9]).toEqual({ date: '2026-09-29', scheduled: 2000, paced: 10000 })
  })
  it('returns null when an input is missing or invalid', () => {
    const base = { maturityDays: maturity, startDate: '2026-09-19', horizonDays: 10, avgClaimSize: 200, avgClaimedPerDay: 1000 }
    expect(projectSupply({ ...base, avgClaimSize: null })).toBeNull()
    expect(projectSupply({ ...base, avgClaimedPerDay: null })).toBeNull()
    expect(projectSupply({ ...base, startDate: 'not-a-date' })).toBeNull()
    expect(projectSupply({ ...base, maturityDays: [{ date: '2026-09-20', scheduled: -1 }] })).toBeNull()
    expect(projectSupply({ ...base, horizonDays: 0 })).toBeNull()
  })
})

describe('projectBurns', () => {
  const base = {
    fuelBurntNow: 50_000n * E18, moreBurntNow: 1_000n * E18,
    avgMintsPerDay: 10, avgClaimsPerDay: 5, mintFeeEth: 0.01, claimFeeEth: 0.005,
    fuelPriceNative: 0.0001, morePriceNative: 0.001,
    startDate: '2026-09-19', horizonDays: 30,
  }
  it('applies the verified fee split and converts at native prices', () => {
    expect(FUEL_BURN_SHARE).toBe(0.25)
    expect(MORE_BURN_SHARE).toBe(0.30)
    const result = projectBurns(base)
    expect(result).not.toBeNull()
    const { points, pace } = result!
    // (10 mints × 0.01 + 5 claims × 0.005) = 0.125 ETH/day in routed fees
    expect(pace.ethToFuelBurnerPerDay).toBeCloseTo(0.03125, 12)
    expect(pace.ethToMoreBurnerPerDay).toBeCloseTo(0.0375, 12)
    expect(pace.fuelPerDay).toBeCloseTo(312.5, 9)
    expect(pace.morePerDay).toBeCloseTo(37.5, 9)
    expect(points).toHaveLength(30)
    expect(points[0].fuel).toBeCloseTo(50312.5, 6)
    expect(points[0].more).toBeCloseTo(1037.5, 6)
    expect(points[29].fuel).toBeCloseTo(59375, 6)
    expect(points[29].more).toBeCloseTo(2125, 6)
  })
  it('emits a gap (null), not a flat line, when one token price is unavailable', () => {
    const result = projectBurns({ ...base, morePriceNative: null })
    expect(result).not.toBeNull()
    expect(result!.pace.morePerDay).toBeNull()
    expect(result!.pace.fuelPerDay).toBeCloseTo(312.5, 9)
    // The MORE pace is unknown: every projected point is a gap, while the
    // ETH pace to the burner is still reported honestly.
    expect(result!.points[0].more).toBeNull()
    expect(result!.points[0].fuel).toBeCloseTo(50312.5, 6)
    expect(result!.pace.ethToMoreBurnerPerDay).toBeCloseTo(0.0375, 12)
  })
  it('returns null when the projection cannot be computed honestly', () => {
    expect(projectBurns({ ...base, mintFeeEth: 0 })).toBeNull()
    expect(projectBurns({ ...base, avgMintsPerDay: 0 })).toBeNull()
    expect(projectBurns({ ...base, avgClaimsPerDay: -1 })).toBeNull()
    expect(projectBurns({ ...base, claimFeeEth: -0.1 })).toBeNull()
    expect(projectBurns({ ...base, fuelPriceNative: null, morePriceNative: null })).toBeNull()
    expect(projectBurns({ ...base, fuelPriceNative: 0, morePriceNative: -1 })).toBeNull()
    expect(projectBurns({ ...base, startDate: 'bad' })).toBeNull()
    expect(projectBurns({ ...base, fuelBurntNow: -1n })).toBeNull()
  })
})

describe('projectSupplies', () => {
  const supply = [
    { date: '2026-09-20', scheduled: 100, paced: 50 },
    { date: '2026-09-21', scheduled: 250, paced: 100 },
  ]
  // Day-1 burn point = observed (1000) + one day's pace (30); pace repeats.
  const burns = {
    pace: { ethToFuelBurnerPerDay: 0.025, ethToMoreBurnerPerDay: 0.03, fuelPerDay: 250, morePerDay: 30 },
    points: [
      { date: '2026-09-20', fuel: 50250, more: 1030 },
      { date: '2026-09-21', fuel: 50500, more: 1060 },
    ],
  }
  it('subtracts the first projected burn day: day-1 supply is current minus one day of burns', () => {
    const out = projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply, burns })
    expect(out).toHaveLength(2)
    // FUEL anchors at current supply plus cumulative new inflows.
    expect(out![0].fuelScheduled).toBe(1_000_100)
    expect(out![0].fuelPaced).toBe(1_000_050)
    expect(out![1].fuelScheduled).toBe(1_000_250)
    // MORE anchors at current supply minus cumulative new projected burns,
    // starting with day 1's pace — not with "no burns subtracted yet".
    expect(out![0].more).toBeCloseTo(499_970, 9)
    expect(out![1].more).toBeCloseTo(499_940, 9)
  })
  it('emits gaps for whichever side lacks inputs, never zero', () => {
    const noBurns = projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply, burns: null })
    expect(noBurns![0].fuelScheduled).toBe(1_000_100)
    expect(noBurns![0].more).toBeNull()
    const noSupply = projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply: null, burns })
    expect(noSupply![0].fuelScheduled).toBeNull()
    expect(noSupply![0].more).toBeCloseTo(499_970, 9)
    const noBaseline = projectSupplies({ fuelSupply: 1_000_000, moreSupply: null, supply, burns })
    expect(noBaseline![0].more).toBeNull()
  })
  it('keeps the MORE series as a gap when the burn pace is unknown', () => {
    const gapped = {
      pace: { ethToFuelBurnerPerDay: 0.025, ethToMoreBurnerPerDay: 0.03, fuelPerDay: 250, morePerDay: null },
      points: [
        { date: '2026-09-20', fuel: 50250, more: null },
        { date: '2026-09-21', fuel: 50500, more: null },
      ],
    }
    const out = projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply, burns: gapped })
    expect(out![0].more).toBeNull()
    expect(out![1].more).toBeNull()
  })
  it('uses the longer of the two series and returns null when both are empty', () => {
    const short = projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply: null, burns })
    expect(short).toHaveLength(2)
    expect(short![1].date).toBe('2026-09-21')
    expect(projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply: null, burns: null })).toBeNull()
    expect(projectSupplies({ fuelSupply: 1_000_000, moreSupply: 500_000, supply: [], burns: { pace: burns.pace, points: [] } })).toBeNull()
  })
})

describe('projectPrices', () => {
  const supplies = [
    { date: '2026-09-20', fuelScheduled: 1_000_000, fuelPaced: 1_100_000, fuelNet: null, fuelNetRecent: null, more: 500_000 },
    { date: '2026-09-21', fuelScheduled: 2_000_000, fuelPaced: 1_200_000, fuelNet: null, fuelNetRecent: null, more: 490_000 },
  ]
  it('implies price as marketCap / futureSupply per scenario path', () => {
    const points = projectPrices({ fuelMarketCapUsd: 10_000_000, moreMarketCapUsd: 5_000_000, supplies })
    expect(points).not.toBeNull()
    expect(points!).toHaveLength(2)
    expect(points![0].fuelScheduled).toBeCloseTo(10, 9)
    expect(points![0].fuelPaced).toBeCloseTo(9.090909, 6)
    expect(points![0].more).toBeCloseTo(10, 9)
    expect(points![1].fuelScheduled).toBeCloseTo(5, 9)
    expect(points![1].more).toBeCloseTo(10.2040816, 6)
  })
  it('leaves gaps where a market cap or supply is unknown', () => {
    const points = projectPrices({
      fuelMarketCapUsd: null, moreMarketCapUsd: 5_000_000,
      supplies: [{ date: '2026-09-20', fuelScheduled: null, fuelPaced: 1_100_000, fuelNet: null, fuelNetRecent: null, more: null }],
    })
    expect(points).not.toBeNull()
    expect(points![0].fuelScheduled).toBeNull()
    expect(points![0].fuelPaced).toBeNull()
    expect(points![0].more).toBeNull()
  })
  it('returns null when nothing can be computed honestly', () => {
    expect(projectPrices({ fuelMarketCapUsd: null, moreMarketCapUsd: null, supplies })).toBeNull()
    expect(projectPrices({ fuelMarketCapUsd: 0, moreMarketCapUsd: -5, supplies })).toBeNull()
    expect(projectPrices({ fuelMarketCapUsd: 1, moreMarketCapUsd: 1, supplies: [] })).toBeNull()
  })
})

describe('projectLiquidity', () => {
  const supplies = [
    { date: '2026-09-20', fuelScheduled: 1_000_000, fuelPaced: 1_100_000, fuelNet: null, fuelNetRecent: null, more: 500_000 },
    { date: '2026-09-21', fuelScheduled: 2_000_000, fuelPaced: 1_200_000, fuelNet: null, fuelNetRecent: null, more: 250_000 },
  ]
  const base = { fuelLiquidityUsd: 200_000, moreLiquidityUsd: 100_000, fuelSupplyNow: 1_000_000, moreSupplyNow: 500_000, supplies }
  it('holds the flat baseline and scales illustratively with supply', () => {
    const points = projectLiquidity(base)
    expect(points).not.toBeNull()
    expect(points!).toHaveLength(2)
    expect(points![0].fuelFlat).toBe(200_000)
    expect(points![0].fuelScaled).toBe(200_000)
    expect(points![1].fuelScaled).toBe(400_000)
    expect(points![1].moreFlat).toBe(100_000)
    expect(points![1].moreScaled).toBe(50_000)
  })
  it('keeps the flat baseline when the supply base is unknown', () => {
    const points = projectLiquidity({ ...base, fuelSupplyNow: null })
    expect(points).not.toBeNull()
    expect(points![0].fuelFlat).toBe(200_000)
    expect(points![0].fuelScaled).toBeNull()
  })
  it('returns null when no liquidity snapshot exists', () => {
    expect(projectLiquidity({ ...base, fuelLiquidityUsd: null, moreLiquidityUsd: null })).toBeNull()
    expect(projectLiquidity({ ...base, supplies: [] })).toBeNull()
  })
})

describe('formatUsd', () => {
  it('formats compactly and never invents a value', () => {
    expect(formatUsd(1_234_567)).toBe('$1.23M')
    expect(formatUsd(999)).toBe('$999.00')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(NaN)).toBe('—')
  })
  it('keeps tiny prices readable instead of rounding to $0.0000', () => {
    expect(formatUsd(0.00003823)).toBe('$0.000038')
    expect(formatUsd(0.004683)).toBe('$0.0047')
  })
})

describe('tokens and formatTokens', () => {
  it('converts wei bigints without precision loss at display scale', () => {
    expect(tokens(1_234_567n * E18)).toBe(1234567)
    expect(tokens(null)).toBeNull()
    expect(tokens(-1n)).toBeNull()
  })
  it('formats compactly and never invents a value', () => {
    expect(formatTokens(1_234_567)).toBe('1.23M')
    expect(formatTokens(2_500_000_000)).toBe('2.50B')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(null)).toBe('—')
    expect(formatTokens(NaN)).toBe('—')
  })
  it('round-trips parseUnits through tokens', () => {
    expect(tokens(parseUnits('1234.5', 18))).toBeCloseTo(1234.5, 9)
  })
})

describe('trailingStats with a window', () => {
  it('averages only the most recent complete days when windowDays is given', () => {
    const quiet = days(5)
    const busy = [
      { date: '2026-09-15', mints: 100, claims: 50, claimedFuel: '10000' },
      { date: '2026-09-16', mints: 100, claims: 50, claimedFuel: '10000' },
    ]
    const all = [...quiet, ...busy, { date: '2026-09-17', mints: 999, claims: 999, claimedFuel: '999999' }]
    const full = trailingStats(all)!
    const recent = trailingStats(all, 2)!
    expect(full.daysUsed).toBe(7)
    expect(full.avgMintsPerDay).toBeCloseTo((50 + 200) / 7, 9)
    expect(recent.daysUsed).toBe(2)
    expect(recent.avgMintsPerDay).toBe(100)
    expect(recent.avgClaimedPerDay).toBe(10000)
  })
  it('returns null for an invalid window', () => {
    expect(trailingStats(days(3), 0)).toBeNull()
    expect(trailingStats(days(3), -2)).toBeNull()
    expect(trailingStats(days(3), 1.5)).toBeNull()
  })
  it('uses the whole history when the window is longer than the history', () => {
    const stats = trailingStats(days(3), 30)!
    expect(stats.daysUsed).toBe(2)
  })
})

describe('projectNetSupply', () => {
  const base = { fuelSupply: 1_000_000, claimedPerDay: 1000, burnPerDay: 250, startDate: '2026-09-19', horizonDays: 3 }
  it('adds cumulative net flow (claims in, burns out) to current supply', () => {
    const result = projectNetSupply(base)!
    expect(result.points).toHaveLength(3)
    expect(result.points[0]).toEqual({ date: '2026-09-20', supply: 1_000_750 })
    expect(result.points[2]).toEqual({ date: '2026-09-22', supply: 1_002_250 })
    expect(result.depletedAt).toBeNull()
  })
  it('excludes burns when the burn pace is unknown instead of failing', () => {
    const result = projectNetSupply({ ...base, burnPerDay: null })!
    expect(result.points[0].supply).toBe(1_001_000)
    expect(result.points[2].supply).toBe(1_003_000)
    expect(result.depletedAt).toBeNull()
  })
  it('gaps the series at the zero-crossing instead of drawing negative supply', () => {
    // 1,000 supply, net −400/day: crosses zero on day 3 (2026-09-22).
    const result = projectNetSupply({ fuelSupply: 1000, claimedPerDay: 100, burnPerDay: 500, startDate: '2026-09-19', horizonDays: 5 })!
    expect(result.points.map(p => p.supply)).toEqual([600, 200, null, null, null])
    expect(result.depletedAt).toBe('2026-09-22')
  })
  it('never emits a negative supply value', () => {
    const result = projectNetSupply({ fuelSupply: 942_500, claimedPerDay: 0, burnPerDay: 34_200, startDate: '2026-09-21', horizonDays: 365 })!
    expect(result.points.every(p => p.supply === null || p.supply > 0)).toBe(true)
    expect(result.depletedAt).not.toBeNull()
  })
  it('returns null when supply or claim pace is unknown or invalid', () => {
    expect(projectNetSupply({ ...base, fuelSupply: null })).toBeNull()
    expect(projectNetSupply({ ...base, claimedPerDay: null })).toBeNull()
    expect(projectNetSupply({ ...base, fuelSupply: -1 })).toBeNull()
    expect(projectNetSupply({ ...base, burnPerDay: -5 })).toBeNull()
    expect(projectNetSupply({ ...base, startDate: 'not-a-date' })).toBeNull()
    expect(projectNetSupply({ ...base, horizonDays: 0 })).toBeNull()
  })
})

describe('projectSupplies with net trajectories', () => {
  const net = {
    points: [
      { date: '2026-09-20', supply: 1_000_750 },
      { date: '2026-09-21', supply: 1_001_500 },
    ],
    depletedAt: null,
  }
  const netRecent = {
    points: [
      { date: '2026-09-20', supply: 1_001_000 },
      { date: '2026-09-21', supply: 1_002_000 },
    ],
    depletedAt: null,
  }
  it('maps net paths onto the shared date axis and gaps mismatched dates', () => {
    const out = projectSupplies({ fuelSupply: 1_000_000, moreSupply: null, supply: null, burns: null, net, netRecent })!
    expect(out).toHaveLength(2)
    expect(out[0].fuelNet).toBe(1_000_750)
    expect(out[1].fuelNetRecent).toBe(1_002_000)
    expect(out[0].fuelScheduled).toBeNull()
    const shifted = projectSupplies({ fuelSupply: 1_000_000, moreSupply: null, supply: [{ date: '2026-09-20', scheduled: 0, paced: 0 }, { date: '2026-09-21', scheduled: 0, paced: 0 }], burns: null, net: { points: [{ date: '2026-09-21', supply: 5 }], depletedAt: null }, netRecent: null })!
    // The net series only covers the second axis date, so the first row gaps
    // rather than borrowing the 2026-09-21 value, and the missing tail gaps.
    expect(shifted).toHaveLength(2)
    expect(shifted[0].date).toBe('2026-09-20')
    expect(shifted[0].fuelNet).toBeNull()
    expect(shifted[1].fuelNet).toBeNull()
  })
  it('carries depletion gaps through as nulls, never negative supplies', () => {
    const depleted = {
      points: [
        { date: '2026-09-20', supply: 600 },
        { date: '2026-09-21', supply: null },
      ],
      depletedAt: '2026-09-21',
    }
    const out = projectSupplies({ fuelSupply: 1000, moreSupply: null, supply: null, burns: null, net: depleted, netRecent: null })!
    expect(out[0].fuelNet).toBe(600)
    expect(out[1].fuelNet).toBeNull()
  })
  it('stays null when every series is empty, even with net args present', () => {
    expect(projectSupplies({ fuelSupply: 1_000_000, moreSupply: null, supply: null, burns: null, net: { points: [], depletedAt: null }, netRecent: { points: [], depletedAt: null } })).toBeNull()
  })
})

describe('projectPrices on net paths', () => {
  it('implies price from the net trajectory like any other path', () => {
    const points = projectPrices({
      fuelMarketCapUsd: 10_000_000, moreMarketCapUsd: null,
      supplies: [{ date: '2026-09-20', fuelScheduled: null, fuelPaced: null, fuelNet: 2_000_000, fuelNetRecent: 4_000_000, more: null }],
    })!
    expect(points[0].fuelNet).toBeCloseTo(5, 9)
    expect(points[0].fuelNetRecent).toBeCloseTo(2.5, 9)
    expect(points[0].fuelScheduled).toBeNull()
  })
})

describe('projectLiquidity on the net path', () => {
  it('scales liquidity on the net trajectory when present', () => {
    const base = {
      fuelLiquidityUsd: 1000, moreLiquidityUsd: null, fuelSupplyNow: 1_000_000, moreSupplyNow: null,
      supplies: [{ date: '2026-09-20', fuelScheduled: null, fuelPaced: null, fuelNet: 1_250_000, fuelNetRecent: null, more: null }],
    }
    const points = projectLiquidity(base)!
    expect(points[0].fuelFlat).toBe(1000)
    expect(points[0].fuelScaled).toBeNull()
    expect(points[0].fuelNetScaled).toBeCloseTo(1250, 9)
  })
})

describe('todayPartialStats', () => {
  const day = (date: string, mints: number, claims: number, claimedFuel: string): ActivityDay => ({ date, mints, claims, claimedFuel })
  it('reports the latest day as a partial-day observation, never annualized', () => {
    const partial = todayPartialStats([
      day('2026-09-19', 10, 0, '0'),
      day('2026-09-20', 12, 0, '0'),
      day('2026-09-21', 3, 775, '261443382'),
    ])
    expect(partial).not.toBeNull()
    expect(partial!.date).toBe('2026-09-21')
    expect(partial!.claims).toBe(775)
    expect(partial!.claimedFuel).toBe(261443382)
    expect(partial!.avgClaimSize).toBeCloseTo(261443382 / 775, 9)
  })
  it('returns null for empty or invalid input', () => {
    expect(todayPartialStats([])).toBeNull()
    expect(todayPartialStats([day('2026-09-21', 1, -2, '5')])).toBeNull()
  })
})

describe('detectClaimRegimeChange', () => {
  const day = (date: string, mints: number, claims: number, claimedFuel: string): ActivityDay => ({ date, mints, claims, claimedFuel })
  const preUnlock = [
    day('2026-09-19', 10, 0, '0'),
    day('2026-09-20', 12, 0, '0'),
    day('2026-09-21', 3, 775, '261443382'),
  ]
  it('flags the first-unlock day: trailing zeros, today has claims', () => {
    const stats = trailingStats(preUnlock)!
    expect(stats.avgClaimsPerDay).toBe(0)
    const regime = detectClaimRegimeChange(preUnlock, stats)
    expect(regime.kind).toBe('claim-regime-change')
    if (regime.kind === 'claim-regime-change') expect(regime.today.claims).toBe(775)
  })
  it('stays normal once complete days carry claims', () => {
    const days = [...preUnlock, day('2026-09-22', 4, 900, '300000000')]
    const stats = trailingStats(days)!
    expect(stats.avgClaimsPerDay).toBeGreaterThan(0)
    expect(detectClaimRegimeChange(days, stats).kind).toBe('normal')
  })
  it('stays normal when today has no claims', () => {
    const stats = trailingStats(preUnlock.slice(0, 2).concat(day('2026-09-21', 3, 0, '0')))!
    expect(detectClaimRegimeChange(preUnlock.slice(0, 2).concat(day('2026-09-21', 3, 0, '0')), stats).kind).toBe('normal')
  })
})

describe('observedBurnPace', () => {
  it('returns null with fewer than two observations — never a fabricated pace', () => {
    expect(observedBurnPace([])).toBeNull()
    expect(observedBurnPace([{ fuelBurnt: 322436, moreBurnt: 1000, observedAt: Date.now() }])).toBeNull()
  })
  it('returns null when observations are less than a day apart', () => {
    const now = Date.now()
    expect(observedBurnPace([
      { fuelBurnt: 300000, moreBurnt: 900, observedAt: now - 3600_000 },
      { fuelBurnt: 322436, moreBurnt: 1000, observedAt: now },
    ])).toBeNull()
  })
  it('measures the per-day delta of the cumulative counters', () => {
    const now = Date.now()
    const pace = observedBurnPace([
      { fuelBurnt: 300000, moreBurnt: 900, observedAt: now - 2 * 86400_000 },
      { fuelBurnt: 322436, moreBurnt: 1000, observedAt: now },
    ])
    expect(pace).not.toBeNull()
    expect(pace!.fuelPerDay).toBeCloseTo(11218, 6)
    expect(pace!.morePerDay).toBeCloseTo(50, 6)
  })
  it('returns null when counters move backwards', () => {
    const now = Date.now()
    expect(observedBurnPace([
      { fuelBurnt: 322436, moreBurnt: 1000, observedAt: now - 2 * 86400_000 },
      { fuelBurnt: 300000, moreBurnt: 900, observedAt: now },
    ])).toBeNull()
  })
})

describe('projectBurns upper bound', () => {
  it('counts claim fees in the routed-fee bound', () => {
    const E18 = 10n ** 18n
    const withClaims = projectBurns({
      fuelBurntNow: 0n, moreBurntNow: 0n, avgMintsPerDay: 10, avgClaimsPerDay: 100,
      mintFeeEth: 0.01, claimFeeEth: 0.005, fuelPriceNative: 1, morePriceNative: 1,
      startDate: '2026-09-19', horizonDays: 7,
    })
    const withoutClaims = projectBurns({
      fuelBurntNow: 0n, moreBurntNow: 0n, avgMintsPerDay: 10, avgClaimsPerDay: 100,
      mintFeeEth: 0.01, claimFeeEth: null, fuelPriceNative: 1, morePriceNative: 1,
      startDate: '2026-09-19', horizonDays: 7,
    })
    // (10×0.01 + 100×0.005) = 0.6 ETH/day vs mint-only 0.1 ETH/day
    expect(withClaims!.pace.ethToFuelBurnerPerDay).toBeCloseTo(0.15, 12)
    expect(withoutClaims!.pace.ethToFuelBurnerPerDay).toBeCloseTo(0.025, 12)
    expect(E18).toBe(10n ** 18n)
  })
})

describe('supplyVelocityWarning', () => {
  const base = { supplyObservedAt: 1000000, activityThroughAt: 1000000, partialDayClaims: 100 }
  it('returns null when the snapshot is fresh (under 5 minutes)', () => {
    expect(supplyVelocityWarning({ ...base, activityThroughAt: 1000299 })).toBeNull()
  })
  it('warns when the snapshot lags the claim flow', () => {
    const w = supplyVelocityWarning({ ...base, activityThroughAt: 1000720 })
    expect(w).toContain('~12 minutes')
    expect(w).toContain('may lag actual supply')
  })
  it('returns null with no partial-day claims', () => {
    expect(supplyVelocityWarning({ ...base, partialDayClaims: 0, activityThroughAt: 1003600 })).toBeNull()
  })
  it('returns null on missing inputs, never invents a warning', () => {
    expect(supplyVelocityWarning({ ...base, supplyObservedAt: null, activityThroughAt: 1003600 })).toBeNull()
    expect(supplyVelocityWarning({ ...base, activityThroughAt: null })).toBeNull()
  })
  it('returns null when the supply read is newer than the claim flow', () => {
    expect(supplyVelocityWarning({ ...base, activityThroughAt: 999000 })).toBeNull()
  })
})
