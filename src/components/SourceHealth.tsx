import { useEffect, useState } from 'react'
import type { RadarData } from '../lib/types'
export function SourceHealth({ data }: { data: RadarData }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer) }, [])
  const delayed = data.sources.some(source => now - Date.parse(source.checkedAt) > 1_800_000)
  return <details className="panel source-health">
    <summary>Data sources · {data.sources.filter(source => source.status === 'available').length}/{data.sources.length} available · {delayed ? 'Delayed checks' : data.partial ? 'Partial coverage' : 'Sources responded'}</summary>
    <p>Available means the source responded, not that its values were independently audited. — means unavailable. Market and explorer data can be delayed. Daily FUEL activity has its own scan timestamp.</p>
    <ul>{data.sources.map(source => <li key={source.name}><strong>{source.name}</strong><span>{!source.retained && source.status === 'available' && now - Date.parse(source.checkedAt) > 1_800_000 ? 'DELAYED' : source.retained ? 'SAVED · REFRESH FAILED' : source.status.toUpperCase()} · check completed {new Date(source.checkedAt).toLocaleTimeString()}</span><small>{source.detail}</small></li>)}</ul>
  </details>
}
