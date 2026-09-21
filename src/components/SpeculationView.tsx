import { useEffect, useMemo, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fetchFeePair } from '../lib/planner'
import {
  trailingStats, todayPartialStats, detectClaimRegimeChange, observedBurnPace, supplyVelocityWarning,
  projectSupply, projectNetSupply, projectBurns, projectSupplies, projectPrices, projectLiquidity,
  tokens, formatTokens, formatUsd,
  FUEL_BURN_SHARE, MORE_BURN_SHARE, MINT_VAULT_SHARE,
  type ActivityDay, type MaturityDay, type NetSupplyResult, type BurnCounterObservation,
} from '../lib/speculation'
import { track } from '../lib/analytics'
import type { RadarData } from '../lib/types'

/**
 * Speculation — forward view from today's chain state.
 *
 * Every section computes independently from whatever live inputs are
 * available, so one missing feed degrades one section instead of blanking the
 * page (the failure mode that left the old page empty). Missing inputs are
 * labeled gaps, never zeros.
 *
 * The primary forward path is the net-supply trajectory: today's supply plus
 * cumulative net flow (claimed rewards in, observed burns out) at the
 * trailing pace, with a pace band comparing the full trailing window against
 * the most recent 7 days. Burns enter only as observed behavior — the
 * fee-routing conversion survives solely as an explicitly labeled upper-bound
 * scenario and never feeds the trajectory. On a claim regime-change day (the
 * first unlock: trailing days show zero claims, today has claims) the
 * pre-unlock pace is suspended and the page shows today's partial-day
 * observation with an honest-state banner instead of a false depletion path.
 * These are scenarios from observable numbers, not forecasts.
 */

type Report = {
  maturity?: { status: string; days?: MaturityDay[] }
  days: ActivityDay[]
  throughTimestamp: number
  throughBlock: string
  generatedAt: string
} | null

type FeeState = { mintFeeEth: number | null; claimFeeEth: number | null; at: string | null; error: string | null; retry: () => void }

const HORIZONS = [90, 180, 365] as const
const RECENT_WINDOW_DAYS = 7
const STALE_MS = 3600_000
const tick = (date: string) => date.slice(2)
const fullTick = (date: string) => date
const tipStyle = { background: '#071009', border: '1px solid #245c34', color: '#e1f5e7', fontFamily: 'var(--mono)' } as const

function useActivityReport() {
  const [report, setReport] = useState<Report>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    async function poll() {
      try {
        const response = await fetch('/api/fuel-activity', { signal: controller.signal })
        if (!response.ok) throw new Error('Activity service unavailable')
        const next = await response.json()
        if (!stopped && next.report) { setReport(next.report); setError(null) }
      } catch {
        if (!stopped) setError('Activity feed unavailable; pace-based projections need the collector report.')
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 30000)
      }
    }
    void poll()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [])
  return { report, error }
}

function useFees(): FeeState {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ mintFeeEth: number | null; claimFeeEth: number | null; at: string | null; error: string | null }>(
    { mintFeeEth: null, claimFeeEth: null, at: null, error: null })
  useEffect(() => {
    let stopped = false
    fetchFeePair()
      .then(result => {
        if (stopped) return
        setState({
          mintFeeEth: result.mintFeeEth,
          claimFeeEth: result.claimFeeEth,
          at: result.mintFeeEth !== null || result.claimFeeEth !== null ? new Date().toISOString() : null,
          error: result.mintFeeEth === null && result.claimFeeEth === null
            ? 'Fee reads returned nothing — the burn upper bound needs them.'
            : null,
        })
      })
      .catch(() => { if (!stopped) setState({ mintFeeEth: null, claimFeeEth: null, at: null, error: 'Fee reads failed — the burn upper bound needs them.' }) })
    return () => { stopped = true }
  }, [attempt])
  return { ...state, retry: () => { setState(s => ({ ...s, error: null })); setAttempt(a => a + 1) } }
}

function asOf(when: string | number | null): { label: string; stale: boolean } {
  if (when === null || when === undefined) return { label: 'unknown', stale: true }
  const ms = typeof when === 'number' ? when : Date.parse(when)
  if (!Number.isFinite(ms)) return { label: 'unknown', stale: true }
  const ageMin = Math.max(0, Math.round((Date.now() - ms) / 60000))
  const label = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`
  return { label, stale: Date.now() - ms > STALE_MS }
}

function ForwardStats({ points, base, label, format }: {
  points: Array<{ date: string; supply: number | null }> | null
  base: number | null
  label: string
  format: (v: number | null) => string
}) {
  if (!points || base === null) return <p className="activity-note">{label}: unavailable — waiting on live inputs.</p>
  const rows = [[30, '30d'], [90, '90d'], [points.length, `${points.length}d`]] as const
  return <div className="activity-totals">
    {rows.map(([i, name]) => {
      const p = points[Math.min(i, points.length) - 1]
      return <div key={name}><span>{label} · +{name}</span><strong title={p?.date ?? ''}>{format(p?.supply ?? null)}</strong></div>
    })}
  </div>
}

export function SpeculationView({ data }: { data: RadarData }) {
  const { report, error } = useActivityReport()
  const fee = useFees()
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(365)
  useEffect(() => { track('speculation_viewed') }, [])

  const fuelPair = data.pairs.find(p => p.symbol === 'FUEL')
  const morePair = data.pairs.find(p => p.symbol === 'MORE')
  const fuelSupply = useMemo(() => data.protocol ? tokens(data.protocol.totalSupply ?? null) : null, [data.protocol])
  const moreSupply = useMemo(() => data.protocol ? tokens(data.protocol.moreTotalSupply ?? null) : null, [data.protocol])
  const fuelBurnt = useMemo(() => data.protocol ? tokens(data.protocol.fuelBurnt ?? null) : null, [data.protocol])
  const moreBurnt = useMemo(() => data.protocol ? tokens(data.protocol.moreBurnt ?? null) : null, [data.protocol])
  const ethUsedFuelBurns = useMemo(() => data.protocol ? tokens(data.protocol.ethUsedFuelBurns ?? null) : null, [data.protocol])
  const ethUsedMoreBurns = useMemo(() => data.protocol ? tokens(data.protocol.ethUsedMoreBurns ?? null) : null, [data.protocol])

  const stats = useMemo(() => (report ? trailingStats(report.days) : null), [report])
  const recentStats = useMemo(() => (report ? trailingStats(report.days, RECENT_WINDOW_DAYS) : null), [report])
  const todayPartial = useMemo(() => (report ? todayPartialStats(report.days) : null), [report])
  const regime = useMemo(() => detectClaimRegimeChange(report?.days ?? [], stats), [report, stats])
  const regimeChange = regime.kind === 'claim-regime-change'
  // Velocity-aware supply freshness: during claim floods the protocol snapshot
  // can lag the claim flow, so we flag it instead of presenting it as current.
  const supplyWarning = supplyVelocityWarning({
    supplyObservedAt: data.protocolObservation ? Number(data.protocolObservation.blockTimestamp) : null,
    activityThroughAt: report?.throughTimestamp ?? null,
    partialDayClaims: todayPartial?.claims ?? 0,
  })
  const maturityReady = report?.maturity?.status === 'ready' && Array.isArray(report.maturity.days)

  const startDate = useMemo(() => {
    if (report && Number.isFinite(report.throughTimestamp)) {
      return new Date(report.throughTimestamp * 1000).toISOString().slice(0, 10)
    }
    return new Date().toISOString().slice(0, 10)
  }, [report])

  // Observed burn behavior: the cumulative counters are read live, but a
  // pace needs at least two timestamped observations a day apart. With only
  // the current reading the pace is unknown — shown as such, never as zero
  // and never replaced by the fee-routing bound below.
  const burnObservation: BurnCounterObservation | null = useMemo(() => {
    if (fuelBurnt === null || moreBurnt === null || !data.protocolObservation) return null
    const secs = Number(data.protocolObservation.blockTimestamp)
    if (!Number.isFinite(secs) || secs <= 0) return null
    return { fuelBurnt, moreBurnt, observedAt: secs * 1000 }
  }, [fuelBurnt, moreBurnt, data.protocolObservation])
  const burnPaceObserved = useMemo(
    () => (burnObservation ? observedBurnPace([burnObservation]) : null),
    [burnObservation],
  )
  const fuelBurnPerDayObserved = burnPaceObserved?.fuelPerDay ?? null

  // Fee-routing UPPER BOUND (not observed burns): the most ETH the
  // FeeDistributor could send the burners at the current mint+claim pace,
  // converted at current native prices as if at spot with no slippage.
  const burnBound = useMemo(() => {
    if (!stats || fee.mintFeeEth === null) return null
    return projectBurns({
      fuelBurntNow: data.protocol?.fuelBurnt ?? 0n,
      moreBurntNow: data.protocol?.moreBurnt ?? 0n,
      avgMintsPerDay: stats.avgMintsPerDay,
      avgClaimsPerDay: stats.avgClaimsPerDay,
      mintFeeEth: fee.mintFeeEth,
      claimFeeEth: fee.claimFeeEth,
      fuelPriceNative: fuelPair?.priceNative ?? null,
      morePriceNative: morePair?.priceNative ?? null,
      startDate,
      horizonDays: 365,
    })
  }, [stats, fee.mintFeeEth, fee.claimFeeEth, fuelPair?.priceNative, morePair?.priceNative, startDate, data.protocol])
  const claimFeesInBound = fee.claimFeeEth !== null
  const fuelBurnBoundPerDay = burnBound?.pace.fuelPerDay ?? null

  // The net-supply trajectory stands on observed behavior only: claimed
  // rewards in, observed burns out. The fee-routing bound never feeds it —
  // that bound is a ceiling on fee-driven buying, not executed burns.
  // During a claim regime change the pre-unlock pace is suspended entirely.
  const burnsKnown = fuelBurnPerDayObserved !== null
  const netName = burnsKnown ? 'Net trajectory · full-window pace' : 'Net trajectory · claims only (observed burn pace unavailable)'
  const netRecentName = `Net trajectory · recent ${recentStats?.daysUsed ?? RECENT_WINDOW_DAYS}d pace${burnsKnown ? '' : ' · excl. burns'}`
  const netFull: NetSupplyResult | null = useMemo(() => regimeChange ? null : projectNetSupply({
    fuelSupply, claimedPerDay: stats?.avgClaimedPerDay ?? null, burnPerDay: fuelBurnPerDayObserved, startDate, horizonDays: 365,
  }), [regimeChange, fuelSupply, stats, fuelBurnPerDayObserved, startDate])
  const netRecent: NetSupplyResult | null = useMemo(() => regimeChange ? null : projectNetSupply({
    fuelSupply, claimedPerDay: recentStats?.avgClaimedPerDay ?? null, burnPerDay: fuelBurnPerDayObserved, startDate, horizonDays: 365,
  }), [regimeChange, fuelSupply, recentStats, fuelBurnPerDayObserved, startDate])
  // A supply cannot go negative: when the flat pace would deplete it, the
  // trajectory stops at the zero-crossing and says so in plain language.
  const depletionNote = useMemo(() => {
    const dates = [netFull?.depletedAt, netRecent?.depletedAt].filter((d): d is string => d !== null && d !== undefined)
    if (dates.length === 0) return null
    const first = dates.sort()[0]
    return `At the current pace the net trajectory reaches zero around ${first} — the paths stop there. Past that point the flat-pace assumption breaks: burns are bounded by the supply that exists.`
  }, [netFull?.depletedAt, netRecent?.depletedAt])

  // Scheduled maturities are an overlay, not a gate: they show even when the
  // pace inputs are missing, and the pace paths show when maturities aren't ready.
  // E7: the overlay needs a valid observed claim-size baseline. The trailing
  // average is preferred; on a regime-change day it is null (no complete
  // claim days yet), so today's partial-day observed average stands in —
  // labeled as such. With neither, the overlay stays hidden, honestly.
  const claimSizeBaseline = useMemo(() => {
    if (stats?.avgClaimSize != null) return { value: stats.avgClaimSize, label: 'trailing average claim size' }
    if (todayPartial?.avgClaimSize != null) return { value: todayPartial.avgClaimSize, label: "today's observed average (partial day)" }
    return null
  }, [stats, todayPartial])
  const scheduled = useMemo(() => {
    if (!maturityReady || !report?.maturity?.days || !stats || !claimSizeBaseline) return null
    const future = report.maturity.days.filter(d => d.date > startDate)
    return projectSupply({ maturityDays: future, startDate, horizonDays: 365, avgClaimSize: claimSizeBaseline.value, avgClaimedPerDay: stats.avgClaimedPerDay })
  }, [maturityReady, report, stats, claimSizeBaseline, startDate])

  const supplies = useMemo(() => projectSupplies({
    fuelSupply, moreSupply, supply: scheduled, burns: burnBound, net: netFull, netRecent,
  }), [fuelSupply, moreSupply, scheduled, burnBound, netFull, netRecent])

  const prices = useMemo(() => supplies
    ? projectPrices({ fuelMarketCapUsd: fuelPair?.marketCap ?? null, moreMarketCapUsd: morePair?.marketCap ?? null, supplies })
    : null, [supplies, fuelPair?.marketCap, morePair?.marketCap])

  const liquidity = useMemo(() => supplies
    ? projectLiquidity({
        fuelLiquidityUsd: fuelPair?.liquidityUsd ?? null, moreLiquidityUsd: morePair?.liquidityUsd ?? null,
        fuelSupplyNow: fuelSupply, moreSupplyNow: moreSupply, supplies,
      })
    : null, [supplies, fuelPair?.liquidityUsd, morePair?.liquidityUsd, fuelSupply, moreSupply])

  const supplyChart = useMemo(() => {
    if (!supplies) return null
    const rows = supplies.slice(0, horizon).map(p => ({ date: p.date, net: p.fuelNet, netRecent: p.fuelNetRecent, scheduled: p.fuelScheduled }))
    return rows.some(r => r.net !== null) ? rows : null
  }, [supplies, horizon])
  const moreSupplyChart = useMemo(() => {
    if (!supplies) return null
    const rows = supplies.slice(0, horizon).map(p => ({ date: p.date, supply: p.more }))
    return rows.some(r => r.supply !== null) ? rows : null
  }, [supplies, horizon])
  const burnChart = useMemo(() => burnBound?.points.slice(0, horizon) ?? null, [burnBound, horizon])
  const priceChart = useMemo(() => {
    const rows = prices?.slice(0, horizon) ?? null
    return rows && rows.some(p => p.fuelNet !== null || p.more !== null) ? rows : null
  }, [prices, horizon])
  const liquidityChart = useMemo(() => {
    const rows = liquidity?.slice(0, horizon) ?? null
    return rows && rows.some(p => p.fuelFlat !== null || p.moreFlat !== null) ? rows : null
  }, [liquidity, horizon])

  const dashFresh = asOf(data.updatedAt ?? null)
  const activityFresh = asOf(report && Number.isFinite(report.throughTimestamp) ? report.throughTimestamp * 1000 : null)
  const feeFresh = asOf(fee.at)
  const netPerDay = !regimeChange && stats ? stats.avgClaimedPerDay - (fuelBurnPerDayObserved ?? 0) : null
  const netPerDayNote = regimeChange ? 'pace suspended — first claims landing today'
    : netPerDay === null ? 'needs the claim pace'
    : !burnsKnown ? 'claims only — observed burn pace unavailable'
    : netPerDay >= 0 ? 'supply growing at trailing pace' : 'supply shrinking at trailing pace'

  return <>
    <section className="panel" aria-labelledby="spec-head-title">
      <div className="panel-heading">
        <div>
          <h2 id="spec-head-title">Speculation — where today's chain state points</h2>
          <p>Forward view from live on-chain numbers · scenarios, not forecasts</p>
        </div>
        <div className="segmented" aria-label="Projection horizon">{HORIZONS.map(h => <button key={h} aria-pressed={horizon === h} className={horizon === h ? 'active' : ''} onClick={() => setHorizon(h)}>{h}d</button>)}</div>
      </div>
      <div className="activity-totals">
        <div><span>FUEL supply now</span><strong>{formatTokens(fuelSupply)}</strong><small>as of {dashFresh.label}{dashFresh.stale ? ' · stale' : ''}</small></div>        <div><span>MORE supply now</span><strong>{formatTokens(moreSupply)}</strong><small>{moreSupply === null ? 'supply read unavailable' : `as of ${dashFresh.label}`}</small></div>
        <div><span>Mint pace · trailing {stats ? `${stats.daysUsed}d` : '—'}</span><strong>{stats ? stats.avgMintsPerDay.toFixed(1) : '—'} <small>/ day</small></strong><small>as of {activityFresh.label}{activityFresh.stale ? ' · stale' : ''}</small></div>
        <div><span>Recent pace · trailing {recentStats ? `${recentStats.daysUsed}d` : '—'}</span><strong>{recentStats ? recentStats.avgMintsPerDay.toFixed(1) : '—'} <small>/ day</small></strong><small>the band's other edge</small></div>
        <div><span>FUEL claimed / day</span><strong>{!regimeChange && stats ? formatTokens(stats.avgClaimedPerDay) : '—'}</strong><small>{regimeChange ? 'pace suspended — see below' : 'inflow pace'}</small></div>
        <div><span>FUEL burned / day (observed)</span><strong>{fuelBurnPerDayObserved !== null ? formatTokens(fuelBurnPerDayObserved) : '—'}</strong><small>{burnsKnown ? 'observed pace' : 'pace unavailable — cumulative only'}</small></div>
        <div><span>Net FUEL / day</span><strong>{netPerDay !== null ? `${netPerDay >= 0 ? '+' : ''}${formatTokens(netPerDay)}` : '—'}</strong><small>{netPerDayNote}</small></div>
        <div><span>Mint fee now</span><strong>{fee.mintFeeEth !== null ? `${fee.mintFeeEth.toFixed(6)} ETH` : '—'}</strong><small>{fee.mintFeeEth !== null ? `as of ${feeFresh.label}` : 'read failed'}</small></div>
        <div><span>Claim fee now</span><strong>{fee.claimFeeEth !== null ? `${fee.claimFeeEth.toFixed(6)} ETH` : '—'}</strong><small>{fee.claimFeeEth !== null ? `as of ${feeFresh.label}` : 'read failed'}</small></div>
      </div>
      {supplyWarning && <p className="activity-note" role="status">⚠ {supplyWarning}</p>}
      {regimeChange && regime.kind === 'claim-regime-change' && <div className="status-banner" role="status">
        <strong>First claims are landing — the market just changed.</strong>{' '}
        Every complete trailing day showed zero claims; today already has {regime.today.claims.toLocaleString('en-US')} claims
        ({formatTokens(regime.today.claimedFuel)} FUEL so far, partial day). The pre-unlock pace no longer describes
        this market, so pace trajectories are suspended until complete claim days can be measured — what follows is
        today's observed reality, not a projection. FUEL's price fell sharply as the first rewards unlocked; the
        pre-unlock price paths no longer apply.
      </div>}
      {error && <p className="activity-note" role="status">{error}</p>}
      {fee.error && <p className="activity-note" role="status">{fee.error} <button className="linklike" onClick={fee.retry}>Retry the read</button></p>}
    </section>

    <section className="panel" aria-labelledby="spec-supply-title">
      <div className="panel-heading"><div><h2 id="spec-supply-title">Future supply · FUEL</h2><p>{regimeChange ? 'Pace trajectories suspended — first claims landing today' : `Net trajectory at the trailing pace, banded by the recent pace · ${horizon}-day horizon`}</p></div></div>
      {regimeChange && regime.kind === 'claim-regime-change' ? <>
        <div className="activity-totals">
          <div><span>Claims today · partial day</span><strong>{regime.today.claims.toLocaleString('en-US')}</strong><small>{regime.today.date} · still counting</small></div>
          <div><span>FUEL claimed today · partial</span><strong>{formatTokens(regime.today.claimedFuel)}</strong><small>observed inflow so far</small></div>
          <div><span>Avg claim size today · partial</span><strong>{regime.today.avgClaimSize !== null ? formatTokens(regime.today.avgClaimSize) : '—'}</strong><small>observed average, not annualized</small></div>
          <div><span>Mint starts today · partial</span><strong>{regime.today.mints.toLocaleString('en-US')}</strong><small>{regime.today.date}</small></div>
        </div>
        <p className="activity-note" role="status">No pace trajectory is drawn today on purpose: annualizing a partial first-claim day would be a guess, and the pre-unlock pace (zero claims) would be a lie. Trajectories resume once complete days with claims are observed — check back tomorrow.</p>
        {scheduled ? <>
          <p className="activity-note"><b>Scheduled maturities:</b> every known maturing position valued at {claimSizeBaseline ? `${formatTokens(claimSizeBaseline.value)} FUEL (${claimSizeBaseline.label})` : '—'} — maturity dates are deterministic, reward sizes are not, and maturing is not claiming. The overlay chart returns with the pace trajectories.</p>
        </> : <p className="activity-note" role="status">Scheduled-maturity overlay unavailable — needs a valid observed claim-size baseline.</p>}
      </> : supplyChart ? <>
        <div className="chart-wrap" role="img" aria-label={`FUEL supply projection over ${horizon} days from current on-chain pace.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={supplyChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="spec-net" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#36ff6a" stopOpacity={0.22}/><stop offset="100%" stopColor="#36ff6a" stopOpacity={0.01}/></linearGradient>
              </defs>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis domain={['auto', 'auto']} stroke="#70847a" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatTokens(Number(v))} contentStyle={tipStyle}/>
              <Legend/>
              <Area type="monotone" dataKey="net" name={netName} stroke="#36ff6a" fill="url(#spec-net)" strokeWidth={2} dot={false}/>
              <Line type="monotone" dataKey="netRecent" name={netRecentName} stroke="#ffb84d" strokeDasharray="6 3" strokeWidth={2} dot={false}/>
              <Line type="monotone" dataKey="scheduled" name="Potential claims · scheduled maturities" stroke="#ff7a59" strokeDasharray="2 3" strokeWidth={1.5} dot={false} connectNulls/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ForwardStats points={supplyChart.map(r => ({ date: r.date, supply: r.net }))} base={fuelSupply} label="FUEL supply · net path" format={formatTokens}/>
        {depletionNote && <p className="activity-note" role="status">{depletionNote}</p>}
        <p className="activity-note"><b>Net trajectory</b> = today's supply + (FUEL claimed/day{burnsKnown ? ' − FUEL burned/day' : ''}) × days, extended flat.{burnsKnown ? '' : ' The observed burn pace is unavailable, so burns are excluded — the fee-routing upper bound below is a ceiling on fee-driven buying, not executed burns, and never feeds this line.'} The <b>recent-pace line</b> reruns the same math on the last {recentStats?.daysUsed ?? RECENT_WINDOW_DAYS} complete days — the gap between the lines shows whether activity is accelerating or cooling. The <b>dotted line</b> values every known maturing position at the {claimSizeBaseline ? claimSizeBaseline.label : 'trailing average claim size'} ({claimSizeBaseline ? formatTokens(claimSizeBaseline.value) : '—'} FUEL): maturity dates are deterministic, reward sizes are not, and maturing is not claiming.</p>
      </> : <p className="activity-note" role="status">FUEL supply projection unavailable — needs the supply read and the claim pace.</p>}

      {moreSupplyChart ? <>
        <div className="panel-heading compact"><div><h2>Future supply · MORE</h2><p>Current supply minus the fee-routing upper bound on burns — the fastest burns could plausibly shrink it</p></div></div>
        <div className="chart-wrap" role="img" aria-label={`MORE supply projection over ${horizon} days, decreasing by projected burns.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={moreSupplyChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis domain={['auto', 'auto']} stroke="#70847a" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatTokens(Number(v))} contentStyle={tipStyle}/>
              <Area type="monotone" dataKey="supply" name="MORE supply" stroke="#63b3ff" fill="#63b3ff" fillOpacity={0.12} strokeWidth={2} dot={false} connectNulls/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="activity-note">This is the lower edge, not a forecast: actual supply falls only as fast as real burns execute, and the burn line above is a ceiling. Assumes no new MORE issuance — if MORE mints elsewhere, actual supply will differ. Burns are read live from the MORE Buy &amp; Burn controller.</p>
      </> : <p className="activity-note">MORE supply projection unavailable — needs the MORE supply read and the burn upper bound.</p>}
    </section>

    <section className="panel" aria-labelledby="spec-burn-title">
      <div className="panel-heading"><div><h2 id="spec-burn-title">Burns · observed to date and the fee-routing upper bound</h2><p>What the burners have actually done, plus the ceiling on what fee routing could add</p></div></div>
      <div className="activity-totals">
        <div><span>FUEL burned to date</span><strong>{formatTokens(fuelBurnt)}</strong><small>observed cumulative</small></div>
        <div><span>MORE burned to date</span><strong>{formatTokens(moreBurnt)}</strong><small>observed cumulative</small></div>
        <div><span>ETH spent on FUEL burns</span><strong>{ethUsedFuelBurns !== null ? `${ethUsedFuelBurns.toFixed(4)} ETH` : '—'}</strong><small>observed cumulative</small></div>
        <div><span>ETH spent on MORE burns</span><strong>{ethUsedMoreBurns !== null ? `${ethUsedMoreBurns.toFixed(4)} ETH` : '—'}</strong><small>observed cumulative</small></div>
        <div><span>Observed burn pace</span><strong>{fuelBurnPerDayObserved !== null ? formatTokens(fuelBurnPerDayObserved) : '—'}</strong><small>{burnsKnown ? 'FUEL / day, measured' : 'unavailable — counters have no history yet'}</small></div>
        <div><span>Upper-bound ETH to FUEL burner / day</span><strong>{burnBound ? burnBound.pace.ethToFuelBurnerPerDay.toFixed(4) : '—'}</strong><small>fee routing ceiling</small></div>
        <div><span>Upper-bound ETH to MORE burner / day</span><strong>{burnBound ? burnBound.pace.ethToMoreBurnerPerDay.toFixed(4) : '—'}</strong><small>fee routing ceiling</small></div>
        <div><span>Upper-bound FUEL / day</span><strong>{fuelBurnBoundPerDay !== null ? formatTokens(fuelBurnBoundPerDay) : '—'}</strong><small>at spot, no slippage — not observed</small></div>
      </div>
      <p className="activity-note"><b>Observed behavior comes first.</b> The burners have verifiably burned {formatTokens(fuelBurnt)} FUEL and {formatTokens(moreBurnt)} MORE, spending {ethUsedFuelBurns !== null ? `${ethUsedFuelBurns.toFixed(4)}` : '—'} and {ethUsedMoreBurns !== null ? `${ethUsedMoreBurns.toFixed(4)}` : '—'} ETH to do it. A measured per-day burn pace needs timestamped counter history, which does not exist yet — so no pace is shown and none is invented.</p>
      {burnChart && burnChart.length > 1 ? <>
        <div className="chart-wrap" role="img" aria-label={`Fee-routing upper bound on cumulative burns over ${horizon} days for FUEL and MORE.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={burnChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis yAxisId="fuel" domain={['auto', 'auto']} stroke="#36ff6a" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <YAxis yAxisId="more" orientation="right" domain={['auto', 'auto']} stroke="#63b3ff" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatTokens(Number(v))} contentStyle={tipStyle}/>
              <Legend/>
              <Line type="monotone" yAxisId="fuel" dataKey="fuel" name="FUEL burned · upper bound" stroke="#36ff6a" strokeWidth={2} dot={false} connectNulls/>
              <Line type="monotone" yAxisId="more" dataKey="more" name="MORE burned · upper bound" stroke="#63b3ff" strokeWidth={2} dot={false} connectNulls/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ForwardStats points={burnChart.map(r => ({ date: r.date, supply: r.fuel }))} base={fuelBurnt} label="FUEL burned · upper bound cumulative" format={formatTokens}/>
        <p className="activity-note"><b>Upper bound, not a pace.</b> This ceiling = trailing mint starts × current mint fee{claimFeesInBound ? ' + trailing claims × current claim fee' : ' (claim-fee read unavailable, so claims are excluded)'} × the verified {(FUEL_BURN_SHARE * 100).toFixed(0)}% / {(MORE_BURN_SHARE * 100).toFixed(0)}% fee split, converted at current pool prices as if every wei bought at spot. Real execution faces slippage, gas, and timing — and liquidity is shallow (FUEL pool {formatUsd(fuelPair?.liquidityUsd ?? null)}), so even the burner's own ETH buys can move the price it gets. Treat this line as the most fee routing could add, never as burns that happened.</p>
      </> : <p className="activity-note" role="status">Burn upper bound unavailable — needs the fee reads, the mint pace, and both token prices. {fee.error && <button className="linklike" onClick={fee.retry}>Retry the fee reads</button>}</p>}
    </section>

    <section className="panel" aria-labelledby="spec-price-title">
      <div className="panel-heading"><div><h2 id="spec-price-title">Future price · implied paths</h2><p>What the supply paths imply if market cap held constant · arithmetic, not a forecast</p></div></div>
      <div className="activity-totals">
        <div><span>FUEL price now</span><strong>{fuelPair?.priceUsd != null ? formatUsd(fuelPair.priceUsd) : '—'}</strong></div>
        <div><span>MORE price now</span><strong>{morePair?.priceUsd != null ? formatUsd(morePair.priceUsd) : '—'}</strong></div>
        <div><span>FUEL market cap now</span><strong>{formatUsd(fuelPair?.marketCap ?? null)}</strong></div>
        <div><span>MORE market cap now</span><strong>{formatUsd(morePair?.marketCap ?? null)}</strong></div>
      </div>
      {priceChart ? <>
        <div className="chart-wrap" role="img" aria-label={`Implied price paths over ${horizon} days for FUEL and MORE, holding market cap constant.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={priceChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis yAxisId="fuel" domain={['auto', 'auto']} stroke="#36ff6a" tick={{ fontSize: 10 }} tickFormatter={v => formatUsd(Number(v))} width={64}/>
              <YAxis yAxisId="more" orientation="right" domain={['auto', 'auto']} stroke="#63b3ff" tick={{ fontSize: 10 }} tickFormatter={v => formatUsd(Number(v))} width={64}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatUsd(Number(v))} contentStyle={tipStyle}/>
              <Legend/>
              <Line type="monotone" yAxisId="fuel" dataKey="fuelNet" name="FUEL · net path" stroke="#36ff6a" strokeWidth={2} dot={false}/>
              <Line type="monotone" yAxisId="fuel" dataKey="fuelNetRecent" name="FUEL · recent-pace path" stroke="#ffb84d" strokeDasharray="6 3" strokeWidth={2} dot={false}/>
              <Line type="monotone" yAxisId="more" dataKey="more" name="MORE · burn path" stroke="#63b3ff" strokeWidth={2} dot={false} connectNulls/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ForwardStats points={priceChart.map(r => ({ date: r.date, supply: r.fuelNet }))} base={fuelPair?.priceUsd ?? null} label="FUEL implied price · net path" format={formatUsd}/>
        <p className="activity-note">Each line is pure arithmetic: today's market-cap snapshot ÷ the projected supply on that path. Markets never hold market cap constant while supply moves — this shows the <i>direction and scale</i> the supply pressure implies, not where price is going.{depletionNote ? ' The FUEL net path stops where the supply trajectory depletes (see above) — the steep climb into that stop is the arithmetic of a shrinking supply, not a price call.' : ''}</p>
      </> : <p className="activity-note" role="status">Price paths unavailable — needs the market-cap snapshots and the supply projections.</p>}
    </section>

    <section className="panel" aria-labelledby="spec-liq-title">
      <div className="panel-heading"><div><h2 id="spec-liq-title">Future liquidity · paths</h2><p>Pool depth today, held flat vs. tracking the net supply path</p></div></div>
      <div className="activity-totals">
        <div><span>FUEL pool liquidity now</span><strong>{formatUsd(fuelPair?.liquidityUsd ?? null)}</strong></div>
        <div><span>MORE pool liquidity now</span><strong>{formatUsd(morePair?.liquidityUsd ?? null)}</strong></div>
        <div><span>FUEL 24h volume</span><strong>{formatUsd(fuelPair?.volume24h ?? null)}</strong></div>
        <div><span>MORE 24h volume</span><strong>{formatUsd(morePair?.volume24h ?? null)}</strong></div>
      </div>
      {liquidityChart ? <>
        <div className="chart-wrap" role="img" aria-label={`Liquidity paths over ${horizon} days for FUEL and MORE pools.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={liquidityChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis yAxisId="fuel" domain={['auto', 'auto']} stroke="#36ff6a" tick={{ fontSize: 10 }} tickFormatter={v => formatUsd(Number(v))} width={64}/>
              <YAxis yAxisId="more" orientation="right" domain={['auto', 'auto']} stroke="#63b3ff" tick={{ fontSize: 10 }} tickFormatter={v => formatUsd(Number(v))} width={64}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatUsd(Number(v))} contentStyle={tipStyle}/>
              <Legend/>
              <Line type="monotone" yAxisId="fuel" dataKey="fuelFlat" name="FUEL liq · flat" stroke="#36ff6a" strokeWidth={2} dot={false} connectNulls/>
              <Line type="monotone" yAxisId="fuel" dataKey="fuelNetScaled" name="FUEL liq · net-path scaled" stroke="#36ff6a" strokeDasharray="6 3" strokeWidth={2} dot={false}/>
              <Line type="monotone" yAxisId="more" dataKey="moreFlat" name="MORE liq · flat" stroke="#63b3ff" strokeWidth={2} dot={false} connectNulls/>
              <Line type="monotone" yAxisId="more" dataKey="moreScaled" name="MORE liq · supply-scaled" stroke="#63b3ff" strokeDasharray="6 3" strokeWidth={2} dot={false} connectNulls/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="activity-note"><b>Flat</b> is today's observed pool liquidity extended — the only baseline the data supports. <b>Scaled</b> is illustrative: liquidity tracking the projected supply path at a constant price.{depletionNote ? ' The net-path scaled line stops where the supply trajectory depletes (see above).' : ''} Real liquidity is set by liquidity providers and traders, which this radar does not model.</p>
      </> : <p className="activity-note" role="status">Liquidity paths unavailable — needs the pool liquidity snapshots.</p>}
    </section>

    <section className="panel" aria-labelledby="spec-method-title">
      <div className="panel-heading"><div><h2 id="spec-method-title">The math behind the page</h2><p>Every input is observable · every assumption is listed · nothing is a forecast</p></div></div>
      <ul className="spec-assumptions">
        <li><b>Net trajectory:</b> future FUEL supply = supply now + (FUEL claimed/day − FUEL burned/day) × days. The claim pace is measured from live claims; the burn pace is the <i>observed</i> burn pace only, extended flat. The band's second line reruns it on the most recent {recentStats?.daysUsed ?? RECENT_WINDOW_DAYS} complete days.{burnsKnown ? '' : ' The observed burn pace is currently unavailable, so this trajectory counts claims only.'} The fee-routing upper bound never feeds this line.</li>
        {regimeChange && <li><b>Regime change:</b> the first claims landed today, so the pre-unlock pace (zero claims) no longer describes the market. Pace trajectories are suspended until complete days with claims are observed; today's panel shows the partial-day observation instead. This is the honest state, not a missing feature.</li>}
        <li><b>Trailing window:</b> {stats ? `${stats.daysUsed} complete UTC days` : '—'} of mint starts, claims, and FUEL claimed, from the on-chain activity collector (as of {activityFresh.label}); the latest incomplete day is excluded — except on a regime-change day, when it is shown separately as a labeled partial-day observation, never annualized.</li>
        <li><b>Supply now:</b> FUEL and MORE <code>totalSupply()</code> read live at the last protocol sync{data.protocolObservation ? ` (block ${data.protocolObservation.blockNumber})` : ''}, as of {dashFresh.label}. During claim floods supply moves fast — a snapshot can lag the latest claims.</li>
        <li><b>Scheduled maturities (dotted overlay):</b> maturity dates are deterministic from mint terms; each maturing position is valued at the {claimSizeBaseline ? claimSizeBaseline.label : 'trailing average claim size'} ({claimSizeBaseline ? `${formatTokens(claimSizeBaseline.value)} FUEL` : '—'}). Actual rewards grow with network participation and maturing is not claiming, so actual inflow will differ. {claimSizeBaseline ? '' : 'No valid observed claim-size baseline — the overlay is hidden until one exists.'} {maturityReady ? '' : 'Maturity schedule not ready — the overlay is hidden until the collector finishes it.'}</li>
        <li><b>Fees:</b> mint {fee.mintFeeEth !== null ? `${fee.mintFeeEth.toFixed(6)} ETH` : '—'} · claim {fee.claimFeeEth !== null ? `${fee.claimFeeEth.toFixed(6)} ETH` : '—'} per action, read live from the FUEL token contract{fee.at ? ` (as of ${feeFresh.label})` : ''}.</li>
        <li><b>Fee split:</b> the complete FeeDistributor split — {(MINT_VAULT_SHARE * 100).toFixed(0)}% to the MintVault, {(FUEL_BURN_SHARE * 100).toFixed(0)}% buys &amp; burns FUEL, {(MORE_BURN_SHARE * 100).toFixed(0)}% buys &amp; burns MORE. Claim fees route through the same distributor (verified <code>_collectClaimFee</code> forwarding), so the upper bound counts them. Source-verified via Sourcify exact match on the FeeDistributor; not a security audit.</li>
        <li><b>Burns — observed vs. upper bound:</b> observed cumulative burns ({formatTokens(fuelBurnt)} FUEL · {formatTokens(moreBurnt)} MORE) are ground truth. The burn <i>pace</i> is shown only when measured from timestamped counter history — currently unavailable, so none is shown. The <b>fee-routing upper bound</b> is a separate ceiling: the most ETH fees could send the burners at the trailing pace, converted at current native (WETH) pool prices as if at spot with zero slippage. Pool liquidity is shallow, so real execution would move the price against the buyer — the bound overstates what burns can achieve.</li>
        <li><b>Prices:</b> FUEL {fuelPair?.priceUsd != null ? `$${fuelPair.priceUsd}` : '—'} · MORE {morePair?.priceUsd != null ? `$${morePair.priceUsd}` : '—'} (pool snapshots, third-party mirror, not executable quotes). Shallow liquidity means relatively small ETH buys can move price materially — in either direction.</li>
        <li><b>Implied price paths:</b> today's market-cap snapshot ÷ projected supply on each path. The caps ({formatUsd(fuelPair?.marketCap ?? null)} FUEL · {formatUsd(morePair?.marketCap ?? null)} MORE) move every block; demand, sentiment, and market reactions are not modeled.</li>
        <li><b>Liquidity paths:</b> flat = today's pool liquidity extended; scaled = liquidity tracking the projected supply path at a constant price, illustrative only. LP deposits/withdrawals are not modeled.</li>
        <li><b>What is NOT here:</b> price predictions, profit estimates, or advice. These are scenarios — "if today's on-chain pace continued, the arithmetic says…" — built so you can check the math, not follow it.</li>
      </ul>
    </section>
  </>
}
