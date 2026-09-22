import { useState } from 'react'
import { Calculator, RefreshCw } from 'lucide-react'
import { formatEther, formatGwei } from 'viem'
import { fetchPlannerQuote, parseBatchSize, type PlannerQuote } from '../lib/planner'
import { allocateFeeSplit } from '../lib/provenance'

const fee = (value: bigint | null) => value === null ? 'Unavailable' : `${formatEther(value)} ETH`
const utc = (value: number) => new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')

export function FeePreview() {
  const [count, setCount] = useState('1')
  const [quote, setQuote] = useState<PlannerQuote | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)

  async function refresh() {
    setQuote(null)
    setError('')
    let size: number
    try { size = parseBatchSize(count) } catch (cause) { setError((cause as Error).message); return }
    setLoading(true)
    try {
      setQuote(await fetchPlannerQuote(size))
      setNow(Date.now())
    } catch {
      setError('Unable to obtain a consistent chain quote. Refresh to retry; unavailable fees do not mean zero cost.')
    } finally {
      setLoading(false)
    }
  }

  const stale = quote !== null && Math.max(now - quote.fetchedAt, now - quote.timestamp * 1000) > 120_000
  const selected = quote?.rows.find(row => row.count === Number(count))
  const split = allocateFeeSplit(quote?.direct.mintFee ?? null)

  return (
    <section className="panel fee-preview" aria-labelledby="fee-preview-title">
      <div className="panel-heading compact">
        <div>
          <h2 id="fee-preview-title">View-only fee quote</h2>
          <p>Live mintFee / claimFee getters · no wallet · no transaction</p>
        </div>
        <Calculator size={18}/>
      </div>
      <form className="fee-preview-form" onSubmit={event => { event.preventDefault(); void refresh() }}>
        <label>
          Batch size for comparison
          <input aria-label="Fee preview batch size" inputMode="numeric" value={count} disabled={loading} onChange={event => { setCount(event.target.value); setQuote(null); setError('') }}/>
        </label>
        <button type="submit" disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>{loading ? 'Reading contracts…' : 'Refresh quote'}</button>
      </form>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!quote && !loading && <p className="planner-empty">Refresh to read current protocol fees. Nothing is sent; this panel never connects a wallet.</p>}
      {quote && <>
        <div className="planner-snapshot">
          <strong>{stale ? 'Older snapshot — refresh before using' : 'Contract snapshot'}</strong>
          <span>Block {quote.blockNumber.toString()} · {utc(quote.timestamp)}</span>
          <span>Gas-price input: {formatGwei(quote.gasPrice)} gwei (RPC observation at quote time)</span>
        </div>
        <div className="quote-lines" role="list">
          <div role="listitem"><span>Direct mint fee</span><strong>{fee(quote.direct.mintFee)}</strong></div>
          <div role="listitem"><span>Direct claim fee</span><strong>{fee(quote.direct.claimFee)}</strong></div>
          <div role="listitem"><span>Batch {selected?.count ?? count} mint fee</span><strong>{fee(selected?.mintFee ?? null)}</strong></div>
          <div role="listitem"><span>Batch {selected?.count ?? count} claim fee</span><strong>{fee(selected?.claimFee ?? null)}</strong></div>
        </div>
        <h3>Verified 45/25/30 routing of the quoted mint fee</h3>
        <p className="planner-copy">Derived from FeeDistributor BPS × the live mintFee getter. Integer division remainder is shown when nonzero. This is not a transaction preview and does not move ETH.</p>
        {split ? (
          <div className="quote-split">
            {split.shares.map(entry => (
              <div key={entry.key}><span>{entry.percent} · {entry.label}</span><strong>{formatEther(entry.share)} ETH</strong></div>
            ))}
            {split.remainder > 0n && <div><span>Integer remainder</span><strong>{formatEther(split.remainder)} ETH</strong></div>}
          </div>
        ) : <p className="planner-empty">Mint-fee split unavailable — the mintFee read failed.</p>}
      </>}
    </section>
  )
}
