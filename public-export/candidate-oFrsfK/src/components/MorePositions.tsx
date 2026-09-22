import { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { fetchMoreStakes, MORE_STAKING, type MorePage } from '../lib/more'
import { dateCardClass } from '../lib/maturity'
import { PositionDateBadge } from './PositionStatus'

const date = (timestamp: bigint) => {
  const value = new Date(Number(timestamp) * 1000)
  return Number.isFinite(value.getTime()) ? value.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Date unavailable'
}
export function MorePositions({ address }: { address: string }) {
  const [page, setPage] = useState<MorePage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 30_000)
    return () => clearInterval(timer)
  }, [])
  async function read(more = false) {
    if (busy) return
    setBusy(true); setError('')
    if (!more) setPage(null)
    try {
      const result = await fetchMoreStakes(address, more ? page?.nextOffset ?? 0 : 0, more && page ? page : undefined)
      setPage(more && page ? { ...result, items: [...page.items, ...result.items] } : result)
    } catch { setError('MORE stake reads unavailable. This does not mean no stakes. Refresh to retry; retained pages still use their original block.') }
    finally { setBusy(false) }
  }
  return <section className="more-positions" aria-labelledby="more-positions-title">
    <div className="calendar-controls"><h3 id="more-positions-title">MORE stakes · Robinhood</h3><button disabled={busy} onClick={() => void read()}>{busy ? 'Reading MORE…' : page ? 'Refresh MORE stakes' : 'Load MORE stakes'}</button></div>
    <p>Same wallet, separate snapshot. Covers MORE token stakes only; other assets in the MORE app are excluded.</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {page && <>
      <p>Block {page.blockNumber.toString()} · {page.items.length} of {page.total} stake IDs checked · UTC dates</p>
      {page.total === 0 && <p>No MORE stake IDs returned at this block.</p>}
      {(page.nextOffset !== null || page.items.some(item => !item.stake)) && <p role="status" className="calendar-warning">Partial coverage: load remaining IDs or refresh failed reads.</p>}
      {page.items.map(item => <article className={item.stake ? dateCardClass(Number(item.stake.endTime), now) : 'position-card'} key={item.id.toString()}><div><span>MORE stake #{item.id.toString()}</span>{item.stake ? <>
        <strong>{formatUnits(item.stake.amount, page.decimals)} MORE · {item.stake.active ? 'Active' : 'Ended'}</strong>
        <small>Started {date(item.stake.startTime)}</small><small>Scheduled end {date(item.stake.endTime)}</small>
        <PositionDateBadge timestamp={Number(item.stake.endTime)} now={now} dueLabel={item.stake.active ? 'Past scheduled end' : 'Ended'}/>
        {!item.stake.active && item.stake.claimTime > 0n && <small>Recorded claim {date(item.stake.claimTime)}</small>}
      </> : <strong>Unavailable — stake read or owner check failed</strong>}</div></article>)}
      {page.nextOffset !== null && <div className="calendar-controls"><button disabled={busy} onClick={() => void read(true)}>Load more MORE stakes</button></div>}
    </>}
    <p>Dates and status are contract records; rewards, penalties and claim eligibility are not calculated. Due styling follows the scheduled end timestamp only. Contract and interface mapping: <a href="https://app.moretokens.com/" target="_blank" rel="noreferrer">official MORE app</a> · <a href={`https://robin.etherscan.io/address/${MORE_STAKING}`} target="_blank" rel="noreferrer">staking contract</a>. Source-code audit remains outstanding.</p>
  </section>
}
