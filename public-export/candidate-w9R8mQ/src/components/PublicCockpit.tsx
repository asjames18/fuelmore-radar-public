import { useEffect, useMemo, useRef, useState } from 'react'
import { isAddress } from 'viem'
import { cockpitError } from '../lib/cockpitError'
import { ExternalLink, RefreshCw, Wallet } from 'lucide-react'
import {
  estimateSlotRewards,
  fetchCockpitSnapshotSmart,
  groupSlotsByUtcDay,
  type CockpitSnapshot,
} from '../lib/cockpit'
import { bandLabel, buildSafeSellGuide, buildSellInsight, fuelToUsd, splitSellPieces } from '../lib/sellInsight'
import { BLOCKSCOUT, DEXSCREENER, PAIRS, uniswapBuyFuelUrl, uniswapSellFuelUrl } from '../lib/contracts'
import { formatChange, formatToken, formatUsd, shortAddress } from '../lib/format'
import { normalizeWatchlist, readWatchlist, saveWatchlist } from '../lib/watchlist'
import type { RadarData } from '../lib/types'

function daysUntil(ts: number | null, now: number) {
  if (ts == null) return '—'
  const days = (ts - now) / 86_400
  if (days < 0) return `${Math.abs(days).toFixed(1)}d overdue`
  return `${days.toFixed(1)}d`
}

export function PublicCockpit({ data }: { data: RadarData }) {
  const requestRef = useRef<AbortController | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [walletInput, setWalletInput] = useState<string>('')
  const [activeWallet, setActiveWallet] = useState<string>('')
  const [cockpit, setCockpit] = useState<CockpitSnapshot | null>(null)
  // Ref mirror for incremental refresh: the effect closure must not depend on
  // `cockpit` state or it would re-run on every snapshot.
  const cockpitRef = useRef<CockpitSnapshot | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [progress, setProgress] = useState('Loading your mint inventory…')
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [reloadKey, setReloadKey] = useState(0)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [sellSlots, setSellSlots] = useState(1)
  const [watchlist, setWatchlist] = useState(readWatchlist)
  const [watchMessage, setWatchMessage] = useState('')
  const [includeLiquid, setIncludeLiquid] = useState(false)
  const [rewardById, setRewardById] = useState<Record<string, { grossWei: bigint | null; netWei: bigint | null; penaltyPct: number }>>({})
  const [rewardIncomplete, setRewardIncomplete] = useState(false)
  const [rewardStatus, setRewardStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [rewardProgress, setRewardProgress] = useState('')


  useEffect(() => {
    if (!activeWallet) return
    let stopped = false
    const controller = new AbortController()
    requestRef.current = controller
    const deadline = window.setTimeout(() => controller.abort('timeout'), 5 * 60_000)
    async function poll() {
      try {
        const { snapshot: next } = await fetchCockpitSnapshotSmart(activeWallet, message => {
          if (!stopped) setProgress(message)
        }, { signal: controller.signal, previous: cockpitRef.current })
        if (stopped) return
        setCockpit(next)
        cockpitRef.current = next
        setStatus('ready')
        setError(null)
        setProgress('')
        setNowMs(Date.now())
        const days = groupSlotsByUtcDay(next.slots)
        const due = days.find(day => Date.parse(`${day.date}T00:00:00Z`) / 1000 <= next.observedAt)
        setSelectedDay(due?.date ?? days[0]?.date ?? null)
        setSellSlots(Math.max(1, due?.count ?? days[0]?.count ?? 1))
        setRewardById({})
        setRewardStatus('idle')

        if (next.globalRank != null && next.slots.length > 0) {
          setRewardStatus('loading')
          setRewardProgress('Estimating claimable FUEL for all unlock days…')
          try {
            const estimate = await estimateSlotRewards({
              slots: next.slots,
              globalRank: next.globalRank,
              nowTs: next.observedAt,
              blockNumber: next.slotsPinnedBlockNumber,
              blockHash: next.slotsPinnedBlockHash,
              signal: controller.signal,
              onProgress: message => { if (!stopped) setRewardProgress(message) },
            })
            if (stopped) return
            const map: Record<string, { grossWei: bigint | null; netWei: bigint | null; penaltyPct: number }> = {}
            for (const row of estimate.perSlot) map[row.id] = row
            setRewardById(map)
            setRewardIncomplete(estimate.incomplete)
            setRewardStatus('ready')
            setRewardProgress('')
          } catch {
            if (!stopped) {
              setRewardStatus('error')
              setRewardProgress('')
              if (controller.signal.aborted) setError(controller.signal.reason === 'timeout' ? 'Reading timed out. Retry to start a new snapshot.' : 'Reading cancelled. Load or refresh to start again.')
            }
          }
        }
      } catch (cause) {
        if (stopped) return
        setStatus(previous => (previous === 'ready' ? 'ready' : 'error'))
        setError(controller.signal.aborted
          ? controller.signal.reason === 'timeout' ? 'Reading timed out. Retry to start a new snapshot.' : 'Reading cancelled. Load or refresh to start again.'
          : cockpitError(cause))
        setProgress('')
      } finally {
        window.clearTimeout(deadline)
      }
    }
    void poll()
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => {
      stopped = true
      controller.abort()
      window.clearTimeout(deadline)
      window.clearInterval(timer)
    }
  }, [activeWallet, reloadKey])

  const fuel = data.pairs.find(pair => pair.symbol === 'FUEL')
  const now = cockpit?.observedAt ?? Math.floor(nowMs / 1000)
  const dayGroups = useMemo(() => (cockpit ? groupSlotsByUtcDay(cockpit.slots) : []), [cockpit])
  const selectedGroup = dayGroups.find(day => day.date === selectedDay) ?? null
  const priceUsd = fuel?.priceUsd ?? null

  function dayNet(slots: { id: string }[]) {
    let total = 0n
    let known = 0
    for (const slot of slots) {
      const row = rewardById[slot.id]
      if (row?.netWei != null) {
        total += row.netWei
        known++
      }
    }
    return { total, known, missing: slots.length - known }
  }

  const selectedDayReward = selectedGroup ? dayNet(selectedGroup.slots) : { total: 0n, known: 0, missing: 0 }
  const modeledUnlock = (() => {
    if (!selectedGroup || selectedGroup.count === 0 || selectedDayReward.known === 0) return 0n
    const n = Math.min(Math.max(1, sellSlots), selectedGroup.count)
    // Pro-rate from known net across the day's slot count.
    return (selectedDayReward.total * BigInt(n)) / BigInt(selectedGroup.count)
  })()
  const liquidPart = includeLiquid && cockpit?.fuelBalance != null && cockpit.fuelBalance > 0n ? cockpit.fuelBalance : 0n
  const sellAmount = modeledUnlock + liquidPart
  const insight = buildSellInsight({
    fuelAmount: sellAmount,
    priceUsd,
    liquidityUsd: fuel?.liquidityUsd ?? null,
  })
  const safeGuide = buildSafeSellGuide({
    selectedFuel: sellAmount,
    priceUsd,
    liquidityUsd: fuel?.liquidityUsd ?? null,
  })
  const pieces = splitSellPieces(sellAmount, 4)

  const dueSlots = cockpit?.slots.filter(slot => Number(slot.maturityTs) <= now) ?? []
  const dueReward = dayNet(dueSlots)
  const todaySellAmount = dueReward.total + (cockpit?.fuelBalance != null && cockpit.fuelBalance > 0n ? cockpit.fuelBalance : 0n)
  const todayInsight = buildSellInsight({
    fuelAmount: todaySellAmount,
    priceUsd,
    liquidityUsd: fuel?.liquidityUsd ?? null,
  })
  const todaySafe = buildSafeSellGuide({
    selectedFuel: todaySellAmount,
    priceUsd,
    liquidityUsd: fuel?.liquidityUsd ?? null,
  })

  function applyWallet(candidate: string) {
    const value = candidate.trim()
    if (!isAddress(value)) {
      setError('Enter a valid EVM wallet address.')
      return
    }
    requestRef.current?.abort()
    setStartedAt(Date.now())
    setNowMs(Date.now())
    setError(null)
    setWalletInput(value)
    setActiveWallet(value)
    setCockpit(null)
    setRewardById({})
    setRewardStatus('idle')
    setStatus('loading')
    setProgress('Loading mint inventory…')
    setReloadKey(value => value + 1)
  }

  function updateWatchlist(next: string[]) {
    setWatchlist(next)
    setWatchMessage(saveWatchlist(next) ? 'Watchlist saved in this browser.' : 'Changes are temporary; browser storage is unavailable.')
  }

  function saveAddress() {
    const candidate = (activeWallet || walletInput).trim()
    if (!isAddress(candidate)) { setWatchMessage('Enter a valid wallet address to save.'); return }
    const normalized = normalizeWatchlist([candidate])[0]
    if (watchlist.includes(normalized)) { setWatchMessage('This wallet is already saved.'); return }
    if (watchlist.length >= 50) { setWatchMessage('Watchlist limit reached: remove a wallet before adding another.'); return }
    updateWatchlist([...watchlist, normalized])
  }

  return <div className="cockpit-page">
    <section className="panel cockpit-toolbar-panel" aria-labelledby="cockpit-title">
      <div className="cockpit-toolbar">
        <div className="cockpit-target-info">
          <div className="cockpit-badge-row">
            <span className="cockpit-target-badge custom">Wallet lookup</span>
            {activeWallet && <>
              <span className="cockpit-target-address">{shortAddress(activeWallet, 10, 8)}</span>
              <a href={`${BLOCKSCOUT}/address/${activeWallet}`} target="_blank" rel="noreferrer" className="icon-link" aria-label="Open wallet on Blockscout"><ExternalLink size={16}/></a>
            </>}
          </div>
          <h2 id="cockpit-title">FUEL wallet cockpit</h2>
          <p className="cockpit-subtext">On-chain inventory and claim amounts, valued with Dexscreener’s pool snapshot (itself on-chain-derived) — indicative value, not an executable quote.</p>
        </div>
        <div className="cockpit-toolbar-controls">
          <form className="cockpit-search-form" onSubmit={event => { event.preventDefault(); applyWallet(walletInput) }}>
            <label htmlFor="cockpit-wallet">Wallet</label>
            <div>
              <input id="cockpit-wallet" value={walletInput} onChange={event => setWalletInput(event.target.value)} spellCheck={false} disabled={status === 'loading'} placeholder="0x…"/>
              <button type="submit" disabled={status === 'loading'}>Load</button>
            </div>
          </form>
          <button className="refresh" onClick={() => {
            setStartedAt(Date.now())
            setStatus('loading')
            setError(null)
            setProgress('Loading your mint inventory…')
            setReloadKey(value => value + 1)
          }} disabled={!activeWallet || status === 'loading' || rewardStatus === 'loading'}>
            <RefreshCw size={16} className={status === 'loading' ? 'spin' : ''}/><span>Refresh</span>
          </button>
          {(status === 'loading' || rewardStatus === 'loading') && <button className="refresh" onClick={() => requestRef.current?.abort('cancelled')}>Cancel reading</button>}
        </div>
      </div>
      <div className="wallet-watchlist">
        <div className="calendar-controls"><h3>Saved wallets</h3><button type="button" onClick={saveAddress}>Save entered wallet</button></div>
        <p>Stored only in this browser. Select a wallet to load its inventory.</p>
        {watchMessage && <p role="status">{watchMessage}</p>}
        <div className="watchlist-items">{watchlist.map(saved => <div key={saved}>
          <button type="button" disabled={status === 'loading'} title={saved} onClick={() => applyWallet(saved)}>{shortAddress(saved, 8, 6)}</button>
          <button type="button" aria-label={`Remove saved wallet ${shortAddress(saved, 8, 6)}`} onClick={() => updateWatchlist(watchlist.filter(item => item !== saved))}>×</button>
        </div>)}</div>
      </div>
    </section>

    {error && <p className="activity-message" role="status">{error}</p>}
    {status === 'idle' && <p className="activity-message">Enter a wallet to read its mint inventory.</p>}
    {status === 'loading' && <p className="activity-message" role="status">{progress} · {startedAt ? Math.max(0, Math.floor((nowMs - startedAt) / 1000)) : 0}s elapsed · Large wallets can take several minutes. Completed counts update as each group finishes.</p>}

    {cockpit && <>
    <p className="activity-note">{nowMs / 1000 - cockpit.observedAt > 120 ? 'Older snapshot — refresh when needed. ' : ''}Inventory observed {new Date(cockpit.observedAt * 1000).toISOString()} · block {cockpit.blockNumber.toString()}. Market values use the separate Dexscreener snapshot.</p>
    <section className="panel cockpit-metrics-panel">
      <div className="cockpit-metrics">
        <div><span>Active mints</span><strong>{cockpit ? `${cockpit.sampleIncomplete ? 'At least ' : ''}${cockpit.activeMints.toLocaleString()}` : '—'}</strong><small>{cockpit?.batchTotal != null ? `${cockpit.batchTotal} batch slots` : 'Batch scan pending'}</small></div>
        <div><span>Next maturity</span><strong>{daysUntil(cockpit?.nextMaturityTs ?? null, now)}</strong><small>{cockpit?.nextMaturityTs ? new Date(cockpit.nextMaturityTs * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'}</small></div>
        <div><span>Due / late</span><strong>{cockpit ? cockpit.dueOrLate.toLocaleString() : '—'}</strong><small>{cockpit && cockpit.maxLatePenaltyPct > 0 ? `Penalty up to ${cockpit.maxLatePenaltyPct}%` : 'Penalty curve after maturity'}</small></div>
        <div><span>Liquid FUEL</span><strong>{formatToken(cockpit?.fuelBalance ?? null, 2)}</strong><small>On-chain balance</small></div>
        <div><span>FUEL 24h</span><strong className={fuel?.change24h == null ? '' : fuel.change24h >= 0 ? 'positive' : 'negative'}>{formatChange(fuel?.change24h ?? null)}</strong><small>Dex · liq {formatUsd(fuel?.liquidityUsd ?? null, true)}</small></div>
        <div><span>Block</span><strong>{cockpit ? cockpit.blockNumber.toString() : '—'}</strong><small><Wallet size={12}/> snapshot</small></div>
      </div>
    </section>

    {cockpit && <div className="cockpit-buckets" aria-label="Maturity buckets">
      {cockpit.buckets.map(bucket => <div key={bucket.key} className={bucket.count > 0 ? 'active' : ''}>
        <span>{bucket.label}</span><strong>{bucket.count.toLocaleString()}</strong>
        <small>{bucket.earliestTs ? daysUntil(bucket.earliestTs, now) : '—'}</small>
      </div>)}
    </div>}

    {cockpit?.sampleIncomplete && <p className="activity-note">Some proxy slots failed to read — counts may be incomplete. Refresh to retry.</p>}

    {rewardStatus === 'ready' && !rewardIncomplete && !cockpit.sampleIncomplete && cockpit.fuelBalance !== null && <section className="panel cockpit-today-panel" aria-labelledby="today-sell-title">
      <div className="panel-heading">
        <div>
          <h2 id="today-sell-title">If you claim &amp; sell now</h2>
          <p>On-chain due/late unlocks + liquid balance, valued at Dexscreener’s pool snapshot · Uniswap on Robinhood Chain is the trade venue</p>
        </div>
        <div className="cockpit-trade-links">
          <a href={uniswapSellFuelUrl()} target="_blank" rel="noreferrer">Sell on Uniswap</a>
          <a href={uniswapBuyFuelUrl()} target="_blank" rel="noreferrer">Buy on Uniswap</a>
          <a href={`${DEXSCREENER}/${PAIRS.fuel}`} target="_blank" rel="noreferrer">Pool on Dexscreener</a>
        </div>
      </div>
      <div className="cockpit-today-grid">
        <div><span>Due / late slots</span><strong>{dueSlots.length.toLocaleString()}</strong><small>On-chain · unlockable at this block</small></div>
        <div><span>Estimated claim (net)</span><strong>{formatToken(dueReward.total, 2)}</strong><small>{formatUsd(fuelToUsd(dueReward.total, priceUsd))} · on-chain FUEL × Dex price</small></div>
        <div><span>Liquid FUEL</span><strong>{formatToken(cockpit?.fuelBalance ?? null, 2)}</strong><small>{formatUsd(fuelToUsd(cockpit?.fuelBalance ?? null, priceUsd))} · balance on-chain</small></div>
        <div><span>Combined if sold now</span><strong>{formatToken(todaySellAmount, 2)}</strong><small>{formatUsd(todayInsight.notionalUsd)} · {todayInsight.shareOfLiquidity == null ? '—' : `${(todayInsight.shareOfLiquidity * 100).toFixed(2)}% of Dex pool`}</small></div>
      </div>
      <div className={`cockpit-sell-insight band-${todayInsight.band}`}>
        <div>
          <span>Illustrative safer clip (~0.5% of pool)</span>
          <strong>{formatToken(todaySafe.safeFuel, 2)} FUEL</strong>
          <small>{formatUsd(todaySafe.safeUsd)}</small>
        </div>
        <div>
          <span>Caution band (~2% of pool)</span>
          <strong>{formatToken(todaySafe.cautionFuel, 2)} FUEL</strong>
          <small>{formatUsd(todaySafe.cautionUsd)}</small>
        </div>
        <p>{todaySafe.detail} {todayInsight.detail} Not an executable Uniswap quote — open Uniswap on Robinhood Chain to see live price impact.</p>
      </div>
    </section>

    }
    {rewardStatus === 'loading' && <p role="status">{rewardProgress} · Reward reads may take several minutes.</p>}
    {rewardStatus === 'error' && <p role="status">Reward reads unavailable. Inventory dates remain visible.</p>}
    <section className="panel cockpit-inventory-panel" aria-labelledby="inventory-title">
      <div className="panel-heading">
        <div>
          <h2 id="inventory-title">Claims by unlock day · market value</h2>
          <p>On-chain net FUEL per day; USD uses Dexscreener price (on-chain pool mirror). Pick a day to size a partial sell vs that pool depth.</p>
        </div>
      </div>
      {!cockpit ? <p className="activity-note">Inventory loads after the batch scan finishes.</p> : dayGroups.length === 0 ? <p className="activity-note">{cockpit.sampleIncomplete ? 'Inventory unavailable or incomplete. This is not a confirmed empty wallet.' : 'No active mints at this block.'}</p> : <>
        <div className="cockpit-day-picker" role="listbox" aria-label="Unlock days">
          {dayGroups.map(day => {
            const due = Date.parse(`${day.date}T00:00:00Z`) / 1000 <= now
            const value = dayNet(day.slots)
            return <button
              key={day.date}
              type="button"
              role="option"
              aria-selected={selectedDay === day.date}
              className={`${selectedDay === day.date ? 'selected' : ''} ${due ? 'due' : ''}`}
              onClick={() => { setSelectedDay(day.date); setSellSlots(day.count) }}
            >
              <strong>{day.date}</strong>
              <span>{day.count} slot{day.count === 1 ? '' : 's'}</span>
              <span>{rewardStatus === 'ready' && value.missing === 0 ? formatToken(value.total, 2) : '—'} FUEL</span>
              <small>{rewardStatus === 'ready' && value.missing === 0 ? formatUsd(fuelToUsd(value.total, priceUsd)) : (due ? 'Due / unlockable' : 'Upcoming')}</small>
            </button>
          })}
        </div>

        {selectedGroup && <div className="cockpit-day-detail">
          <div className="cockpit-day-summary">
            <div><span>Selected day</span><strong>{selectedGroup.date} UTC</strong><small>{Date.parse(`${selectedGroup.date}T00:00:00Z`) / 1000 <= now ? 'Claimable now (if past maturity)' : 'Not mature yet — estimate if claimed later at today’s rules'}</small></div>
            <div><span>Slots that day</span><strong>{selectedGroup.count}</strong></div>
            <div><span>Day total (net)</span><strong>{rewardStatus !== 'ready' || selectedDayReward.missing ? '—' : formatToken(selectedDayReward.total, 2)}</strong><small>{rewardStatus !== 'ready' || selectedDayReward.missing ? '—' : formatUsd(fuelToUsd(selectedDayReward.total, priceUsd))} · on-chain getGrossReward − late penalty × Dex price</small></div>
            {rewardStatus === 'ready' && !rewardIncomplete && !cockpit.sampleIncomplete && cockpit.fuelBalance !== null && <div><span>Selected sell size</span><strong>{formatToken(sellAmount, 2)}</strong><small>{formatUsd(insight.notionalUsd)} · {insight.shareOfLiquidity == null ? '—' : `${(insight.shareOfLiquidity * 100).toFixed(2)}% of Dex pool`}</small></div>}
          </div>
          {rewardIncomplete && rewardStatus === 'ready' && <p className="activity-note">Some slot reward reads failed — day totals may be incomplete.</p>}

          {rewardStatus === 'ready' && !rewardIncomplete && !cockpit.sampleIncomplete && cockpit.fuelBalance !== null && <>
          <div className="cockpit-sell-controls">
            <label>
              How many of this day’s slots to model selling
              <input
                type="range"
                min={1}
                max={Math.max(1, selectedGroup.count)}
                value={Math.min(sellSlots, selectedGroup.count)}
                onChange={event => setSellSlots(Number(event.target.value))}
                disabled={selectedGroup.count === 0}
              />
              <strong>{Math.min(sellSlots, selectedGroup.count)} / {selectedGroup.count}</strong>
            </label>
            <label className="cockpit-check">
              <input type="checkbox" checked={includeLiquid} onChange={event => setIncludeLiquid(event.target.checked)} disabled={!cockpit.fuelBalance || cockpit.fuelBalance <= 0n}/>
              Add liquid FUEL balance ({formatToken(cockpit.fuelBalance, 2)} · {formatUsd(fuelToUsd(cockpit.fuelBalance, priceUsd))})
            </label>
          </div>

          <div className={`cockpit-sell-insight band-${insight.band}`}>
            <div>
              <span>Modeled sell · Dex snapshot USD</span>
              <strong>{formatToken(sellAmount, 2)} FUEL</strong>
              <small>{formatUsd(insight.notionalUsd)}</small>
            </div>
            <div>
              <span>Share of Dex pool liquidity</span>
              <strong>{insight.shareOfLiquidity == null ? '—' : `${(insight.shareOfLiquidity * 100).toFixed(2)}%`}</strong>
              <small>{bandLabel(insight.band)}</small>
            </div>
            <div>
              <span>Safer clip target (~0.5%)</span>
              <strong>{formatToken(safeGuide.safeFuel, 2)} FUEL</strong>
              <small>{formatUsd(safeGuide.safeUsd)}</small>
            </div>
            <div>
              <span>Caution ceiling (~2%)</span>
              <strong>{formatToken(safeGuide.cautionFuel, 2)} FUEL</strong>
              <small>{formatUsd(safeGuide.cautionUsd)}</small>
            </div>
            <p>{safeGuide.detail} Trade venue: Uniswap on Robinhood Chain — Radar does not submit swaps.</p>
            <div className="cockpit-trade-links">
              <a href={uniswapSellFuelUrl()} target="_blank" rel="noreferrer">Open Uniswap sell</a>
              <a href={`${DEXSCREENER}/${PAIRS.fuel}`} target="_blank" rel="noreferrer">Check pool depth</a>
            </div>
          </div>

          {pieces.length > 1 && <div className="cockpit-sell-pieces">
            <h3>If you split this clip into {pieces.length}</h3>
            <ul>
              {pieces.map((piece, index) => {
                const pieceInsight = buildSellInsight({ fuelAmount: piece, priceUsd, liquidityUsd: fuel?.liquidityUsd ?? null })
                return <li key={index}>
                  <strong>Piece {index + 1}</strong>
                  <span>{formatToken(piece, 2)} FUEL · {formatUsd(pieceInsight.notionalUsd)} · {pieceInsight.shareOfLiquidity == null ? '—' : `${(pieceInsight.shareOfLiquidity * 100).toFixed(2)}% pool`}</span>
                  <em>{bandLabel(pieceInsight.band)}</em>
                </li>
              })}
            </ul>
            <p className="activity-note">Splits are illustrative only — Uniswap will show live price impact before you sign.</p>
          </div>}

          </>}
          <div className="cockpit-slot-table-wrap">
            <table className="cockpit-slot-table">
              <caption>Claims maturing {selectedGroup.date} UTC · on-chain net FUEL · USD = Dexscreener price</caption>
              <thead><tr><th>Mint</th><th>Rank</th><th>Term</th><th>Maturity</th><th>Penalty</th><th>Est. FUEL (net, on-chain)</th><th>Est. USD (Dex)</th></tr></thead>
              <tbody>
                {selectedGroup.slots.slice(0, 50).map(slot => {
                  const row = rewardById[slot.id]
                  return <tr key={slot.id}>
                    <td>{slot.source === 'direct' ? 'Direct' : `Batch #${slot.index}`}</td>
                    <td>{slot.rank.toString()}</td>
                    <td>{slot.term.toString()}d</td>
                    <td>{new Date(Number(slot.maturityTs) * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td>{row ? `${row.penaltyPct}%` : '—'}</td>
                    <td>{formatToken(row?.netWei ?? null, 2)}</td>
                    <td>{formatUsd(fuelToUsd(row?.netWei ?? null, priceUsd))}</td>
                  </tr>
                })}
              </tbody>
            </table>
            {selectedGroup.slots.length > 50 && <p className="activity-note">Showing first 50 of {selectedGroup.slots.length} slots for this day.</p>}
          </div>
        </div>}
      </>}
    </section>
    </>}
  </div>
}
