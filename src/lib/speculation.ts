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
 *   only because the distributor code fixes them. Claim fees route through
 *   the same distributor (verified _collectClaimFee forwarding).
 * - Burn behavior is observed, not derived: the only burn pace this module
 *   trusts is the delta of timestamped burn-counter observations. The
 *   fee-routing conversion survives only as an explicitly labeled UPPER
 *   BOUND scenario — spot conversion with no slippage is never presented
 *   as executed burns, and it never feeds the net-supply trajectory.
 * - A first-unlock regime change (trailing days show zero claims, today has
 *   claims) suspends pace trajectories: the pre-unlock pace no longer
 *   describes the market, so callers show the partial-day observation and an
 *   honest-state banner instead of a false depletion path.
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

/**
 * Today's incomplete-day observation, labeled as partial. This is what
 * actually happened so far today — not a pace, not annualized, and never
 * silently blended into the trailing averages.
 */
export type PartialDayStats = {
  date: string
  mints: number
  claims: number
  /** FUEL claimed so far today, in whole tokens. */
  claimedFuel: number
  /** Average FUEL per claim so far today. null when nothing claimed yet. */
  avgClaimSize: number | null
}

export function todayPartialStats(days: ActivityDay[]): PartialDayStats | null {
  const today = days.at(-1)
  if (!today) return null
  const claimed = Number(today.claimedFuel)
  if (!Number.isFinite(today.mints) || today.mints < 0) return null
  if (!Number.isFinite(today.claims) || today.claims < 0) return null
  if (!Number.isFinite(claimed) || claimed < 0) return null
  return {
    date: today.date,
    mints: today.mints,
    claims: today.claims,
    claimedFuel: claimed,
    avgClaimSize: today.claims > 0 ? claimed / today.claims : null,
  }
}

export type RegimeState =
  | { kind: 'normal' }
  | { kind: 'claim-regime-change'; today: PartialDayStats }

/**
 * Detect the first-unlock regime change: every complete trailing day shows
 * zero claims, but today already has claims. The pre-unlock pace (zero claim
 * inflow) no longer describes the market, and any trajectory built from it —
 * e.g. burns subtracted from zero inflow, "depleting" the supply — is false.
 * Callers must not publish pace trajectories in this state; show the
 * partial-day observation and an honest-state banner instead. Trajectories
 * resume once complete days with claims are observed.
 */
export function detectClaimRegimeChange(days: ActivityDay[], stats: TrailingStats | null): RegimeState {
  const today = todayPartialStats(days)
  if (!today || today.claims === 0) return { kind: 'normal' }
  if (stats !== null && stats.avgClaimsPerDay === 0) return { kind: 'claim-regime-change', today }
  return { kind: 'normal' }
}

export function trailingStats(days: ActivityDay[], windowDays?: number): TrailingStats | null {
  const complete = days.slice(0, -1)
  // Optional trailing window: compare the recent pace (e.g. last 7 complete
  // days) against the full history to see whether activity is accelerating or
  // cooling. Undefined keeps the long-standing full-window behavior.
  const windowed = windowDays === undefined ? complete
    : !Number.isInteger(windowDays) || windowDays < 1 ? [] : complete.slice(-windowDays)
  if (windowed.length === 0) return null
  let mints = 0, claims = 0, claimed = 0
  for (const day of windowed) {
    if (!Number.isFinite(day.mints) || !Number.isFinite(day.claims) || day.mints < 0 || day.claims < 0) return null
    const amount = Number(day.claimedFuel)
    if (!Number.isFinite(amount) || amount < 0) return null
    mints += day.mints
    claims += day.claims
    claimed += amount
  }
  const n = windowed.length
  return {
    daysUsed: n,
    avgMintsPerDay: mints / n,
    avgClaimsPerDay: claims / n,
    avgClaimedPerDay: claimed / n,
    avgClaimSize: claims > 0 ? claimed / claims : null,
  }
}

export type NetSupplyPoint = { date: string; supply: number | null }

/**
 * A net-supply trajectory plus the date the flat pace would deplete the supply.
 * depletedAt is the first date the trajectory reaches zero or below; null when
 * the pace never depletes the supply within the horizon.
 */
export type NetSupplyResult = {
  points: NetSupplyPoint[]
  depletedAt: string | null
}

/**
 * FUEL net-supply trajectory: today's supply plus cumulative net flow at the
 * current pace — claimed rewards flowing in minus burns flowing out. A null
 * burn pace means burns are unknown, so they are excluded (treated as zero)
 * and the caller must label the line accordingly; a null claim pace means no
 * trajectory at all.
 *
 * A token supply cannot go negative: once the flat pace would drive the
 * trajectory to zero or below, the series gaps (null) from that date onward —
 * past the depletion point the flat-pace assumption breaks and there is
 * nothing honest to draw. The first such date is returned as depletedAt so
 * callers can say so in plain language.
 *
 * This is the page's primary forward view: where the supply is headed if what
 * is happening right now keeps happening. Not a forecast of behavior.
 */
export function projectNetSupply(args: {
  fuelSupply: number | null
  claimedPerDay: number | null
  burnPerDay: number | null
  startDate: string
  horizonDays?: number
}): NetSupplyResult | null {
  const { fuelSupply, claimedPerDay, burnPerDay, startDate, horizonDays = 365 } = args
  if (fuelSupply === null || claimedPerDay === null) return null
  if (![fuelSupply, claimedPerDay].every(v => Number.isFinite(v as number) && (v as number) >= 0)) return null
  const burn = burnPerDay === null ? 0 : burnPerDay
  if (!Number.isFinite(burn) || burn < 0) return null
  const start = Date.parse(`${startDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 730) return null
  const netPerDay = (claimedPerDay as number) - burn
  const points: NetSupplyPoint[] = []
  let depletedAt: string | null = null
  for (let i = 1; i <= horizonDays; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10)
    const supply = (fuelSupply as number) + netPerDay * i
    if (depletedAt !== null || supply <= 0) {
      // Depleted: gap from here on. Supply cannot go negative, and past the
      // zero-crossing the flat pace has nothing honest left to draw.
      if (depletedAt === null) depletedAt = date
      points.push({ date, supply: null })
    } else {
      points.push({ date, supply })
    }
  }
  return { points, depletedAt }
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
  avgClaimsPerDay: number
  /** Current mint fee in ETH (whole ETH, not wei). */
  mintFeeEth: number
  /** Current claim fee in ETH (whole ETH, not wei). null = claim fees excluded, caller must label the bound mint-fees-only. */
  claimFeeEth: number | null
  /** Current token prices in WETH (Dexscreener priceNative). null = token pace unavailable. */
  fuelPriceNative: number | null
  morePriceNative: number | null
  startDate: string
  horizonDays?: number
}

export type BurnPoint = {
  date: string
  /** Cumulative FUEL burned: observed to date + upper-bound pace. null = pace unknown (gap, not zero). */
  fuel: number | null
  /** Cumulative MORE burned: observed to date + upper-bound pace. null = pace unknown (gap, not zero). */
  more: number | null
}

export type BurnPace = {
  /** Upper-bound ETH per day routed to each burner at the current mint+claim pace. */
  ethToFuelBurnerPerDay: number
  ethToMoreBurnerPerDay: number
  /** Upper-bound tokens burned per day at current native prices, assuming spot conversion with no slippage. null when the price is unavailable. */
  fuelPerDay: number | null
  morePerDay: number | null
}

/** Verified FeeDistributor split: 45% MintVault, 25% FUEL burner, 30% MORE burner. */
export const MINT_VAULT_SHARE = 0.45
export const FUEL_BURN_SHARE = 0.25
export const MORE_BURN_SHARE = 0.30

/**
 * Fee-routing UPPER BOUND on burns — not observed burns. The burners receive
 * ETH (a fixed share of each mint and claim fee, routed through the
 * FeeDistributor) and use it to buy and burn tokens. This extends the most
 * ETH that could reach the burners at the current mint+claim pace and fee
 * levels, converted at current native prices as if every wei bought tokens
 * at spot with zero slippage, zero gas, and immediate execution.
 *
 * That conversion never happens in practice: pool liquidity is shallow, so
 * the burner's own buys move the price, and execution timing is unknown.
 * Observed cumulative burns are the ground truth; this scenario only bounds
 * how fast fee routing alone could add to them. Never present its slope as
 * executed burns, and never feed it into the net-supply trajectory.
 */
export function projectBurns(inputs: BurnInputs): { points: BurnPoint[]; pace: BurnPace } | null {
  const { fuelBurntNow, moreBurntNow, avgMintsPerDay, avgClaimsPerDay, mintFeeEth, claimFeeEth, fuelPriceNative, morePriceNative, startDate, horizonDays = 365 } = inputs
  if (fuelBurntNow < 0n || moreBurntNow < 0n) return null
  if (!Number.isFinite(avgMintsPerDay) || !Number.isFinite(avgClaimsPerDay) || avgMintsPerDay <= 0 || avgClaimsPerDay < 0) return null
  if (!Number.isFinite(mintFeeEth) || mintFeeEth <= 0) return null
  if (claimFeeEth !== null && (!Number.isFinite(claimFeeEth) || claimFeeEth < 0)) return null
  const start = Date.parse(`${startDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 730) return null
  // Claim fees route through the same FeeDistributor (verified
  // _collectClaimFee forwarding), so they belong in the routed-fee bound.
  const ethPerDay = avgMintsPerDay * mintFeeEth + (claimFeeEth !== null ? avgClaimsPerDay * claimFeeEth : 0)
  const fuelPerDay = fuelPriceNative !== null && fuelPriceNative > 0 ? (ethPerDay * FUEL_BURN_SHARE) / fuelPriceNative : null
  const morePerDay = morePriceNative !== null && morePriceNative > 0 ? (ethPerDay * MORE_BURN_SHARE) / morePriceNative : null
  if (fuelPerDay === null && morePerDay === null) return null
  const pace: BurnPace = {
    ethToFuelBurnerPerDay: ethPerDay * FUEL_BURN_SHARE,
    ethToMoreBurnerPerDay: ethPerDay * MORE_BURN_SHARE,
    fuelPerDay,
    morePerDay,
  }
  let fuel: number | null = Number(formatUnits(fuelBurntNow, 18))
  let more: number | null = Number(formatUnits(moreBurntNow, 18))
  if (!Number.isFinite(fuel) || !Number.isFinite(more)) return null
  const points: BurnPoint[] = []
  for (let i = 1; i <= horizonDays; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10)
    // A missing native price means the token pace is unknown: emit a gap,
    // never a flat line that could read as "zero future burns".
    fuel = fuelPerDay === null ? null : (fuel as number) + fuelPerDay
    more = morePerDay === null ? null : (more as number) + morePerDay
    points.push({ date, fuel, more })
  }
  return { points, pace }
}

export type BurnCounterObservation = {
  /** Cumulative tokens burned, in whole tokens. */
  fuelBurnt: number
  moreBurnt: number
  /** When the counters were read, epoch milliseconds. */
  observedAt: number
}

/**
 * Observed burn pace from timestamped burn-counter observations: the
 * per-day change in the cumulative counters between the first and last
 * observation. Needs at least two observations a full day apart; a single
 * cumulative read (all we have today) yields null — "pace unknown" — never
 * a fabricated zero and never the fee-routing bound in disguise.
 */
export function observedBurnPace(observations: BurnCounterObservation[]): { fuelPerDay: number; morePerDay: number } | null {
  const valid = observations.filter(o =>
    Number.isFinite(o.fuelBurnt) && o.fuelBurnt >= 0 &&
    Number.isFinite(o.moreBurnt) && o.moreBurnt >= 0 &&
    Number.isFinite(o.observedAt) && o.observedAt > 0,
  ).sort((a, b) => a.observedAt - b.observedAt)
  if (valid.length < 2) return null
  const first = valid[0]
  const last = valid[valid.length - 1]
  const days = (last.observedAt - first.observedAt) / 86400000
  if (!(days >= 1)) return null
  const fuelPerDay = (last.fuelBurnt - first.fuelBurnt) / days
  const morePerDay = (last.moreBurnt - first.moreBurnt) / days
  if (!Number.isFinite(fuelPerDay) || !Number.isFinite(morePerDay) || fuelPerDay < 0 || morePerDay < 0) return null
  return { fuelPerDay, morePerDay }
}

export type FutureSupplies = {
  date: string
  /** Absolute FUEL supply along the scheduled-maturities path. null when unknown. */
  fuelScheduled: number | null
  /** Absolute FUEL supply if the trailing claim pace continues. null when unknown. */
  fuelPaced: number | null
  /** Absolute FUEL supply on the net-flow trajectory (claims in, burns out). null when unknown. */
  fuelNet: number | null
  /** Same net-flow trajectory at the recent-window pace (the pace band's other edge). null when unknown. */
  fuelNetRecent: number | null
  /** Absolute MORE supply (current minus projected burns). null when unknown. */
  more: number | null
}

/**
 * Absolute future supplies shared by the price and liquidity scenarios.
 * FUEL paths anchor at current supply plus cumulative new inflows.
 * MORE anchors at current supply minus cumulative *new* projected burns:
 * the day-1 point already subtracts day 1's projected burns, so the series
 * is "current supply minus projected burns through that date" — consistent
 * with the FUEL paths, which also include their first day's inflows.
 * Missing inputs yield null (gaps), never zero.
 */
export function projectSupplies(args: {
  fuelSupply: number | null
  moreSupply: number | null
  supply: SupplyPoint[] | null
  burns: { points: BurnPoint[]; pace: BurnPace } | null
  /** Net-flow FUEL trajectory at the full-window pace (primary forward path). */
  net?: NetSupplyResult | null
  /** Net-flow FUEL trajectory at the recent-window pace (pace-band edge). */
  netRecent?: NetSupplyResult | null
}): FutureSupplies[] | null {
  const { fuelSupply, moreSupply, supply, burns, net = null, netRecent = null } = args
  const netPts = net?.points ?? null
  const netRecentPts = netRecent?.points ?? null
  const n = Math.max(supply?.length ?? 0, burns?.points.length ?? 0, netPts?.length ?? 0, netRecentPts?.length ?? 0)
  if (n === 0) return null
  const burnPace = burns?.pace.morePerDay ?? null
  const burn0 = burns?.points[0]?.more ?? null
  // Observed cumulative burns at the start date: the day-1 point minus one day's pace.
  const burnBaseline = burn0 !== null && burnPace !== null ? burn0 - burnPace : null
  const out: FutureSupplies[] = []
  for (let i = 0; i < n; i++) {
    const s = supply?.[i]
    const b = burns?.points[i]
    const date = s?.date ?? b?.date ?? netPts?.[i]?.date ?? netRecentPts?.[i]?.date
    if (!date) break
    out.push({
      date,
      fuelScheduled: s && fuelSupply !== null ? fuelSupply + s.scheduled : null,
      fuelPaced: s && fuelSupply !== null ? fuelSupply + s.paced : null,
      fuelNet: netPts?.[i]?.date === date ? netPts[i].supply : null,
      fuelNetRecent: netRecentPts?.[i]?.date === date ? netRecentPts[i].supply : null,
      more: moreSupply !== null && b?.more != null && burnBaseline !== null
        ? moreSupply - (b.more - burnBaseline)
        : null,
    })
  }
  return out
}

export type PricePoint = {
  date: string
  /**
   * Implied USD price if market cap stayed exactly at its current snapshot
   * while supply moved: price = marketCapNow / supplyFuture. This is an
   * arithmetic scenario, not a price prediction — markets do not hold market
   * cap constant. null = uncomputable (gap, not zero).
   */
  fuelScheduled: number | null
  fuelPaced: number | null
  /** Implied price on the net-flow trajectory (the page's primary forward path). */
  fuelNet: number | null
  /** Implied price on the net-flow trajectory at the recent-window pace. */
  fuelNetRecent: number | null
  more: number | null
}

/**
 * Implied-price scenarios from the supply projections. Every input is a live
 * observable (current market-cap snapshot, projected supplies); the only
 * assumption is "what if market cap held constant", stated on the chart.
 */
export function projectPrices(args: {
  fuelMarketCapUsd: number | null
  moreMarketCapUsd: number | null
  supplies: FutureSupplies[]
}): PricePoint[] | null {
  const { fuelMarketCapUsd, moreMarketCapUsd, supplies } = args
  if (!Array.isArray(supplies) || supplies.length === 0 || supplies.length > 730) return null
  const fuelMc = fuelMarketCapUsd !== null && Number.isFinite(fuelMarketCapUsd) && fuelMarketCapUsd > 0 ? fuelMarketCapUsd : null
  const moreMc = moreMarketCapUsd !== null && Number.isFinite(moreMarketCapUsd) && moreMarketCapUsd > 0 ? moreMarketCapUsd : null
  if (fuelMc === null && moreMc === null) return null
  const implied = (mc: number | null, supply: number | null) =>
    mc !== null && supply !== null && Number.isFinite(supply) && supply > 0 ? mc / supply : null
  return supplies.map(s => {
    if (typeof s.date !== 'string') return null
    return {
      date: s.date,
      fuelScheduled: implied(fuelMc, s.fuelScheduled),
      fuelPaced: implied(fuelMc, s.fuelPaced),
      fuelNet: implied(fuelMc, s.fuelNet),
      fuelNetRecent: implied(fuelMc, s.fuelNetRecent),
      more: implied(moreMc, s.more),
    }
  }).filter((p): p is PricePoint => p !== null)
}

export type LiquidityPoint = {
  date: string
  /**
   * Pool liquidity USD scenarios. "flat" holds today's observed liquidity
   * constant (the only baseline the data supports). "scaled" is illustrative:
   * liquidity depth tracking supply growth at a constant price
   * (liquidityNow × supplyFuture / supplyNow). Neither is a market forecast.
   */
  fuelFlat: number | null
  fuelScaled: number | null
  /** Supply-scaled line on the net-flow trajectory (the page's primary forward path). */
  fuelNetScaled: number | null
  moreFlat: number | null
  moreScaled: number | null
}

/**
 * Liquidity scenarios from current pool snapshots and projected supplies.
 * The flat line is today's liquidity extended; the scaled line is explicitly
 * illustrative. Missing inputs yield null (gaps), never zero.
 */
export function projectLiquidity(args: {
  fuelLiquidityUsd: number | null
  moreLiquidityUsd: number | null
  fuelSupplyNow: number | null
  moreSupplyNow: number | null
  supplies: FutureSupplies[]
}): LiquidityPoint[] | null {
  const { fuelLiquidityUsd, moreLiquidityUsd, fuelSupplyNow, moreSupplyNow, supplies } = args
  if (!Array.isArray(supplies) || supplies.length === 0 || supplies.length > 730) return null
  const fuelLiq = fuelLiquidityUsd !== null && Number.isFinite(fuelLiquidityUsd) && fuelLiquidityUsd >= 0 ? fuelLiquidityUsd : null
  const moreLiq = moreLiquidityUsd !== null && Number.isFinite(moreLiquidityUsd) && moreLiquidityUsd >= 0 ? moreLiquidityUsd : null
  const fuelBase = fuelSupplyNow !== null && Number.isFinite(fuelSupplyNow) && fuelSupplyNow > 0 ? fuelSupplyNow : null
  const moreBase = moreSupplyNow !== null && Number.isFinite(moreSupplyNow) && moreSupplyNow > 0 ? moreSupplyNow : null
  if (fuelLiq === null && moreLiq === null) return null
  const scaled = (liq: number | null, base: number | null, future: number | null) =>
    liq !== null && base !== null && future !== null && Number.isFinite(future) && future >= 0 ? liq * (future / base) : null
  const points: LiquidityPoint[] = []
  for (const s of supplies) {
    if (typeof s.date !== 'string') return null
    points.push({
      date: s.date,
      fuelFlat: fuelLiq,
      fuelScaled: scaled(fuelLiq, fuelBase, s.fuelScheduled),
      fuelNetScaled: scaled(fuelLiq, fuelBase, s.fuelNet),
      moreFlat: moreLiq,
      moreScaled: scaled(moreLiq, moreBase, s.more),
    })
  }
  return points
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

/** Compact USD formatting for scenario figures (e.g. $1.24M, $0.0042). Never invents a value. */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  if (abs >= 1 || value === 0) return `$${value.toFixed(2)}`
  if (abs >= 0.01) return `$${value.toFixed(4)}`
  // Tiny prices (e.g. $0.00003823): two significant digits, never "$0.0000".
  return `$${value.toPrecision(2)}`
}

export type SupplyVelocityInput = {
  /** Unix seconds: when the protocol snapshot (totalSupply read) was taken. */
  supplyObservedAt: number | null
  /** Unix seconds: how far the activity collector has scanned. */
  activityThroughAt: number | null
  /** Reward claims so far on the latest (incomplete) day. */
  partialDayClaims: number
}

/**
 * Velocity-aware supply freshness (audit E8). During claim floods supply
 * moves faster than the snapshot cadence, so a protocol snapshot that
 * predates today's claim flow is flagged as potentially lagging instead of
 * being presented as current. Returns a human-readable warning, or null
 * when there is nothing to warn about. Missing inputs are gaps, never
 * zeros — null in, null out.
 */
export function supplyVelocityWarning(input: SupplyVelocityInput): string | null {
  const { supplyObservedAt, activityThroughAt, partialDayClaims } = input
  if (supplyObservedAt == null || activityThroughAt == null) return null
  if (!Number.isFinite(supplyObservedAt) || !Number.isFinite(activityThroughAt)) return null
  if (partialDayClaims <= 0) return null
  const lagSec = activityThroughAt - supplyObservedAt
  // A snapshot within 5 minutes of the claim flow is fresh enough; the
  // audit flagged a 12-minute-old snapshot presented as current.
  if (lagSec < 300) return null
  const lagMin = Math.round(lagSec / 60)
  return `Supply is moving quickly — the protocol snapshot predates ~${lagMin} minutes of today's claim flow, so the figure above may lag actual supply. Claims push FUEL supply up; burns offset only a fraction of it.`
}
