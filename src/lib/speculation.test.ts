import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import {
  trailingStats, projectSupply, projectBurns, tokens, formatTokens,
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
  it('keeps the ETH pace when one token price is unavailable', () => {
    const result = projectBurns({ ...base, morePriceNative: null })
    expect(result).not.toBeNull()
    expect(result!.pace.morePerDay).toBeNull()
    expect(result!.pace.fuelPerDay).toBeCloseTo(250, 9)
    expect(result!.points[0].more).toBe(1000)
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
