import { formatUnits } from 'viem'

/**
 * Speculation math: aggregate supply and burn projections built only from
 * live, observable on-chain numbers. Every input is listed in the
 * Speculation view's assumptions panel; nothing here is a prediction.
 *
 * Invariants:
 * - Any missing or invalid input yields null (never zero) so data gaps
 *   render as gaps, not as flat lines.
 * - The 45/25/30 fee split is source-verified via a Sourcify exact match on
 *   the FeeDistributor (not a security audit); the split itself is read from
 *   the deployed contract's behavior, and the percentages are constants here
 *   only because the distributor code fixes them.
 * - Mint positions mature on a deterministic schedule from mint terms, but
 *   the FUEL reward per position is NOT fixed at mint time — it grows with
 *   network participation. Scheduled unlock amounts therefore value each
 *   maturing position at the trailing average claim size and are labeled as
 *   estimates, not guarantees.
 */

export type ActivityDay = { date: string; mints: number; claims: number; claimedFuel: string }
export type MaturityDay = { date: string; scheduled: number }

export type TrailingStats = {
  /** Complete UTC days used (the latest, incomplete day is always excluded). */
  daysUsed: number
  avgMintsPerDay: number
  avgClaimsPerDay: number
  /** FUEL entering supply per day via reward claims, in whole tokens. */
  avgClaimedPerDay: number
  /** Average FUEL per reward claim, in whole tokens. null when no claims were observed. */
  avgClaimSize: number | null
}

export function trailingStats(days: ActivityDay[]): TrailingStats | null {
  const complete = days.slice(0, -1)
  if (complete.length === 0) return null
  let mints = 0, claims = 0, claimed = 0
  for (const day of complete) {
    if (!Number.isFinite(day.mints) || !Number.isFinite(day.claims) || day.mints < 0 || day.claims < 0) return null
    const amount = Number(day.claimedFuel)
    if (!Number.isFinite(amount) || amount < 0) return null
    mints += day.mints
    claims += day.claims
    claimed += amount
  }
  const n = complete.length
  return {
    daysUsed: n,
    avgMintsPerDay: mints / n,
    avgClaimsPerDay: claims / n,
    avgClaimedPerDay: claimed / n,
    avgClaimSize: claims > 0 ? claimed / claims : null,
  }
}

export type SupplyPoint = {
  date: string
  /** Cumulative FUEL from the known maturity schedule, valued at the trailing average claim size. */
  scheduled: number
  /** Cumulative FUEL if the trailing daily claim pace simply continues. */
  paced: number
}

/**
 * Project FUEL entering supply over the horizon. Both series are cumulative
 * additions to the current supply — two lenses, not stacked:
 * - scheduled: deterministic maturity dates × estimated (not fixed) reward size
 * - paced: trailing daily claimed FUEL extended forward
 */
export function projectSupply(args: {
  maturityDays: MaturityDay[]
  startDate: string
  horizonDays?: number
  avgClaimSize: number | null
  avgClaimedPerDay: number | null
}): SupplyPoint[] | null {
  const { maturityDays, startDate, horizonDays = 365, avgClaimSize, avgClaimedPerDay } = args
  if (avgClaimSize === null || avgClaimedPerDay === null) return null
  if (!Number.isFinite(avgClaimSize) || !Number.isFinite(avgClaimedPerDay) || avgClaimSize < 0 || avgClaimedPerDay < 0) return null
  const start = Date.parse(`${startDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 730) return null
  const scheduledByDate = new Map<string, number>()
  for (const day of maturityDays) {
    if (!Number.isInteger(day.scheduled) || day.scheduled < 0) return null
    scheduledByDate.set(day.date, day.scheduled)
  }
  const points: SupplyPoint[] = []
  let scheduled = 0
  let paced = 0
  for (let i = 1; i <= horizonDays; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10)
    scheduled += (scheduledByDate.get(date) ?? 0) * avgClaimSize
    paced += avgClaimedPerDay
    points.push({ date, scheduled, paced })
  }
  return points
}

export type BurnInputs = {
  fuelBurntNow: bigint
  moreBurntNow: bigint
  avgMintsPerDay: number
  /** Current mint fee in ETH (whole ETH, not wei). */
  mintFeeEth: number
  /** Current token prices in WETH (Dexscreener priceNative). null = token pace unavailable. */
  fuelPriceNative: number | null
  morePriceNative: number | null
  startDate: string
  horizonDays?: number
}

export type BurnPoint = {
  date: string
  /** Cumulative FUEL burned: observed to date + projected at the current pace. */
  fuel: number
  /** Cumulative MORE burned: observed to date + projected at the current pace. */
  more: number
}

export type BurnPace = {
  /** ETH per day routed to each burner at the current mint pace. */
  ethToFuelBurnerPerDay: number
  ethToMoreBurnerPerDay: number
  /** Estimated tokens burned per day at current native prices. null when the price is unavailable. */
  fuelPerDay: number | null
  morePerDay: number | null
}

/** Verified FeeDistributor split: 25% of mint fees buy & burn FUEL, 30% buy & burn MORE. */
export const FUEL_BURN_SHARE = 0.25
export const MORE_BURN_SHARE = 0.30

/**
 * Project cumulative burns. The burners receive ETH (a fixed share of each
 * mint fee) and use it to buy and burn tokens, so the daily burn pace is the
 * mint pace × mint fee × share, converted at current native prices. Execution
 * prices, slippage, and participation can all move — this extends today's
 * observable pace, it does not predict it.
 */
export function projectBurns(inputs: BurnInputs): { points: BurnPoint[]; pace: BurnPace } | null {
  const { fuelBurntNow, moreBurntNow, avgMintsPerDay, mintFeeEth, fuelPriceNative, morePriceNative, startDate, horizonDays = 365 } = inputs
  if (fuelBurntNow < 0n || moreBurntNow < 0n) return null
  if (!Number.isFinite(avgMintsPerDay) || !Number.isFinite(mintFeeEth) || avgMintsPerDay <= 0 || mintFeeEth <= 0) return null
  const start = Date.parse(`${startDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 730) return null
  const ethPerDay = avgMintsPerDay * mintFeeEth
  const fuelPerDay = fuelPriceNative !== null && fuelPriceNative > 0 ? (ethPerDay * FUEL_BURN_SHARE) / fuelPriceNative : null
  const morePerDay = morePriceNative !== null && morePriceNative > 0 ? (ethPerDay * MORE_BURN_SHARE) / morePriceNative : null
  if (fuelPerDay === null && morePerDay === null) return null
  const pace: BurnPace = {
    ethToFuelBurnerPerDay: ethPerDay * FUEL_BURN_SHARE,
    ethToMoreBurnerPerDay: ethPerDay * MORE_BURN_SHARE,
    fuelPerDay,
    morePerDay,
  }
  let fuel = Number(formatUnits(fuelBurntNow, 18))
  let more = Number(formatUnits(moreBurntNow, 18))
  if (!Number.isFinite(fuel) || !Number.isFinite(more)) return null
  const points: BurnPoint[] = []
  for (let i = 1; i <= horizonDays; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10)
    fuel += fuelPerDay ?? 0
    more += morePerDay ?? 0
    points.push({ date, fuel, more })
  }
  return { points, pace }
}

/** Whole-token number from a wei bigint for chart math and display. */
export function tokens(wei: bigint | null): number | null {
  if (wei === null || wei < 0n) return null
  const value = Number(formatUnits(wei, 18))
  return Number.isFinite(value) ? value : null
}

/** Compact whole-token formatting for projection figures (e.g. 1.24M). */
export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return value.toFixed(value < 10 && value !== 0 ? 2 : 0)
}
