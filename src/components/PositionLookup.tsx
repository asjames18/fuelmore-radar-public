import { MorePositions } from './MorePositions'
import { WalletCalendar } from './WalletCalendar'
import { FeePreview } from './FeePreview'
import { dateCardClass, mintCardClass } from '../lib/maturity'
import { PositionDateBadge, PositionMintBadge } from './PositionStatus'
import { normalizeWatchlist, readWatchlist, saveWatchlist } from '../lib/watchlist'
import { isAddress } from 'viem'
import { useEffect, useState } from 'react'
import { CalendarClock, Search, WalletCards } from 'lucide-react'
import { fetchWalletPosition } from '../lib/api'
import { track } from '../lib/analytics'
import { formatToken, shortAddress } from '../lib/format'
import type { WalletPosition } from '../lib/types'

export function PositionLookup({ defaultWallet = '' }: { defaultWallet?: string }) {
  const [address, setAddress] = useState<string>(defaultWallet)
  const [position, setPosition] = useState<WalletPosition | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>(defaultWallet ? 'loading' : 'idle')
  const [message, setMessage] = useState('')
  const [watchlist, setWatchlist] = useState(readWatchlist)
  const [watchMessage, setWatchMessage] = useState('')
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 30_000)
    return () => clearInterval(timer)
  }, [])

  async function lookupWallet(candidate: string) {
    const input = candidate.trim()
    if (status === 'loading') return
    if (!isAddress(input)) { setPosition(null); setStatus('error'); setMessage('Enter a valid EVM wallet address.'); return }
    track('wallet_lookup')
    setAddress(input)
    setPosition(null)
    setStatus('loading')
    setMessage('')
    try {
      const result = await fetchWalletPosition(input)
      setPosition(result)
      setStatus('idle')
    } catch {
      setPosition(null)
      setStatus('error')
      setMessage('Unable to read the chain. Please retry; this does not mean the wallet has no positions.')
    }
  }

  useEffect(() => {
    if (!defaultWallet) return
    let stopped = false
    async function preload() {
      try {
        const result = await fetchWalletPosition(defaultWallet)
        if (stopped) return
        setPosition(result)
        setStatus('idle')
      } catch {
        if (stopped) return
        setPosition(null)
        setStatus('error')
        setMessage('Unable to read the chain. Please retry; this does not mean the wallet has no positions.')
      }
    }
    void preload()
    return () => { stopped = true }
  }, [defaultWallet])

  function updateWatchlist(next: string[]) {
    setWatchlist(next)
    setWatchMessage(saveWatchlist(next) ? 'Watchlist saved in this browser.' : 'Changes are temporary; browser storage is unavailable.')
  }
  function saveAddress() {
    if (!isAddress(address.trim())) { setWatchMessage('Enter a valid wallet address to save.'); return }
    const normalized = normalizeWatchlist([address.trim()])[0]
    if (watchlist.includes(normalized)) { setWatchMessage('This wallet is already saved.'); return }
    if (watchlist.length >= 50) { setWatchMessage('Watchlist limit reached: remove a wallet before adding another.'); return }
    updateWatchlist([...watchlist, normalized])
  }

  async function loadMore() {
    if (!position || position.batch.nextOffset === null || status === 'loading') return
    setStatus('loading')
    setMessage('')
    try {
      const next = await fetchWalletPosition(position.address, position.batch.nextOffset, { blockNumber: position.blockNumber, blockHash: position.blockHash })
      if (next.batch.total === null) throw new Error('Batch read unavailable')
      setPosition({ ...position, batch: { ...next.batch, items: [...position.batch.items, ...next.batch.items] } })
      setStatus('idle')
    } catch { setStatus('error'); setMessage('Unable to load the next batch page. Existing results remain visible; retry Load more.') }
  }

  const maturity = position?.mint?.maturityTs ? new Date(Number(position.mint.maturityTs) * 1000) : null
  const stakeMaturity = position?.stake?.maturityTs ? new Date(Number(position.stake.maturityTs) * 1000) : null

  return (
    <section className="panel positions-panel" aria-labelledby="positions-title">
      <div className="panel-heading">
        <div><h2 id="positions-title">Wallet position lookup</h2><p>Read public positions without connecting a wallet</p></div>
        <WalletCards size={20}/>
      </div>
      <form className="lookup-form" onSubmit={event => { event.preventDefault(); void lookupWallet(address) }}>
        <label htmlFor="wallet-address">Robinhood Chain wallet</label>
        <div><input id="wallet-address" disabled={status === 'loading'} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x…" spellCheck={false}/><button type="submit" disabled={status === 'loading'}><Search size={16}/>{status === 'loading' ? 'Reading…' : 'Look up'}</button></div>
        {message && <p className="form-error">{message}</p>}
      </form>
      <div className="wallet-watchlist">
        <div className="calendar-controls"><h3>Saved wallets</h3><button onClick={saveAddress}>Save entered wallet</button></div>
        <p>Stored only in this browser. Select a wallet to fetch its current positions.</p>
        {watchMessage && <p role="status">{watchMessage}</p>}
        <div className="watchlist-items">{watchlist.map(saved => <div key={saved}>
          <button disabled={status === 'loading'} title={saved} onClick={() => void lookupWallet(saved)}>{shortAddress(saved, 8, 6)}</button>
          <button aria-label={`Remove saved wallet ${shortAddress(saved, 8, 6)}`} onClick={() => updateWatchlist(watchlist.filter(item => item !== saved))}>×</button>
        </div>)}</div>
      </div>
      {position ? <div className="position-results">
        <div className="position-summary"><span>Address</span><strong className="mono">{shortAddress(position.address, 10, 8)}</strong></div>
        <div className="position-summary"><span>FUEL balance</span><strong>{formatToken(position.fuelBalance, 2)}</strong></div>
        <article className={position.mint ? mintCardClass(Number(position.mint.maturityTs), now) : 'position-card'}>
          <CalendarClock size={19}/><div><span>Direct FUEL mint</span>{position.mint ? <><strong>Rank #{position.mint.rank.toString()}</strong><small>Matures {maturity?.toLocaleString()}</small><PositionMintBadge maturityTs={Number(position.mint.maturityTs)} now={now}/></> : <strong>{position.reads.mint ? 'None at this block' : 'Unavailable — read failed'}</strong>}</div>
        </article>
        <article className={position.stake ? dateCardClass(Number(position.stake.maturityTs), now) : 'position-card'}>
          <WalletCards size={19}/><div><span>Direct FUEL stake</span>{position.stake ? <><strong>{formatToken(position.stake.amount, 2)} FUEL · {position.stake.apy.toString()}% APY</strong><small>Matures {stakeMaturity?.toLocaleString()}</small><PositionDateBadge timestamp={Number(position.stake.maturityTs)} now={now} dueLabel="Matured"/><small>Stake dates only — mint late-penalty does not apply here.</small></> : <strong>{position.reads.stake ? 'None at this block' : 'Unavailable — read failed'}</strong>}</div>
        </article>
        <WalletCalendar key={position.address} position={position}/>
        <MorePositions key={`more-${position.address}`} address={position.address}/>
        <FeePreview/>
        <div className="batch-positions">
          <h3>Batch FUEL mints</h3>
          <p>Snapshot block {position.blockNumber.toString()} · {position.batch.total === null ? 'Batch inventory unavailable' : `${position.batch.items.length} of ${position.batch.total} proxy slots checked`}</p>
          <p>All values use the same block; maturity times use your browser’s timezone. Due / late badges use the verified mint penalty schedule and do not display claim amounts. MORE stakes have their own lookup and snapshot above.</p>
          {position.batch.total === 0 && <p>No batch proxy slots at this block.</p>}
          {position.batch.items.map(item => <article className={item.available && item.mint ? mintCardClass(Number(item.mint.maturityTs), now) : 'position-card'} key={item.index}>
            <CalendarClock size={18}/><div><span>Slot {item.index + 1} · {item.proxy ? shortAddress(item.proxy) : 'Address unavailable'}</span>
            {!item.available ? <strong>Unavailable — retry the lookup</strong> : item.mint ? <><strong>Rank #{item.mint.rank.toString()}</strong><small>Matures {new Date(Number(item.mint.maturityTs) * 1000).toLocaleString()}</small><PositionMintBadge maturityTs={Number(item.mint.maturityTs)} now={now}/></> : <strong>No active mint at this block</strong>}</div>
          </article>)}
          {position.batch.nextOffset !== null && <button onClick={() => void loadMore()} disabled={status === 'loading'}>{status === 'loading' ? 'Reading…' : 'Load more batch slots'}</button>}
        </div>
      </div> : <div className="position-empty"><Search size={28}/><strong>{status === 'loading' ? 'Reading positions from the chain…' : 'Paste any public address'}</strong><span>No wallet connection, signature, or private information is required.</span></div>}
    </section>
  )
}
