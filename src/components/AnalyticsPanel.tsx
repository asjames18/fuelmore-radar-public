import { useEffect, useState } from 'react'

type DaySummary = { date: string; counts: Record<string, number> }

const EVENT_LABELS: Record<string, string> = {
  view_selected: 'Views',
  cockpit_open: 'Cockpit opens',
  wallet_lookup: 'Wallet lookups',
  chart_rendered: 'Chart renders',
  refresh_clicked: 'Refreshes',
  donate_clicked: 'Donate clicks',
  contract_copied: 'Contract copies',
}
const ROW_EVENTS = Object.keys(EVENT_LABELS)

/** PRIVATE-ONLY: mounted through the private entry's `personal` prop, never in the public build. */
export function AnalyticsPanel() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [days, setDays] = useState<DaySummary[]>([])

  useEffect(() => {
    let stopped = false
    fetch('/api/analytics/summary?days=7')
      .then(response => {
        if (!response.ok) throw new Error(`summary ${response.status}`)
        return response.json()
      })
      .then(payload => {
        if (stopped) return
        const list: DaySummary[] = Array.isArray(payload?.days) ? payload.days : []
        setDays(list)
        setStatus(list.length ? 'ready' : 'empty')
      })
      .catch(() => { if (!stopped) setStatus('error') })
    return () => { stopped = true }
  }, [])

  return <section className="panel" aria-labelledby="analytics-title">
    <div className="panel-heading"><div><h2 id="analytics-title">Usage analytics</h2><p>Counts only · no cookies, no identifiers</p></div><span className="mono muted">7 days</span></div>
    {status === 'loading' && <p className="muted">Loading usage summary…</p>}
    {status === 'error' && <p className="muted">Usage summary unavailable. It is served only when the worker runs with ANALYTICS_PRIVATE=1.</p>}
    {status === 'empty' && <p className="muted">No usage recorded in the last 7 days.</p>}
    {status === 'ready' && <>
      <div className="contract-table" role="table" aria-label="Usage counts by day">
        <div className="contract-row contract-header" role="row">
          <span>Day (UTC)</span>{ROW_EVENTS.map(event => <span key={event}>{EVENT_LABELS[event]}</span>)}
        </div>
        {days.map(day => <div className="contract-row" role="row" key={day.date}>
          <strong className="mono">{day.date}</strong>{ROW_EVENTS.map(event => <span key={event} className="mono">{day.counts?.[event] ?? 0}</span>)}
        </div>)}
      </div>
      <p className="muted">Raw traffic lives in <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer">dash.cloudflare.com</a> → Web Analytics.</p>
    </>}
  </section>
}
