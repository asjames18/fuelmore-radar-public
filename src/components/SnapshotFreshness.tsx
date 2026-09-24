import { useEffect, useState } from 'react'
import type { RadarData } from '../lib/types'
import { DASHBOARD_MAX_AGE } from '../lib/dashboardSnapshot'

/** Observation times are visible in both editions, without owner diagnostics. */
export function SnapshotFreshness({ data }: { data: RadarData }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer) }, [])
  return <details className="panel source-health">
    <summary>Saved data timestamps · background sync scheduled every 5 minutes</summary>
    <p>Last sync attempt: {new Date(data.updatedAt).toLocaleString()} · schedules may be delayed. Refresh checks for a newer saved copy. Each source below keeps its own observation time. Daily mint/claim activity has a separate scan timestamp.</p>
    <ul>{data.sources.map(source => <li key={source.name}>
      <strong>{source.name.replace('Protocol RPC reads', 'Protocol statistics')}</strong>
      <span>{source.retained ? 'Saved · last refresh incomplete' : source.status === 'unavailable' ? 'Unavailable' : now - Date.parse(source.checkedAt) > DASHBOARD_MAX_AGE ? 'Delayed' : source.status === 'partial' ? 'Partial' : 'Saved'} · {source.status === 'unavailable' && !source.retained ? 'checked' : 'observed'} {new Date(source.checkedAt).toLocaleString()}</span>
    </li>)}</ul>
    {data.protocolObservation && <p>Protocol snapshot: block {data.protocolObservation.blockNumber} · {new Date(Number(data.protocolObservation.blockTimestamp)*1000).toISOString()} · hash {data.protocolObservation.blockHash}</p>}
  </details>
}
