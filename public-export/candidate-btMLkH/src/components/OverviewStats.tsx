import { useEffect, useState } from 'react'
import { parseUnits } from 'viem'
import { formatClaimedFuel, formatEth, formatToken } from '../lib/format'
import { FirstClaimCountdown } from './FirstClaimCountdown'
import type { ProtocolSnapshot } from '../lib/types'
import type { MaturityReport } from './MaturityTimeline'

type Day = {
  date: string
  mintWallets: number
  claimWallets: number
  mints: number
  claims: number
  claimedFuel: string
}
type ActivityEnvelope = {
  status: 'loading' | 'ready' | 'stale' | 'error'
  report: {
    days: Day[]
    maturity?: MaturityReport
    throughTimestamp: number
    throughBlock: string
  } | null
} | null

const REFRESH_MS = 5 * 60 * 1000

function Stat({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

const num = (value: number | bigint | null | undefined) =>
  value == null ? '—' : Number(value).toLocaleString('en-US')

function sumClaimedFuel(days: Day[]): string {
  try {
    const total = days.reduce((sum, day) => sum + parseUnits(day.claimedFuel, 18), 0n)
    return formatToken(total, 2)
  } catch {
    return '—'
  }
}

function nextSevenDayMaturities(maturity: MaturityReport | undefined, today: string): string {
  if (!maturity || maturity.status !== 'ready') return '—'
  const end = new Date(`${today}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 7)
  const endDate = end.toISOString().slice(0, 10)
  const total = maturity.days
    .filter(day => day.date > today && day.date <= endDate)
    .reduce((sum, day) => sum + day.scheduled, 0)
  return total.toLocaleString('en-US')
}

/**
 * Condensed numbers-only glance for the Overview hub: today's activity,
 * last-7-day activity, upcoming maturities, and core protocol figures.
 * Charts and full tables live in their own views; this panel only shows
 * numbers and links onward.
 */
export function OverviewStats({ protocol, onSeeProtocol, onSeeMarkets }: {
  protocol: ProtocolSnapshot | null
  onSeeProtocol: () => void
  onSeeMarkets: () => void
}) {
  const [envelope, setEnvelope] = useState<ActivityEnvelope>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/fuel-activity', { signal: controller.signal })
        if (!response.ok) throw new Error('unavailable')
        const next = (await response.json()) as ActivityEnvelope
        if (!stopped) {
          setEnvelope(next)
          setFailed(false)
        }
      } catch {
        if (!stopped) setFailed(true)
      }
    }
    void load()
    const timer = setInterval(() => { if (!stopped) void load() }, REFRESH_MS)
    return () => { stopped = true; controller.abort(); clearInterval(timer) }
  }, [])

  // The API returns an envelope { status, report }; a null report means the
  // snapshot is unavailable even when the fetch itself succeeded.
  const report = envelope?.report ?? null
  const unavailable = failed || (!!envelope && !report)
  const days = report?.days ?? []
  const today = days.at(-1)
  const mints7 = days.reduce((sum, day) => sum + day.mints, 0)
  const claims7 = days.reduce((sum, day) => sum + day.claims, 0)
  const delayed = envelope?.status === 'stale'

  return <section className="panel daily-pulse" aria-labelledby="daily-pulse-title">
    <div className="panel-heading">
      <div><h2 id="daily-pulse-title">Daily pulse</h2><p>On-chain numbers at a glance · UTC</p></div>
    </div>
    <FirstClaimCountdown maturity={report?.maturity}/>
    {!report && !unavailable && <p className="pulse-note" role="status">Loading daily stats…</p>}
    {unavailable && <p className="pulse-note" role="status">Daily stats unavailable right now.</p>}
    {report && today && <>
      <h3 className="pulse-group">Today · {today.date} · <span className="pulse-flag">incomplete</span></h3>
      <div className="pulse-grid">
        <Stat label="Minting wallets" value={num(today.mintWallets)}/>
        <Stat label="Claiming wallets" value={num(today.claimWallets)}/>
        <Stat label="Mint starts" value={num(today.mints)}/>
        <Stat label="Reward claims" value={num(today.claims)}/>
        <Stat label="FUEL claimed" value={formatClaimedFuel(today.claimedFuel)}/>
      </div>
      <h3 className="pulse-group">Last 7 days</h3>
      <div className="pulse-grid">
        <Stat label="Mint starts" value={mints7.toLocaleString('en-US')}/>
        <Stat label="Reward claims" value={claims7.toLocaleString('en-US')}/>
        <Stat label="FUEL claimed" value={sumClaimedFuel(days)}/>
        <Stat label="Scheduled maturities · next 7 days" value={nextSevenDayMaturities(report.maturity, today.date)}/>
      </div>
    </>}
    {protocol && <>
      <h3 className="pulse-group">Protocol at a glance</h3>
      <div className="pulse-grid">
        <Stat label="FUEL supply" value={formatToken(protocol.totalSupply)}/>
        <Stat label="Active mint positions" value={num(protocol.activeMinters)}/>
        <Stat label="FUEL staked" value={formatToken(protocol.totalStaked)}/>
        <Stat label="FUEL burned" value={formatToken(protocol.fuelBurnt)}/>
        <Stat label="MORE burned" value={formatToken(protocol.moreBurnt)}/>
        <Stat label="Pump fund" value={formatEth(protocol.vaultBalance)}/>
      </div>
    </>}
    <div className="pulse-links">
      <button type="button" onClick={onSeeProtocol}>Full activity &amp; protocol numbers →</button>
      <button type="button" onClick={onSeeMarkets}>Price charts →</button>
    </div>
    {report && <p className="pulse-note">
      {delayed ? 'Delayed data · ' : ''}Scanned through {new Date(report.throughTimestamp * 1000).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.
      {' '}Wallets are unique transaction senders per day, not verified people. Scheduled maturities are derived from mint terms, not a forecast of claims or selling.
    </p>}
  </section>
}
