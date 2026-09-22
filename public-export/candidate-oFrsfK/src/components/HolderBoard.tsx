import { Users } from 'lucide-react'
import { BLOCKSCOUT } from '../lib/contracts'
import { shortAddress } from '../lib/format'
import type { HolderSummary } from '../lib/types'

function HolderColumn({ symbol, holders }: { symbol: string; holders: HolderSummary | undefined }) {
  const summary = holders
  const total = summary?.totalHolders
  const list = summary?.topHolders
  return (
    <div className="holder-column">
      <header>
        <h3>{symbol} holders</h3>
        <strong>{total == null ? '—' : total.toLocaleString()}</strong>
        <small>{total == null ? 'Holder count unavailable' : 'Blockscout-indexed count'}</small>
      </header>
      {list == null ? (
        <p className="holder-empty">Top-holder list unavailable. This is not a confirmed empty census.</p>
      ) : list.length === 0 ? (
        <p className="holder-empty">No holders returned at this explorer snapshot.</p>
      ) : (
        <ol>
          {list.map((row, index) => (
            <li key={`${row.address}-${index}`}>
              <span className="holder-rank">{index + 1}</span>
              <a href={`${BLOCKSCOUT}/address/${row.address}`} target="_blank" rel="noreferrer" className="mono">{shortAddress(row.address, 8, 6)}</a>
              <b>{row.percent == null ? '—' : `${row.percent.toFixed(2)}%`}</b>
              <small>{row.isContract == null ? 'Type unknown' : row.isContract ? 'Contract' : 'Wallet'}</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function HolderBoard({ holders }: { holders: Record<string, HolderSummary> }) {
  return (
    <section className="panel holder-board" aria-labelledby="holder-board-title">
      <div className="panel-heading compact">
        <div>
          <h2 id="holder-board-title">Top holders</h2>
          <p>Explorer first page only · not a complete on-chain census · Dexscreener is not the source</p>
        </div>
        <Users size={18}/>
      </div>
      <div className="holder-grid">
        <HolderColumn symbol="FUEL" holders={holders.FUEL}/>
        <HolderColumn symbol="MORE" holders={holders.MORE}/>
      </div>
      <p className="activity-note">Percentages use the explorer-reported supply at fetch time. Missing rows stay unknown. Radar does not scan mint events to invent extra holders.</p>
    </section>
  )
}
