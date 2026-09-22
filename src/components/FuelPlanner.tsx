import { useEffect, useState } from 'react'
import { Calculator, RefreshCw } from 'lucide-react'
import { formatEther, formatGwei } from 'viem'
import { CONTRACTS } from '../lib/contracts'
import { fetchPlannerQuote, parseBatchSize, parseStakeAmount, plannedDate, type PlannerQuote } from '../lib/planner'
import { allocateFeeSplit } from '../lib/provenance'

const fee = (value: bigint | null) => value === null ? 'Unavailable' : `${formatEther(value)} ETH`
const sum = (a: bigint | null, b: bigint | null) => a === null || b === null ? null : a + b
const utc = (value: string) => value.replace('T', ' ').replace('.000Z', ' UTC')

export function FuelPlanner() {
  const [count, setCount] = useState('10')
  const [days, setDays] = useState('7')
  const [amount, setAmount] = useState('1000')
  const [stakeDays, setStakeDays] = useState('30')
  const [quote, setQuote] = useState<PlannerQuote | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer) }, [])

  async function refresh() {
    setQuote(null)
    setError('')
    let size: number
    try { size = parseBatchSize(count) } catch (cause) { setError((cause as Error).message); return }
    setLoading(true)
    try { setQuote(await fetchPlannerQuote(size)); setNow(Date.now()) }
    catch { setError('Unable to obtain a consistent chain quote. Refresh to retry; unavailable fees do not mean zero cost.') }
    finally { setLoading(false) }
  }
  const mintDate = quote ? plannedDate(quote.timestamp, days) : null
  const stakeDate = quote ? plannedDate(quote.timestamp, stakeDays) : null
  const termValid = mintDate !== null && Number(days) >= 7 && quote?.maxMintTermSeconds !== null && quote !== null && BigInt(days) * 86_400n <= quote.maxMintTermSeconds
  let amountError = ''
  try { parseStakeAmount(amount) } catch (cause) { amountError = (cause as Error).message }
  const stale = quote !== null && Math.max(now - quote.fetchedAt, now - quote.timestamp * 1000) > 120_000
  const partial = quote !== null && [quote.direct.mintFee, quote.direct.claimFee, quote.maxMintTermSeconds, quote.currentApy, ...quote.rows.flatMap(row => [row.mintFee, row.claimFee])].some(value => value === null)
  const split = quote ? allocateFeeSplit(quote.direct.mintFee) : null

  return <section className="panel planner-panel" aria-labelledby="planner-title">
    <div className="panel-heading"><div><h2 id="planner-title">FUEL planner</h2><p>Compare protocol fees and hypothetical dates · read-only</p></div><Calculator size={20}/></div>
    <div className="planner-body">
      <div className="planner-notice"><strong>Reward calculations are not shown here</strong><p>Fee quotes come directly from the contracts at a pinned block. Late-claim penalty math is source-verified (see provenance docs) but Planner does not calculate rewards, penalties, or staking yield. MORE planning is not covered.</p></div>
      <form className="planner-form" onSubmit={event => { event.preventDefault(); void refresh() }}>
        <label>Batch size<input aria-label="Batch size" inputMode="numeric" value={count} disabled={loading} onChange={event => { setCount(event.target.value); setQuote(null); setError('') }}/><small>1–50 positions per comparison</small></label>
        <label>Mint duration (days)<input aria-label="Mint duration in days" inputMode="numeric" value={days} onChange={event => setDays(event.target.value)}/><small>Official app minimum: 7 days; maximum read below</small></label>
        <button type="submit" disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>{loading ? 'Reading contracts…' : 'Refresh fee comparison'}</button>
      </form>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!quote && !loading && <p className="planner-empty">Refresh to read fees and the chain timestamp. No example fees are prefilled.</p>}
      {quote && <>
        <div className="planner-snapshot"><strong>{stale ? 'Older snapshot — refresh before using' : partial ? 'Partial snapshot — some reads failed' : 'Contract snapshot'}</strong><span>Block {quote.blockNumber.toString()} · {utc(new Date(quote.timestamp * 1000).toISOString())}</span><span>Gas-price input: {formatGwei(quote.gasPrice)} gwei (RPC observation at quote time)</span></div>
        <h3>Mint, claim and remint fees</h3>
        <p className="planner-copy">Protocol charges only. Network transaction gas and total transaction cost are unavailable. Claim fees use today’s gas-price input; future fees may change. Duration does not enter these fee getters.</p>
        <div className="planner-table-scroll"><table className="planner-table"><caption>Batch protocol fee comparison in ETH</caption><thead><tr><th scope="col">Positions</th><th scope="col">Mint fee</th><th scope="col">Claim fee</th><th scope="col">Claim + remint fees</th></tr></thead><tbody>
          {quote.rows.map(row => <tr key={row.count} className={row.count === Number(count) ? 'chosen' : ''}><th scope="row">{row.count}{row.count === Number(count) ? ' · selected' : ''}</th><td>{fee(row.mintFee)}</td><td>{fee(row.claimFee)}</td><td>{fee(sum(row.mintFee, row.claimFee))}</td></tr>)}
        </tbody></table></div>
        <p className="planner-copy">Claim + remint adds the two displayed fee getters for the same number of slots. It does not establish that an existing position can be claimed or reminted.</p>
        <div className="planner-summary"><div><span>Direct single-mint fee</span><strong>{fee(quote.direct.mintFee)}</strong></div><div><span>Direct single-claim fee</span><strong>{fee(quote.direct.claimFee)}</strong></div><div><span>Current maximum mint term</span><strong>{quote.maxMintTermSeconds === null ? 'Unavailable' : `${quote.maxMintTermSeconds / 86_400n} days`}</strong></div></div>
        {split ? <div className="quote-split" aria-label="Verified fee-split of quoted mint fee">{split.shares.map(entry => <div key={entry.key}><span>{entry.percent} · {entry.label}</span><strong>{formatEther(entry.share)} ETH</strong></div>)}{split.remainder > 0n && <div><span>Integer remainder</span><strong>{formatEther(split.remainder)} ETH</strong></div>}</div> : <p className="planner-copy">Mint-fee split unavailable because the direct mintFee read failed.</p>}
        <p className="planner-copy">The 45/25/30 rows multiply the quoted mint fee by verified FeeDistributor BPS. They are not a send preview.</p>
        <div className="planner-date"><span>Hypothetical mint maturity</span><strong>{termValid ? utc(mintDate!) : 'Unavailable — enter 7 days through the current maximum'}</strong><small>If the mint started at the snapshot timestamp. Eligibility is not simulated.</small></div>
      </>}
      <div className="planner-stake">
        <h3>Stake duration plan</h3><p className="planner-copy">Explore an amount and date. This does not check your balance, an existing stake, or allowed contract durations.</p>
        <div className="planner-form"><label>FUEL amount<input aria-label="FUEL stake amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)}/></label><label>Stake duration (days)<input aria-label="Stake duration in days" inputMode="numeric" value={stakeDays} onChange={event => setStakeDays(event.target.value)}/><small>Calendar range: 1–3,650 days</small></label></div>
        {amountError && <p className="form-error">{amountError}</p>}
        <div className="planner-summary"><div><span>Current APY parameter</span><strong>{quote?.currentApy?.toString() ?? 'Unavailable'}</strong><small>Raw contract value; payout interpretation unverified</small></div><div><span>Estimated staking reward</span><strong>Unavailable — formula unverified</strong></div></div>
        <div className="planner-date"><span>Hypothetical stake maturity</span><strong>{!quote ? 'Refresh the fee comparison for a chain timestamp' : amountError || !stakeDate ? 'Enter a valid amount and whole-day duration' : utc(stakeDate)}</strong><small>Assumes the stake starts at the snapshot timestamp.</small></div>
      </div>
      <details className="planner-provenance"><summary>Sources and calculation limits</summary><p>FUEL: <a href={`https://robin.etherscan.io/address/${CONTRACTS[0].address}#code`} target="_blank" rel="noreferrer">token contract</a>. Batch fees: <a href={`https://robin.etherscan.io/address/${CONTRACTS[2].address}#code`} target="_blank" rel="noreferrer">BatchMinter contract</a>. Function signatures and the displayed minimum mint term come from the <a href="https://app.fuelmoretokens.com/" target="_blank" rel="noreferrer">official FUEL app</a>. Penalty schedule and fee split: <code>docs/provenance/CONTRACT_PROVENANCE.md</code>.</p><p>All contract calls in a quote use one block. The gas-price input is a separate RPC observation. Quotes do not verify the full implementation or simulate transactions. No reward model, price forecast, or network gas estimate is included.</p></details>
    </div>
  </section>
}
