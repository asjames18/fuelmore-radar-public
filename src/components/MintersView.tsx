import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { fetchMinters, type MinterRow } from '../lib/minter'
import { shortAddress, timeAgo, isFreshnessStale } from '../lib/format'

type SortKey = 'claimed' | 'sold' | 'bought' | 'pct_sold' | 'remint_count' | 'last_active_ts'
type Dir = 'asc' | 'desc'

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'claimed', label: 'Claimed' },
  { key: 'sold', label: 'Sold' },
  { key: 'bought', label: 'Bought' },
  { key: 'pct_sold', label: '% sold' },
  { key: 'remint_count', label: 'Re-minted' },
  { key: 'last_active_ts', label: 'Last active' },
]

const fmtFuel = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—'
  const compact = value >= 1_000_000
  return new Intl.NumberFormat('en-US', {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value)
}

const fmtPct = (value: number | null) =>
  value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`

const fmtActive = (ts: number | null) => {
  if (ts == null || !Number.isFinite(ts)) return '—'
  return timeAgo(new Date(ts * 1000).toISOString())
}

const fmtThrough = (block: string | null, time: string | null) => {
  if (!block) return null
  return `Data through block ${Number(block).toLocaleString('en-US')}${time ? ` · ${timeAgo(time)}` : ''}`
}

export function MintersView({ onLookupWallet }: { onLookupWallet: (address: string) => void }) {
  const [rows, setRows] = useState<MinterRow[] | null>(null)
  const [methodology, setMethodology] = useState('')
  const [freshness, setFreshness] = useState<string | null>(null)
  const [syncPaused, setSyncPaused] = useState(false)
  const [sort, setSort] = useState<SortKey>('sold')
  const [dir, setDir] = useState<Dir>('desc')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    async function load() {
      setFailed(false)
      setSyncPaused(false)
      try {
        const data = await fetchMinters(sort, dir, 100)
        if (!live) return
        setRows(data.rows)
        setMethodology(data.methodology)
        setFreshness(fmtThrough(data.through_block, data.through_time))
        // The minter feed is worker-owned like market data: flag it paused when
        // the newest collected point is older than the stale threshold, instead
        // of letting a bare old timestamp imply the table is current.
        setSyncPaused(isFreshnessStale(data.through_time ? Date.parse(data.through_time) : null))
      } catch {
        if (live) setFailed(true)
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [sort, dir])

  function toggleSort(key: SortKey) {
    if (key === sort) {
      setDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSort(key)
      setDir('desc')
    }
  }

  return (
    <section className="panel" aria-labelledby="minters-title">
      <div className="panel-heading">
        <div>
          <h2 id="minters-title">Minters</h2>
          <p>Wallets that claimed FUEL from mints — claimed, sold, bought, and re-minted</p>
        </div>
      </div>
      {failed ? (
        <p className="activity-message" role="status">
          Minter data could not be loaded. This does not mean no minters exist — please retry.
        </p>
      ) : rows === null ? (
        <p className="activity-message" role="status">Collecting minter data…</p>
      ) : rows.length === 0 ? (
        <p className="activity-message" role="status">Collecting minter data…</p>
      ) : (
        <div className="activity-table-wrap">
          <table className="daily-activity-table minter-table">
            <caption className="muted">
              {rows.length} minter{rows.length === 1 ? '' : 's'}
              {freshness ? ` · ${freshness}` : ''}
              {syncPaused && (
                <>
                  {' · '}
                  <small className="sync-paused-note">Syncing paused — showing last available data</small>
                </>
              )}
            </caption>
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                {COLUMNS.map(({ key, label }) => (
                  <th scope="col" key={key} aria-sort={sort === key ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => toggleSort(key)}
                      aria-label={`Sort by ${label}`}
                    >
                      {label}
                      {sort === key &&
                        (dir === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.wallet}>
                  <td>
                    <button
                      type="button"
                      className="link-button mono"
                      onClick={() => onLookupWallet(row.wallet)}
                      title="Look up in Cockpit"
                    >
                      {shortAddress(row.wallet, 8, 6)}
                    </button>
                  </td>
                  <td className="mono">{fmtFuel(row.claimed)}</td>
                  <td className="mono">{fmtFuel(row.sold)}</td>
                  <td className="mono">{fmtFuel(row.bought)}</td>
                  <td className="mono">{fmtPct(row.pct_sold)}</td>
                  <td className="mono">
                    {row.remint_count == null ? (
                      '—'
                    ) : (
                      <>
                        {row.remint_count.toLocaleString('en-US')}
                        {row.remint_eth != null && (
                          <>
                            <br />
                            <small className="muted">{row.remint_eth.toFixed(4)} ETH</small>
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>{fmtActive(row.last_active_ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {methodology && <p className="activity-note">{methodology}</p>}
    </section>
  )
}
