import { useEffect, useMemo, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fetchMintFee } from '../lib/planner'
import {
  trailingStats, projectSupply, projectBurns, tokens, formatTokens,
  FUEL_BURN_SHARE, MORE_BURN_SHARE, type ActivityDay, type MaturityDay,
} from '../lib/speculation'
import { track } from '../lib/analytics'
import type { RadarData } from '../lib/types'

type Report = {
  maturity?: { status: string; days?: MaturityDay[] }
  days: ActivityDay[]
  throughTimestamp: number
  throughBlock: string
  generatedAt: string
} | null

type FeeState = { mintFeeEth: number | null; at: string | null }

const HORIZONS = [90, 180, 365] as const
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
        if (!stopped) setError('Activity data unavailable; projections need the collector report.')
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 30000)
      }
    }
    void poll()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [])
  return { report, error }
}

function useMintFee() {
  const [fee, setFee] = useState<FeeState>({ mintFeeEth: null, at: null })
  useEffect(() => {
    let stopped = false
    fetchMintFee().then(result => {
      if (!stopped) setFee({ mintFeeEth: result.mintFeeEth, at: result.mintFeeEth !== null ? new Date().toISOString() : null })
    }).catch(() => { if (!stopped) setFee({ mintFeeEth: null, at: null }) })
    return () => { stopped = true }
  }, [])
  return fee
}

function HorizonStats({ points, base, label }: { points: Array<{ date: string; scheduled: number; paced: number }> | null; base: number | null; label: string }) {
  if (!points || base === null) return <p className="activity-note">{label}: unavailable — waiting on live inputs.</p>
  const at = (i: number) => points[Math.min(i, points.length - 1)]
  const rows = [[30, '30d'], [90, '90d'], [points.length - 1, `${points.length}d`]] as const
  return <div className="activity-totals">
    {rows.map(([i, name]) => {
      const p = at(i - 1)
      return <div key={name}><span>{label} · +{name}</span><strong title={`${p.date}`}>{formatTokens(base + p.scheduled)} <small>scheduled</small></strong><span className="spec-alt">{formatTokens(base + p.paced)} <small>at current pace</small></span></div>
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
  const fuelSupply = useMemo(() => tokens(data.protocol.totalSupply), [data.protocol.totalSupply])
  const moreSupply = useMemo(() => tokens(data.protocol.moreTotalSupply), [data.protocol.moreTotalSupply])

  const computed = useMemo(() => {
    if (!report || report.maturity?.status !== 'ready' || !report.maturity.days) return null
    const today = new Date(report.throughTimestamp * 1000).toISOString().slice(0, 10)
    const stats = trailingStats(report.days)
    if (!stats) return { today, stats: null as null, supply: null, burns: null }
    const future = report.maturity.days.filter(d => d.date > today)
    const supply = projectSupply({ maturityDays: future, startDate: today, horizonDays: 365, avgClaimSize: stats.avgClaimSize, avgClaimedPerDay: stats.avgClaimedPerDay })
    const burns = data.protocol.fuelBurnt !== null && data.protocol.moreBurnt !== null && fee.mintFeeEth !== null
      ? projectBurns({
          fuelBurntNow: data.protocol.fuelBurnt, moreBurntNow: data.protocol.moreBurnt,
          avgMintsPerDay: stats.avgMintsPerDay, mintFeeEth: fee.mintFeeEth,
          fuelPriceNative: fuelPair?.priceNative ?? null, morePriceNative: morePair?.priceNative ?? null,
          startDate: today, horizonDays: 365,
        })
      : null
    return { today, stats, supply, burns }
  }, [report, data.protocol.fuelBurnt, data.protocol.moreBurnt, fee.mintFeeEth, fuelPair?.priceNative, morePair?.priceNative])

  const supplyChart = useMemo(() => {
    if (!computed?.supply || fuelSupply === null) return null
    return computed.supply.slice(0, horizon).map(p => ({ date: p.date, scheduled: fuelSupply + p.scheduled, paced: fuelSupply + p.paced }))
  }, [computed, fuelSupply, horizon])

  const burnChart = useMemo(() => computed?.burns?.points.slice(0, horizon) ?? null, [computed, horizon])

  // MORE supply can only fall via burns in the data we track; show it against projected MORE burns.
  const moreSupplyChart = useMemo(() => {
    if (!computed?.burns || moreSupply === null) return null
    const start = computed.burns.points[0]
    return computed.burns.points.slice(0, horizon).map(p => ({ date: p.date, supply: moreSupply - (p.more - start.more) }))
  }, [computed, moreSupply, horizon])

  const stats = computed?.stats ?? null
  return <>
    <section className="panel" aria-labelledby="spec-supply-title">
      <div className="panel-heading">
        <div><h2 id="spec-supply-title">Supply · now and next 12 months</h2><p>Live supply plus what the current pace implies · not a prediction</p></div>
        <div className="segmented" aria-label="Projection horizon">{HORIZONS.map(h => <button key={h} aria-pressed={horizon === h} className={horizon === h ? 'active' : ''} onClick={() => setHorizon(h)}>{h}d</button>)}</div>
      </div>
      <div className="activity-totals">
        <div><span>FUEL supply now</span><strong>{formatTokens(fuelSupply)}</strong></div>
        <div><span>MORE supply now</span><strong>{formatTokens(moreSupply)}</strong></div>
        <div><span>Mint pace · trailing {stats ? `${stats.daysUsed}d` : '—'}</span><strong>{stats ? stats.avgMintsPerDay.toFixed(1) : '—'} <small>/ day</small></strong></div>
        <div><span>Avg FUEL claimed / day</span><strong>{stats ? formatTokens(stats.avgClaimedPerDay) : '—'}</strong></div>
      </div>
      {error && <p className="activity-note" role="status">{error}</p>}
      {supplyChart && supplyChart.length > 1 ? <>
        <div className="chart-wrap" role="img" aria-label={`FUEL supply projection over ${horizon} days. Two scenarios from live on-chain numbers.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={supplyChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="spec-sched" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ffb84d" stopOpacity={0.28}/><stop offset="100%" stopColor="#ffb84d" stopOpacity={0.01}/></linearGradient>
                <linearGradient id="spec-pace" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#36ff6a" stopOpacity={0.22}/><stop offset="100%" stopColor="#36ff6a" stopOpacity={0.01}/></linearGradient>
              </defs>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis domain={['auto', 'auto']} stroke="#70847a" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatTokens(Number(v))} contentStyle={tipStyle}/>
              <Legend/>
              <Area type="monotone" dataKey="scheduled" name="Scheduled unlocks" stroke="#ffb84d" fill="url(#spec-sched)" strokeWidth={2} dot={false}/>
              <Area type="monotone" dataKey="paced" name="At current pace" stroke="#36ff6a" fill="url(#spec-pace)" strokeWidth={2} dot={false}/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <HorizonStats points={computed?.supply ?? null} base={fuelSupply} label="FUEL supply"/>
        <p className="activity-note"><b>Scheduled unlocks</b> values every known maturing position at the trailing average claim size — maturity dates are deterministic, reward sizes are not (rewards grow with network participation). <b>At current pace</b> extends the trailing daily FUEL claimed. Neither line is a forecast of price or of anyone's behavior.</p>
      </> : <p className="activity-note" role="status">Supply projection unavailable — waiting on the activity report and live protocol reads.</p>}

      {moreSupplyChart && moreSupplyChart.length > 1 ? <>
        <div className="panel-heading compact"><div><h2>MORE supply</h2><p>Current supply minus projected burns · burns are the only supply change we track</p></div></div>
        <div className="chart-wrap" role="img" aria-label={`MORE supply projection over ${horizon} days, decreasing by projected burns.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={moreSupplyChart} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
              <XAxis dataKey="date" tickFormatter={tick} stroke="#70847a" tick={{ fontSize: 10 }} minTickGap={40}/>
              <YAxis domain={['auto', 'auto']} stroke="#70847a" tick={{ fontSize: 10 }} tickFormatter={v => formatTokens(Number(v))} width={58}/>
              <Tooltip labelFormatter={(label) => fullTick(String(label))} formatter={(v) => formatTokens(Number(v))} contentStyle={tipStyle}/>
              <Area type="monotone" dataKey="supply" name="MORE supply" stroke="#63b3ff" fill="#63b3ff" fillOpacity={0.12} strokeWidth={2} dot={false}/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="activity-note">Assumes no new MORE issuance — if the MORE token mints elsewhere, actual supply will differ. Burns are read live from the MORE Buy &amp; Burn controller.</p>
      </> : <p className="activity-note">MORE supply projection unavailable — needs the MORE supply read and the burn projection.</p>}
    </section>

    <section className="panel" aria-labelledby="spec-burn-title">
      <div className="panel-heading"><div><h2 id="spec-burn-title">Burns · to date and next 12 months</h2><p>Observed burns plus the current mint-fee pace · not a prediction</p></div></div>
      <div className="activity-totals">
        <div><span>FUEL burned to date</span><strong>{formatTokens(tokens(data.protocol.fuelBurnt))}</strong></div>
        <div><span>MORE burned to date</span><strong>{formatTokens(tokens(data.protocol.moreBurnt))}</strong></div>
        <div><span>ETH to FUEL burner / day</span><strong>{computed?.burns ? computed.burns.pace.ethToFuelBurnerPerDay.toFixed(4) : '—'}</strong></div>
        <div><span>ETH to MORE burner / day</span><strong>{computed?.burns ? computed.burns.pace.ethToMoreBurnerPerDay.toFixed(4) : '—'}</strong></div>
        <div><span>Est. FUEL burned / day</span><strong>{computed?.burns?.pace.fuelPerDay != null ? formatTokens(computed.burns.pace.fuelPerDay) : '—'}</strong></div>
        <div><span>Est. MORE burned / day</span><strong>{computed?.burns?.pace.morePerDay != null ? formatTokens(computed.burns.pace.morePerDay) : '—'}</strong></div>
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
              <Line type="monotone" yAxisId="fuel" dataKey="fuel" name="FUEL burned" stroke="#36ff6a" strokeWidth={2} dot={false}/>
              <Line type="monotone" yAxisId="more" dataKey="more" name="MORE burned" stroke="#63b3ff" strokeWidth={2} dot={false}/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="activity-note">Burn pace = trailing mint starts × current on-chain mint fee × the verified {(FUEL_BURN_SHARE * 100).toFixed(0)}% / {(MORE_BURN_SHARE * 100).toFixed(0)}% fee split, converted at current pool prices. Execution prices, slippage, gas, and participation all move — treat the slope as "today's pace", not tomorrow's outcome.</p>
      </> : <p className="activity-note" role="status">Burn projection unavailable — needs the mint fee read, the mint pace, and both token prices.</p>}
    </section>

    <section className="panel" aria-labelledby="spec-assumptions-title">
      <div className="panel-heading"><div><h2 id="spec-assumptions-title">What these numbers assume</h2><p>Every input is observable · every assumption is listed</p></div></div>
      <ul className="spec-assumptions">
        <li><b>Trailing window:</b> {stats ? `${stats.daysUsed} complete UTC days` : '—'} of mint starts, claims, and FUEL claimed, from the on-chain activity collector. The latest incomplete day is excluded.</li>
        <li><b>Supply now:</b> FUEL and MORE <code>totalSupply()</code> read live at the last protocol sync{data.protocolObservation ? ` (block ${data.protocolObservation.blockNumber})` : ''}.</li>
        <li><b>Scheduled unlocks:</b> maturity dates are deterministic from mint terms; each maturing position is valued at the trailing average claim size ({stats?.avgClaimSize != null ? `${formatTokens(stats.avgClaimSize)} FUEL` : '—'}). Actual rewards grow with network participation, so actual unlocks will differ.</li>
        <li><b>Current pace:</b> trailing mints/day ({stats ? stats.avgMintsPerDay.toFixed(1) : '—'}) and FUEL claimed/day ({stats ? formatTokens(stats.avgClaimedPerDay) : '—'}), extended flat.</li>
        <li><b>Mint fee:</b> {fee.mintFeeEth !== null ? `${fee.mintFeeEth.toFixed(6)} ETH per mint` : '—'} read live from the FUEL token contract at the current gas price{fee.at ? ` (${new Date(fee.at).toISOString().slice(11, 19)} UTC)` : ''}.</li>
        <li><b>Fee split:</b> {(FUEL_BURN_SHARE * 100).toFixed(0)}% of mint fees to the FUEL burner, {(MORE_BURN_SHARE * 100).toFixed(0)}% to the MORE burner — source-verified on the deployed FeeDistributor (Sourcify exact match; not a security audit).</li>
        <li><b>Prices:</b> FUEL {fuelPair?.priceUsd != null ? `$${fuelPair.priceUsd}` : '—'} · MORE {morePair?.priceUsd != null ? `$${morePair.priceUsd}` : '—'} (pool snapshots, third-party mirror, not executable quotes). Token-per-day burn estimates use native (WETH) pool prices.</li>
        <li><b>What is NOT here:</b> price predictions, profit estimates, or advice. These are scenarios — "if today's on-chain pace continued" — built so you can check the math, not follow it.</li>
      </ul>
    </section>
  </>
}
