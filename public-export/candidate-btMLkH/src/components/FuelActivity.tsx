import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatClaimedFuel } from '../lib/format'
import { MaturityTimeline, type MaturityReport } from './MaturityTimeline'

type Day = { date: string; mintWallets: number; claimWallets: number; mints: number; claims: number; claimedFuel: string }
type ActivityState = {
  status: 'loading' | 'ready' | 'stale' | 'error'
  progress: string | null
  error: string | null
  report: {
    maturity?: MaturityReport
    days: Day[]
    throughTimestamp: number
    throughBlock: string
    generatedAt: string
    index?: { mode?: string; recordCount?: number }
  } | null
}
const initial: ActivityState = { status: 'loading', progress: 'Connecting to the FUEL activity collector…', error: null, report: null }

export function FuelActivity() {
  const [now, setNow] = useState(() => Date.now())
  const [state, setState] = useState<ActivityState>(initial)
  const [metric, setMetric] = useState<'wallets' | 'events'>('wallets')
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    async function poll() {
      if (!stopped) setNow(Date.now())
      try {
        const response = await fetch('/api/fuel-activity', { signal: controller.signal })
        if (!response.ok) throw new Error('Activity service unavailable')
        const next: ActivityState = await response.json()
        if (!['ready', 'stale', 'loading', 'error'].includes(next.status)) throw new Error('Invalid activity response')
        if (!stopped) setState(next)
      } catch {
        if (!stopped) setState(previous => ({ ...previous, status: 'error', progress: null, error: 'Activity feed unavailable. On Cloudflare the edge snapshot may be refreshing; locally start the app with npm run dev.' }))
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [])
  const { report } = state
  const wallets = metric === 'wallets'
  const today = report?.days.at(-1)
  const old = report ? now / 1000 - report.throughTimestamp > 20 * 60 : false
  return <section className="panel fuel-activity" aria-labelledby="fuel-activity-title">
    <div className="panel-heading">
      <div><h2 id="fuel-activity-title">FUEL · Minting vs claiming</h2><p>Daily participation · last 7 UTC days</p></div>
      <div className="segmented" aria-label="FUEL activity metric">
        <button aria-pressed={wallets} className={wallets ? 'active' : ''} onClick={() => setMetric('wallets')}>Wallets</button>
        <button aria-pressed={!wallets} className={!wallets ? 'active' : ''} onClick={() => setMetric('events')}>Mint / claim counts</button>
      </div>
    </div>
    {state.error && <p className="activity-message" role="status">{report ? 'Showing the last completed scan. ' : ''}{state.error}</p>}
    {state.progress && <p className="activity-message" role="status">{state.progress}{report ? ' · Previous scan remains visible.' : ''}</p>}
    {report && today ? <>
      <div className="activity-totals">
        <div><span>Minting wallets · {today.date}</span><strong>{today.mintWallets.toLocaleString()}</strong></div>
        <div><span>Claiming wallets · {today.date}</span><strong>{today.claimWallets.toLocaleString()}</strong></div>
        <div><span>Mint starts / claims · {today.date}</span><strong>{today.mints.toLocaleString()} <small>/ {today.claims.toLocaleString()}</small></strong></div>
      </div>
      <p className="activity-note">{old ? 'Delayed data · ' : ''}Latest day is incomplete. Scanned through {new Date(report.throughTimestamp * 1000).toLocaleString('en-US', { timeZone: 'UTC' })} UTC · block {report.throughBlock}{report.index?.mode ? ` · ${report.index.mode} index` : ''}{typeof report.index?.recordCount === 'number' ? ` · ${report.index.recordCount.toLocaleString()} events` : ''}.</p>
      <div className="activity-chart" role="img" aria-label={`Daily FUEL ${wallets ? 'unique minting and claiming wallets' : 'mint starts and reward claims'}. Exact values appear in the table below.`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={report.days} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#173321" vertical={false}/>
            <XAxis dataKey="date" tickFormatter={date => date.slice(5)} stroke="#82998a" tick={{ fontSize: 11 }}/>
            <YAxis allowDecimals={false} stroke="#82998a" tick={{ fontSize: 11 }} width={45}/>
            <Tooltip contentStyle={{ background: '#071009', border: '1px solid #245c34', color: '#e1f5e7' }}/>
            <Legend/>
            <Bar dataKey={wallets ? 'mintWallets' : 'mints'} name={wallets ? 'Minting wallets' : 'Mint starts'} fill="#36ff6a" radius={[3, 3, 0, 0]}/>
            <Bar dataKey={wallets ? 'claimWallets' : 'claims'} name={wallets ? 'Claiming wallets' : 'Reward claims'} fill="#66b6ff" radius={[3, 3, 0, 0]}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="activity-table-wrap"><table className="daily-activity-table">
        <caption>FUEL daily mint and claim activity (UTC)</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Minting wallets</th><th scope="col">Claiming wallets</th><th scope="col">Mint starts</th><th scope="col">Claims</th><th scope="col">FUEL claimed</th></tr></thead>
        <tbody>{[...report.days].reverse().map(day => <tr key={day.date}><th scope="row">{day.date}{day === today ? ' *' : ''}</th><td>{day.mintWallets.toLocaleString()}</td><td>{day.claimWallets.toLocaleString()}</td><td>{day.mints.toLocaleString()}</td><td>{day.claims.toLocaleString()}</td><td title={day.claimedFuel}>{formatClaimedFuel(day.claimedFuel)}</td></tr>)}</tbody>
      </table></div>
    </> : !state.error && <div className="activity-empty">{report ? 'Activity report has no daily rows for this coverage window.' : 'Building the daily comparison from on-chain events. Counts appear after the full scan completes.'}</div>}
    {report && <MaturityTimeline maturity={report.maturity} actual={report.days} throughTimestamp={report.throughTimestamp}/>}
    <p className="activity-note">Wallets are unique transaction senders per UTC day, not verified people. Batch proxy addresses are grouped by sender; relayers or smart-wallet bundlers can affect attribution. A wallet can mint and claim on the same day. Mint starts open positions; reward claims receive FUEL. These counts do not measure buy or sell pressure.</p>
    <p className="activity-note">Source: <a href="https://app.fuelmoretokens.com/" target="_blank" rel="noreferrer">FUEL event definitions</a> · Robinhood RPC · 64-block confirmation buffer · scheduled collection; coverage timestamp shown above.</p>
  </section>
}
