import { useEffect, useState } from 'react'
import { fetchDailyFlows, type DailyFlowsResponse, type FlowEntry } from '../lib/minter'
import { formatUsd, shortAddress, timeAgo } from '../lib/format'

const fmtFuel = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—'
  const compact = value >= 1_000_000
  return (
    new Intl.NumberFormat('en-US', {
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 0,
    }).format(value) + ' FUEL'
  )
}

function FlowColumn({
  title,
  entries,
  total,
  totalLabel,
  onLookupWallet,
  empty,
}: {
  title: string
  entries: FlowEntry[] | null
  total: string
  totalLabel: string
  onLookupWallet: (address: string) => void
  empty: boolean
}) {
  return (
    <div className="holder-column">
      <header>
        <h3>{title}</h3>
        <strong>{total}</strong>
        <small>{totalLabel}</small>
      </header>
      {empty ? (
        <p className="holder-empty">Collecting today&apos;s flow…</p>
      ) : entries && entries.length > 0 ? (
        <ol>
          {entries.map((entry, index) => (
            <li key={`${entry.wallet}-${index}`}>
              <span className="holder-rank">{index + 1}</span>
              <button
                type="button"
                className="link-button mono"
                onClick={() => onLookupWallet(entry.wallet)}
                title="Look up in Cockpit"
              >
                {shortAddress(entry.wallet, 8, 6)}
              </button>
              <b>{fmtFuel(entry.fuel)}</b>
              <small>{entry.usd == null ? '~USD unavailable' : `~${formatUsd(entry.usd)}`}</small>
            </li>
          ))}
        </ol>
      ) : (
        <p className="holder-empty">No swaps recorded for this day yet.</p>
      )}
    </div>
  )
}

export function DailyFlowCards({ onLookupWallet }: { onLookupWallet: (address: string) => void }) {
  const [flows, setFlows] = useState<DailyFlowsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    fetchDailyFlows()
      .then((data) => {
        if (live) setFlows(data)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  const collecting = !failed && (!flows || flows.status === 'collecting')
  const freshness =
    flows?.through_block != null
      ? `Data through block ${Number(flows.through_block).toLocaleString('en-US')}${
          flows.through_time ? ` · ${timeAgo(flows.through_time)}` : ''
        }`
      : null

  return (
    <section className="panel" aria-labelledby="daily-flow-title">
      <div className="panel-heading compact">
        <div>
          <h2 id="daily-flow-title">Today&apos;s flow</h2>
          <p>
            Top FUEL buyers and sellers{flows ? ` · ${flows.date} ET` : ''}
            {freshness ? ` · ${freshness}` : ''}
          </p>
        </div>
      </div>
      {failed ? (
        <p className="activity-message" role="status">
          Today&apos;s flow could not be loaded. Please retry — this is not a confirmed empty day.
        </p>
      ) : (
        <div className="holder-grid">
          <FlowColumn
            title="Top buyers"
            entries={flows?.buyers ?? null}
            total={flows?.n_buys != null ? flows.n_buys.toLocaleString('en-US') : '—'}
            totalLabel="buy swaps today"
            onLookupWallet={onLookupWallet}
            empty={collecting}
          />
          <FlowColumn
            title="Top sellers"
            entries={flows?.sellers ?? null}
            total={flows?.n_sells != null ? flows.n_sells.toLocaleString('en-US') : '—'}
            totalLabel="sell swaps today"
            onLookupWallet={onLookupWallet}
            empty={collecting}
          />
        </div>
      )}
      {flows?.note && <p className="activity-note">{flows.note}</p>}
    </section>
  )
}
