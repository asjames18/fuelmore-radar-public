import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import {
  trailingStats, projectSupply, projectBurns, projectSupplies, projectPrices, projectLiquidity,
  tokens, formatTokens, formatUsd,
  FUEL_BURN_SHARE, MORE_BURN_SHARE,
} from './speculation'

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
    avgMintsPerDay: 10, mintFeeEth: 0.01,
    fuelPriceNative: 0.0001, morePriceNative: 0.001,
    startDate: '2026-09-19', horizonDays: 30,
  }
  it('applies the verified fee split and converts at native prices', () => {
    expect(FUEL_BURN_SHARE).toBe(0.25)
    expect(MORE_BURN_SHARE).toBe(0.30)
    const result = projectBurns(base)
    expect(result).not.toBeNull()
    const { points, pace } = result!
    // 10 mints/day × 0.01 ETH = 0.1 ETH/day in fees
    expect(pace.ethToFuelBurnerPerDay).toBeCloseTo(0.025, 12)
    expect(pace.ethToMoreBurnerPerDay).toBeCloseTo(0.03, 12)
    expect(pace.fuelPerDay).toBeCloseTo(250, 9)
    expect(pace.morePerDay).toBeCloseTo(30, 9)
    expect(points).toHaveLength(30)
    expect(points[0].fuel).toBeCloseTo(50250, 6)
    expect(points[0].more).toBeCloseTo(1030, 6)
    expect(points[29].fuel).toBeCloseTo(57500, 6)
    expect(points[29].more).toBeCloseTo(1900, 6)
  })
  it('emits a gap (null), not a flat line, when one token price is unavailable', () => {
    const result = projectBurns({ ...base, morePriceNative: null })
    expect(result).not.toBeNull()
    expect(result!.pace.morePerDay).toBeNull()
    expect(result!.pace.fuelPerDay).toBeCloseTo(250, 9)
    // The MORE pace is unknown: every projected point is a gap, while the
    // ETH pace to the burner is still reported honestly.
    expect(result!.points[0].more).toBeNull()
    expect(result!.points[0].fuel).toBeCloseTo(50250, 6)
    expect(result!.pace.ethToMoreBurnerPerDay).toBeCloseTo(0.03, 12)
  })
  it('returns null when the projection cannot be computed honestly', () => {
    expect(projectBurns({ ...base, mintFeeEth: 0 })).toBeNull()
    expect(projectBurns({ ...base, avgMintsPerDay: 0 })).toBeNull()
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
    { date: '2026-09-20', fuelScheduled: 1_000_000, fuelPaced: 1_100_000, more: 500_000 },
    { date: '2026-09-21', fuelScheduled: 2_000_000, fuelPaced: 1_200_000, more: 490_000 },
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
      supplies: [{ date: '2026-09-20', fuelScheduled: null, fuelPaced: 1_100_000, more: null }],
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
    { date: '2026-09-20', fuelScheduled: 1_000_000, fuelPaced: 1_100_000, more: 500_000 },
    { date: '2026-09-21', fuelScheduled: 2_000_000, fuelPaced: 1_200_000, more: 250_000 },
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
