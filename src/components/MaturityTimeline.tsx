import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
export type MaturityReport = { status: 'ready'; days: Array<{date: string; scheduled: number}>; activeCount: number; due: number; samplesChecked: number; historyFrom: number | null } | { status: 'unavailable'; error: string }
type ActualDay = { date: string; mints: number; claims: number }
export function MaturityTimeline({ maturity, actual, throughTimestamp }: { maturity?: MaturityReport; actual: ActualDay[]; throughTimestamp: number }) {
  const [horizon, setHorizon] = useState(7)
  const today = new Date(throughTimestamp * 1000).toISOString().slice(0, 10)
  if (!maturity || maturity.status !== 'ready') return <section className="maturity-timeline" aria-label="FUEL maturity timeline"><h3>Upcoming FUEL maturities</h3><p role="status">{maturity?.status === 'unavailable' ? `Schedule unavailable: ${maturity.error}` : 'A full-history scan is required before the maturity schedule can be displayed.'}</p></section>
  const end = new Date((Math.floor(throughTimestamp / 86400) + horizon) * 86400_000).toISOString().slice(0, 10)
  const data = maturity.days.filter(day => day.date <= end).map(day => {
    const observed = actual.find(item => item.date === day.date)
    return { ...day, mints: observed?.mints ?? null, claims: observed?.claims ?? null }
  })
  return <section className="maturity-timeline" aria-labelledby="maturity-timeline-title">
    <div className="panel-heading"><div><h3 id="maturity-timeline-title">Upcoming FUEL maturities</h3><p>Scheduled mint maturities alongside actual mint starts and reward claims · UTC</p></div>
      <div className="segmented" aria-label="Maturity outlook">{[7, 30].map(days => <button key={days} aria-pressed={horizon === days} className={horizon === days ? 'active' : ''} onClick={() => setHorizon(days)}>Next {days} days</button>)}</div>
    </div>
    <p className="activity-note">{maturity.activeCount.toLocaleString()} active mint positions · {maturity.due.toLocaleString()} at or past maturity at the scan time.</p>
    <div className="activity-chart" role="img" aria-label="Scheduled FUEL maturities compared with actual mint starts and claims; exact daily values are in the table below.">
      <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#173321" vertical={false}/><XAxis dataKey="date" tickFormatter={date => date.slice(5)} stroke="#82998a" minTickGap={25}/><YAxis allowDecimals={false} stroke="#82998a" width={55}/>
        <Tooltip contentStyle={{ background: '#071009', border: '1px solid #245c34', color: '#e1f5e7' }}/><Legend/>
        <Bar dataKey="mints" name="Actual mint starts" fill="#36ff6a"/><Bar dataKey="claims" name="Actual claims" fill="#66b6ff"/><Bar dataKey="scheduled" name="Scheduled maturities" fill="#ffb84d"/>
      </BarChart></ResponsiveContainer>
    </div>
    <div className="activity-table-wrap"><table className="daily-activity-table"><caption>Mint lifecycle by UTC date</caption><thead><tr><th scope="col">Date</th><th scope="col">Mint starts</th><th scope="col">Claims</th><th scope="col">Scheduled maturities</th></tr></thead><tbody>{data.map(day => <tr key={day.date}><th scope="row">{day.date}{day.date > today ? ' · future' : day.date === today ? ' · incomplete' : ''}</th><td>{day.mints?.toLocaleString() ?? '—'}</td><td>{day.claims?.toLocaleString() ?? '—'}</td><td>{day.scheduled.toLocaleString()}</td></tr>)}</tbody></table></div>
    <p className="activity-note">Derived from mint terms and block timestamps. Active-position count matched the contract; {maturity.samplesChecked} maturity timestamps were sample-checked against direct reads. {maturity.historyFrom ? `History starts ${new Date(maturity.historyFrom * 1000).toISOString().slice(0, 10)}. ` : ''}All values share the activity scan’s coverage time above.</p>
    <p className="activity-note">Scheduled maturity is not a forecast of claims, rewards, or selling. Future actuals are unknown (—). Closed positions are excluded from future schedules; historical scheduled dates remain visible. Penalty rules are not calculated.</p>
  </section>
}
