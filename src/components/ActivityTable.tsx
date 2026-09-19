import { ExternalLink } from 'lucide-react'
import { BLOCKSCOUT } from '../lib/contracts'
import { shortAddress, timeAgo } from '../lib/format'
import type { ActivityItem } from '../lib/types'
import type { SourceCheck } from '../lib/sourceStatus'

export function ActivityTable({ activity, sources }: { activity: ActivityItem[]; sources: SourceCheck[] }) {
  const complete = ['FUEL transfers', 'MORE transfers'].every(name => sources.some(source => source.name === name && source.status === 'available'))
  return (
    <section className="panel activity-panel" aria-labelledby="activity-title">
      <div className="panel-heading compact"><div><h2 id="activity-title">Recent activity</h2><p>Latest indexed FUEL and MORE transfers</p></div></div>
      {!complete && <p role="status">{activity.length ? 'Partial transfer coverage. One or more sources are unavailable.' : 'Transfer data unavailable or incomplete. This is not a confirmed empty result.'}</p>}
      <div className="activity-table" role="table">
        <div className="activity-row activity-header" role="row"><span>Time</span><span>Event</span><span>Asset</span><span>Amount</span><span>Route</span><span></span></div>
        {activity.length ? activity.map((item) => <div className="activity-row" role="row" key={`${item.hash}-${item.symbol}-${item.from}-${item.to}`}>
          <time dateTime={item.timestamp}>{timeAgo(item.timestamp)}</time>
          <strong>{item.event}</strong>
          <span className={`asset asset-${item.symbol.toLowerCase()}`}>{item.symbol}</span>
          <span className="mono">{item.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
          <span className="mono route">{shortAddress(item.from, 5, 4)} → {shortAddress(item.to, 5, 4)}</span>
          <a href={`${BLOCKSCOUT}/tx/${item.hash}`} target="_blank" rel="noreferrer" aria-label="Open transaction"><ExternalLink size={14}/></a>
        </div>) : complete ? <div className="empty-row">No indexed transfers returned.</div> : null}
      </div>
    </section>
  )
}
