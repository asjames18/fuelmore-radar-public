import { useEffect, useMemo, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fetchMintFee } from '../lib/planner'
import {
  trailingStats, projectSupply, projectNetSupply, projectBurns, projectSupplies, projectPrices, projectLiquidity,
  tokens, formatTokens, formatUsd,
  FUEL_BURN_SHARE, MORE_BURN_SHARE, type ActivityDay, type MaturityDay, type NetSupplyResult,
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
 * cumulative net flow (claimed rewards in, burns out) at the current pace,
 * with a pace band comparing the full trailing window against the most
 * recent 7 days. These are scenarios from observable numbers, not forecasts.
 */

type Report = {
  maturity?: { status: string; days?: MaturityDay[] }
  days: ActivityDay[]
  throughTimestamp: number
  throughBlock: string
  generatedAt: string
} | null

type FeeState = { mintFeeEth: number | null; at: string | null; error: string | null; retry: () => void }

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

function useMintFee(): FeeState {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ mintFeeEth: number | null; at: string | null; error: string | null }>(
    { mintFeeEth: null, at: null, error: null })
  useEffect(() => {
    let stopped = false
    fetchMintFee()
      .then(result => {
        if (stopped) return
        setState({
          mintFeeEth: result.mintFeeEth,
          at: result.mintFeeEth !== null ? new Date().toISOString() : null,
          error: result.mintFeeEth === null ? 'Mint fee read returned nothing — the burn pace needs it.' : null,
        })
      })
      .catch(() => { if (!stopped) setState({ mintFeeEth: null, at: null, error: 'Mint fee read failed — the burn pace needs it.' }) })
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
  const fee = useMintFee()
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(365)
  useEffect(() => { track('speculation_viewed') }, [])

  const fuelPair = data.pairs.find(p => p.symbol === 'FUEL')
  const morePair = data.pairs.find(p => p.symbol === 'MORE')
  const fuelSupply = useMemo(() => data.protocol ? tokens(data.protocol.totalSupply) : null, [data.protocol])
  const moreSupply = useMemo(() => data.protocol ? tokens(data.protocol.moreTotalSupply) : null, [data.protocol])
  const fuelBurnt = useMemo(() => data.protocol ? tokens(data.protocol.fuelBurnt) : null, [data.protocol])
  const moreBurnt = useMemo(() => data.protocol ? tokens(data.protocol.moreBurnt) : null, [data.protocol])

  const stats = useMemo(() => (report ? trailingStats(report.days) : null), [report])
  const recentStats = useMemo(() => (report ? trailingStats(report.days, RECENT_WINDOW_DAYS) : null), [report])
  const maturityReady = report?.maturity?.status === 'ready' && Array.isArray(report.maturity.days)

  const startDate = useMemo(() => {
    if (report && Number.isFinite(report.throughTimestamp)) {
      return new Date(report.throughTimestamp * 1000).toISOString().slice(0, 10)
    }
    return new Date().toISOString().slice(0, 10)
  }, [report])

  // Burns stand on their own: mint pace × on-chain mint fee × verified split.
  const burns = useMemo(() => {
    if (!stats || !data.protocol || fee.mintFeeEth === null) return null
    const { fuelBurnt, moreBurnt } = data.protocol
    if (fuelBurnt === null || moreBurnt === null) return null
    return projectBurns({
      fuelBurntNow: fuelBurnt, moreBurntNow: moreBurnt,
      avgMintsPerDay: stats.avgMintsPerDay, mintFeeEth: fee.mintFeeEth,
      fuelPriceNative: fuelPair?.priceNative ?? null, morePriceNative: morePair?.priceNative ?? null,
      startDate, horizonDays: 365,
    })
  }, [stats, data.protocol, fee.mintFeeEth, fuelPair?.priceNative, morePair?.priceNative, startDate])
  const fuelBurnPerDay = burns?.pace.fuelPerDay ?? null
  // The supply trajectory never waits on the mint-fee read: when the burn
  // pace is unknown it is excluded (claims only) and every label says so.
  const burnsKnown = fuelBurnPerDay !== null
  const netName = burnsKnown ? 'Net trajectory · full-window pace' : 'Net trajectory · claims only (burn pace unavailable)'
  const netRecentName = `Net trajectory · recent ${recentStats?.daysUsed ?? RECENT_WINDOW_DAYS}d pace${burnsKnown ? '' : ' · excl. burns'}`

  // Primary forward path: net-supply trajectory at the full-window pace,
  // plus the recent-7d pace as the band's other edge.
  const netFull: NetSupplyResult | null = useMemo(() => projectNetSupply({
    fuelSupply, claimedPerDay: stats?.avgClaimedPerDay ?? null, burnPerDay: fuelBurnPerDay, startDate, horizonDays: 365,
  }), [fuelSupply, stats, fuelBurnPerDay, startDate])
  const netRecent: NetSupplyResult | null = useMemo(() => projectNetSupply({
    fuelSupply, claimedPerDay: recentStats?.avgClaimedPerDay ?? null, burnPerDay: fuelBurnPerDay, startDate, horizonDays: 365,
  }), [fuelSupply, recentStats, fuelBurnPerDay, startDate])
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
  const scheduled = useMemo(() => {
    if (!maturityReady || !report?.maturity?.days || !stats) return null
    const future = report.maturity.days.filter(d => d.date > startDate)
    return projectSupply({ maturityDays: future, startDate, horizonDays: 365, avgClaimSize: stats.avgClaimSize, avgClaimedPerDay: stats.avgClaimedPerDay })
  }, [maturityReady, report, stats, startDate])

  const supplies = useMemo(() => projectSupplies({
    fuelSupply, moreSupply, supply: scheduled, burns, net: netFull, netRecent,
  }), [fuelSupply, moreSupply, scheduled, burns, netFull, netRecent])

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
  const burnChart = useMemo(() => burns?.points.slice(0, horizon) ?? null, [burns, horizon])
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
  const netPerDay = stats ? stats.avgClaimedPerDay - (fuelBurnPerDay ?? 0) : null
  const netPerDayNote = netPerDay === null ? 'needs the claim pace'
    : !burnsKnown ? 'claims only — burn pace unavailable'
    : netPerDay >= 0 ? 'supply growing at current pace' : 'supply shrinking at current pace'

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
        <div><span>FUEL supply now</span><strong>{formatTokens(fuelSupply)}</strong><small>as of {dashFresh.label}{dashFresh.stale ? ' · stale' : ''}</small></div>
        <div><span>MORE supply now</span><strong>{formatTokens(moreSupply)}</strong><small>{moreSupply === null ? 'supply read unavailable' : `as of ${dashFresh.label}`}</small></div>
        <div><span>Mint pace · trailing {stats ? `${stats.daysUsed}d` : '—'}</span><strong>{stats ? stats.avgMintsPerDay.toFixed(1) : '—'} <small>/ day</small></strong><small>as of {activityFresh.label}{activityFresh.stale ? ' · stale' : ''}</small></div>
        <div><span>Recent pace · trailing {recentStats ? `${recentStats.daysUsed}d` : '—'}</span><strong>{recentStats ? recentStats.avgMintsPerDay.toFixed(1) : '—'} <small>/ day</small></strong><small>the band's other edge</small></div>
        <div><span>FUEL claimed / day</span><strong>{stats ? formatTokens(stats.avgClaimedPerDay) : '—'}</strong><small>inflow pace</small></div>
        <div><span>FUEL burned / day (est.)</span><strong>{fuelBurnPerDay !== null ? formatTokens(fuelBurnPerDay) : '—'}</strong><small>outflow pace{feeFresh.label !== 'unknown' ? ` · fee as of ${feeFresh.label}` : ''}</small></div>
        <div><span>Net FUEL / day</span><strong>{netPerDay !== null ? `${netPerDay >= 0 ? '+' : ''}${formatTokens(netPerDay)}` : '—'}</strong><small>{netPerDayNote}</small></div>
        <div><span>Mint fee now</span><strong>{fee.mintFeeEth !== null ? `${fee.mintFeeEth.toFixed(6)} ETH` : '—'}</strong><small>{fee.mintFeeEth !== null ? `as of ${feeFresh.label}` : 'read failed'}</small></div>
      </div>
      {error && <p className="activity-note" role="status">{error}</p>}
      {fee.error && <p className="activity-note" role="status">{fee.error} <button className="linklike" onClick={fee.retry}>Retry the read</button></p>}
    </section>

    <section className="panel" aria-labelledby="spec-supply-title">
      <div className="panel-heading"><div><h2 id="spec-supply-title">Future supply · FUEL</h2><p>Net trajectory at today's pace, banded by the recent pace · {horizon}-day horizon</p></div></div>
      {supplyChart ? <>
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
        <p className="activity-note"><b>Net trajectory</b> = today's supply + (FUEL claimed/day{burnsKnown ? ' − FUEL burned/day' : ''}) × days, extended flat.{burnsKnown ? '' : ' Burns are excluded until the mint-fee read succeeds — see the note above.'} The <b>recent-pace line</b> reruns the same math on the last {recentStats?.daysUsed ?? RECENT_WINDOW_DAYS} complete days — the gap between the lines shows whether activity is accelerating or cooling. The <b>dotted line</b> values every known maturing position at the trailing average claim size: maturity dates are deterministic, reward sizes are not, and maturing is not claiming.</p>
      </> : <p className="activity-note" role="status">FUEL supply projection unavailable — needs the supply read and the claim pace.</p>}

      {moreSupplyChart ? <>
        <div className="panel-heading compact"><div><h2>Future supply · MORE</h2><p>Current supply minus projected burns · burns are the only supply change tracked</p></div></div>
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
        <p className="activity-note">Assumes no new MORE issuance — if MORE mints elsewhere, actual supply will differ. Burns are read live from the MORE Buy &amp; Burn controller.</p>
      </> : <p className="activity-note">MORE supply projection unavailable — needs the MORE supply read and the burn projection.</p>}
    </section>

    <section className="panel" aria-labelledby="spec-burn-title">
      <div className="panel-heading"><div><h2 id="spec-burn-title">Future burns · to date and next {horizon} days</h2><p>Observed burns plus the current mint-fee pace</p></div></div>
      <div className="activity-totals">
        <div><span>FUEL burned to date</span><strong>{formatTokens(fuelBurnt)}</strong></div>
        <div><span>MORE burned to date</span><strong>{formatTokens(moreBurnt)}</strong></div>
        <div><span>ETH to FUEL burner / day</span><strong>{burns ? burns.pace.ethToFuelBurnerPerDay.toFixed(4) : '—'}</strong></div>
        <div><span>ETH to MORE burner / day</span><strong>{burns ? burns.pace.ethToMoreBurnerPerDay.toFixed(4) : '—'}</strong></div>
        <div><span>Est. FUEL burned / day</span><strong>{burns?.pace.fuelPerDay != null ? formatTokens(burns.pace.fuelPerDay) : '—'}</strong></div>
        <div><span>Est. MORE burned / day</span><strong>{burns?.pace.morePerDay != null ? formatTokens(burns.pace.morePerDay) : '—'}</strong></div>
      </div>
      {burnChart && burnChart.length > 1 ? <>
        <div className="chart-wrap" role="img" aria-label={`Cumulative burn projection over ${horizon} days for FUEL and MORE.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={burnChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis yAxisId="fuel" domain={['auto', 'auto']} stroke="#36ff6a" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <YAxis yAxisId="more" orientation="right" domain={['auto', 'auto']} stroke="#63b3ff" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatTokens(Number(v))} contentStyle={tipStyle}/>
              <Legend/>
              <Line type="monotone" yAxisId="fuel" dataKey="fuel" name="FUEL burned" stroke="#36ff6a" strokeWidth={2} dot={false} connectNulls/>
              <Line type="monotone" yAxisId="more" dataKey="more" name="MORE burned" stroke="#63b3ff" strokeWidth={2} dot={false} connectNulls/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ForwardStats points={burnChart.map(r => ({ date: r.date, supply: r.fuel }))} base={fuelBurnt} label="FUEL burned · cumulative" format={formatTokens}/>
        <p className="activity-note">Burn pace = trailing mint starts × current on-chain mint fee × the verified {(FUEL_BURN_SHARE * 100).toFixed(0)}% / {(MORE_BURN_SHARE * 100).toFixed(0)}% fee split, converted at current pool prices. Execution prices, slippage, gas, and participation all move — the slope is today's pace, not tomorrow's outcome.</p>
      </> : <p className="activity-note" role="status">Burn projection unavailable — needs the mint fee read, the mint pace, and both token prices. {fee.error && <button className="linklike" onClick={fee.retry}>Retry the mint fee read</button>}</p>}
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
        <li><b>Net trajectory:</b> future FUEL supply = supply now + (FUEL claimed/day − FUEL burned/day) × days. Both daily paces are measured from live data, extended flat. The band's second line reruns it on the most recent {recentStats?.daysUsed ?? RECENT_WINDOW_DAYS} complete days.{burnsKnown ? '' : ' The burn pace is currently unavailable, so this trajectory counts claims only — it will include burns once the mint-fee read succeeds.'}</li>
        <li><b>Trailing window:</b> {stats ? `${stats.daysUsed} complete UTC days` : '—'} of mint starts, claims, and FUEL claimed, from the on-chain activity collector (as of {activityFresh.label}); the latest incomplete day is excluded.</li>
        <li><b>Supply now:</b> FUEL and MORE <code>totalSupply()</code> read live at the last protocol sync{data.protocolObservation ? ` (block ${data.protocolObservation.blockNumber})` : ''}, as of {dashFresh.label}.</li>
        <li><b>Scheduled maturities (dotted overlay):</b> maturity dates are deterministic from mint terms; each maturing position is valued at the trailing average claim size ({stats?.avgClaimSize != null ? `${formatTokens(stats.avgClaimSize)} FUEL` : '—'}). Actual rewards grow with network participation and maturing is not claiming, so actual inflow will differ. {maturityReady ? '' : 'Maturity schedule not ready — the overlay is hidden until the collector finishes it.'}</li>
        <li><b>Mint fee:</b> {fee.mintFeeEth !== null ? `${fee.mintFeeEth.toFixed(6)} ETH per mint` : '—'} read live from the FUEL token contract{fee.at ? ` (as of ${feeFresh.label})` : ''}.</li>
        <li><b>Fee split:</b> {(FUEL_BURN_SHARE * 100).toFixed(0)}% of mint fees to the FUEL burner, {(MORE_BURN_SHARE * 100).toFixed(0)}% to the MORE burner — source-verified on the deployed FeeDistributor (Sourcify exact match; not a security audit).</li>
        <li><b>Prices:</b> FUEL {fuelPair?.priceUsd != null ? `$${fuelPair.priceUsd}` : '—'} · MORE {morePair?.priceUsd != null ? `$${morePair.priceUsd}` : '—'} (pool snapshots, third-party mirror, not executable quotes). Token-per-day burn estimates use native (WETH) pool prices.</li>
        <li><b>Implied price paths:</b> today's market-cap snapshot ÷ projected supply on each path. The caps ({formatUsd(fuelPair?.marketCap ?? null)} FUEL · {formatUsd(morePair?.marketCap ?? null)} MORE) move every block; demand, sentiment, and market reactions are not modeled.</li>
        <li><b>Liquidity paths:</b> flat = today's pool liquidity extended; scaled = liquidity tracking the projected supply path at a constant price, illustrative only. LP deposits/withdrawals are not modeled.</li>
        <li><b>Burns use mint fees only:</b> claim-fee routing is not yet verified, so claim activity contributes nothing to the burn pace here. If claim fees flow through the same distributor, the true pace is higher.</li>
        <li><b>What is NOT here:</b> price predictions, profit estimates, or advice. These are scenarios — "if today's on-chain pace continued, the arithmetic says…" — built so you can check the math, not follow it.</li>
      </ul>
    </section>
  </>
}
