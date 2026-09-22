import { useEffect, useMemo, useRef, useState } from 'react'
import { isAddress } from 'viem'
import { Compass, ExternalLink, Gauge, RefreshCw, ShieldAlert, Wallet } from 'lucide-react'
import {
  estimateSlotRewards,
  fetchCockpitSnapshotSmart,
  groupSlotsByUtcDay,
  type CockpitSnapshot,
} from '../lib/cockpit'
import {
  OWNER_WALLET,
  buildActionBias,
  buildRiskProfile,
  overallTone,
  riskHeadline,
  scoreMarketDirection,
  scoreOwnerDirection,
  type DirectionTone,
} from '../lib/owner'
import { bandLabel, buildSafeSellGuide, buildSellInsight, fuelToUsd, splitSellPieces } from '../lib/sellInsight'
import { BLOCKSCOUT, DEXSCREENER, PAIRS, uniswapBuyFuelUrl, uniswapSellFuelUrl } from '../lib/contracts'
import { track } from '../lib/analytics'
import { formatChange, formatToken, formatUsd, shortAddress } from '../lib/format'
import type { RadarData } from '../lib/types'

function toneLabel(tone: DirectionTone) {
  if (tone === 'improving') return 'Improving'
  if (tone === 'deteriorating') return 'Deteriorating'
  if (tone === 'mixed') return 'Mixed'
  return 'Unknown'
}

function daysUntil(ts: number | null, now: number) {
  if (ts == null) return '—'
  const days = (ts - now) / 86_400
  if (days < 0) return `${Math.abs(days).toFixed(1)}d overdue`
  return `${days.toFixed(1)}d`
}

export function OwnerCockpit({ data }: { data: RadarData }) {
  const [walletInput, setWalletInput] = useState<string>(OWNER_WALLET)
  const [activeWallet, setActiveWallet] = useState<string>(OWNER_WALLET)
  const [cockpit, setCockpit] = useState<CockpitSnapshot | null>(null)
  // Ref mirror for incremental refresh: the effect closure must not depend on
  // `cockpit` state or it would re-run on every snapshot.
  const cockpitRef = useRef<CockpitSnapshot | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [progress, setProgress] = useState('Loading your mint inventory…')
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [reloadKey, setReloadKey] = useState(0)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [sellSlots, setSellSlots] = useState(1)
  const [includeLiquid, setIncludeLiquid] = useState(false)
  const [rewardById, setRewardById] = useState<Record<string, { grossWei: bigint | null; netWei: bigint | null; penaltyPct: number }>>({})
  const [rewardIncomplete, setRewardIncomplete] = useState(false)
  const [rewardStatus, setRewardStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [rewardProgress, setRewardProgress] = useState('')

  const pinned = activeWallet.toLowerCase() === OWNER_WALLET.toLowerCase()

  useEffect(() => {
    let stopped = false
    async function poll() {
      try {
        const { snapshot: next } = await fetchCockpitSnapshotSmart(activeWallet, message => {
          if (!stopped) setProgress(message)
        }, { previous: cockpitRef.current })
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
            }
          }
        }
      } catch {
        if (stopped) return
        setStatus(previous => (previous === 'ready' ? 'ready' : 'error'))
        setError('Unable to refresh your cockpit from RPC. Previous snapshot stays visible when available.')
        setProgress('')
      }
    }
    void poll()
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [activeWallet, reloadKey])

  const fuel = data.pairs.find(pair => pair.symbol === 'FUEL')
  const more = data.pairs.find(pair => pair.symbol === 'MORE')
  const now = cockpit?.observedAt ?? Math.floor(nowMs / 1000)
  const marketInput = {
    fuelChange24h: fuel?.change24h ?? null,
    moreChange24h: more?.change24h ?? null,
    fuelLiquidityUsd: fuel?.liquidityUsd ?? null,
    moreLiquidityUsd: more?.liquidityUsd ?? null,
    fuelVolume24h: fuel?.volume24h ?? null,
    fuelBuys24h: fuel?.buys24h ?? null,
    fuelSells24h: fuel?.sells24h ?? null,
    partial: data.partial,
    fuelTopHolderPct: data.holders.FUEL?.topNonContractPercent ?? null,
    contractsVerified: data.contracts.filter(contract => contract.verified).length,
    contractsTotal: data.contracts.length,
  }
  const ownerInput = {
    activeMints: cockpit?.activeMints ?? null,
    nextMaturityTs: cockpit?.nextMaturityTs ?? null,
    dueOrLate: cockpit?.dueOrLate ?? null,
    liquidFuel: cockpit == null ? null : cockpit.fuelBalance == null ? null : cockpit.fuelBalance > 0n,
    nowTs: now,
  }
  const signals = [...scoreMarketDirection(marketInput), ...scoreOwnerDirection(ownerInput)]
  const overall = overallTone(signals)
  const actions = buildActionBias({ market: marketInput, owner: ownerInput, overall })
  const risks = buildRiskProfile({ market: marketInput, owner: ownerInput })
  const riskLead = riskHeadline(risks)
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
    setError(null)
    setWalletInput(value)
    setActiveWallet(value)
    setStatus('loading')
    setProgress('Loading mint inventory…')
    setReloadKey(value => value + 1)
  }

  return <div className="cockpit-page">
    <section className="panel cockpit-toolbar-panel" aria-labelledby="cockpit-title">
      <div className="cockpit-toolbar">
        <div className="cockpit-target-info">
          <div className="cockpit-badge-row">
            <span className={`cockpit-target-badge ${pinned ? 'pinned' : 'custom'}`}>{pinned ? 'Pinned Owner Wallet' : 'Custom Wallet'}</span>
            <span className="cockpit-target-address">{shortAddress(activeWallet, 10, 8)}</span>
            <a href={`${BLOCKSCOUT}/address/${activeWallet}`} target="_blank" rel="noreferrer" className="icon-link" aria-label="Open wallet on Blockscout"><ExternalLink size={16}/></a>
          </div>
          <h2 id="cockpit-title">FUEL decision cockpit</h2>
          <p className="cockpit-subtext">On-chain inventory and claim amounts, valued with Dexscreener’s pool snapshot (itself on-chain-derived) — weigh mint, buy, sell, or wait. Not financial advice.</p>
        </div>
        <div className="cockpit-toolbar-controls">
          <form className="cockpit-search-form" onSubmit={event => { event.preventDefault(); applyWallet(walletInput) }}>
            <label htmlFor="cockpit-wallet">Wallet</label>
            <div>
              <input id="cockpit-wallet" value={walletInput} onChange={event => setWalletInput(event.target.value)} spellCheck={false} disabled={status === 'loading'} placeholder="0x…"/>
              <button type="submit" disabled={status === 'loading'}>Load</button>
            </div>
          </form>
          <button type="button" className="cockpit-reset-btn" disabled={pinned || status === 'loading'} onClick={() => applyWallet(OWNER_WALLET)} title="Reset to Pinned Owner Wallet">Reset pinned</button>
          <button className="refresh" onClick={() => {
            track('refresh_clicked')
            setStatus('loading')
            setError(null)
            setProgress('Loading your mint inventory…')
            setReloadKey(value => value + 1)
          }} disabled={status === 'loading'}>
            <RefreshCw size={16} className={status === 'loading' ? 'spin' : ''}/><span>Refresh</span>
          </button>
        </div>
      </div>
    </section>

    <div className={`direction-banner tone-${overall}`}>
      <Compass size={18}/>
      <div>
        <strong>Environment: {toneLabel(overall)}</strong>
        <span>On-chain mint book + Dexscreener market snapshot (Dexscreener mirrors pool reserves on-chain). Fees/penalties cite verified Token rules.</span>
      </div>
      <Gauge size={18}/>
    </div>

    <div className={`risk-war tone-${riskLead.tone}`}>
      <ShieldAlert size={18}/>
      <div>
        <strong>Risk profile · {riskLead.label}</strong>
        <span>Separate areas below — liquidity, turnover, claim penalty, inventory, holders, and data coverage.</span>
      </div>
    </div>

    <div className="cockpit-source-legend" role="note">
      <strong>Where the numbers come from</strong>
      <ul>
        <li><em>On-chain (RPC)</em> — mint slots, maturity, liquid FUEL balance, <code>getGrossReward</code> and late-claim penalty. These are FUEL amounts at a pinned block.</li>
        <li><em>Dexscreener</em> — USD price, pool liquidity, 24h change/volume. Dexscreener reads the same on-chain pool; Radar treats it as a third-party snapshot, not a live Uniswap quote.</li>
        <li><em>Combined USD</em> — on-chain FUEL × Dexscreener price. Open Uniswap on Robinhood Chain for executable impact.</li>
      </ul>
    </div>

    {error && <p className="activity-message" role="status">{error}</p>}
    {status === 'loading' && <p className="activity-message" role="status">{progress}</p>}

    <section className="panel cockpit-metrics-panel">
      <div className="cockpit-metrics">
        <div><span>Active mints</span><strong>{cockpit ? cockpit.activeMints.toLocaleString() : '—'}</strong><small>{cockpit?.batchTotal != null ? `${cockpit.batchTotal} batch slots` : 'Batch scan pending'}</small></div>
        <div><span>Next maturity</span><strong>{daysUntil(cockpit?.nextMaturityTs ?? null, now)}</strong><small>{cockpit?.nextMaturityTs ? new Date(cockpit.nextMaturityTs * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'}</small></div>
        <div><span>Due / late</span><strong>{cockpit ? cockpit.dueOrLate.toLocaleString() : '—'}</strong><small>{cockpit && cockpit.maxLatePenaltyPct > 0 ? `Penalty up to ${cockpit.maxLatePenaltyPct}%` : 'Penalty curve after maturity'}</small></div>
        <div><span>Liquid FUEL</span><strong>{formatToken(cockpit?.fuelBalance ?? null, 2)}</strong><small>On-chain balance</small></div>
        <div><span>FUEL 24h</span><strong className={fuel?.change24h == null ? '' : fuel.change24h >= 0 ? 'positive' : 'negative'}>{formatChange(fuel?.change24h ?? null)}</strong><small>Dex · liq {formatUsd(fuel?.liquidityUsd ?? null, true)}</small></div>
        <div><span>Block</span><strong>{cockpit ? cockpit.blockNumber.toString() : '—'}</strong><small><Wallet size={12}/> {pinned ? 'pinned owner' : 'custom wallet'}</small></div>
      </div>
    </section>

    {cockpit && <div className="cockpit-buckets" aria-label="Maturity buckets">
      {cockpit.buckets.map(bucket => <div key={bucket.key} className={bucket.count > 0 ? 'active' : ''}>
        <span>{bucket.label}</span><strong>{bucket.count.toLocaleString()}</strong>
        <small>{bucket.earliestTs ? daysUntil(bucket.earliestTs, now) : '—'}</small>
      </div>)}
    </div>}

    {cockpit?.sampleIncomplete && <p className="activity-note">Some proxy slots failed to read — counts may be incomplete. Refresh to retry.</p>}

    <div className="cockpit-columns">
      <div className="cockpit-signals">
        <h3>Direction signals</h3>
        <ul>
          {signals.map(signal => <li key={signal.id} className={`tone-${signal.tone}`}>
            <strong>{signal.label}</strong><span>{signal.detail}</span>
          </li>)}
        </ul>
      </div>
      <div className="cockpit-actions">
        <h3>Action bias · mint / buy / sell / wait</h3>
        <ul>
          {actions.map(action => <li key={action.id} className={`bias-${action.tone}`}>
            <strong>{action.label}</strong><em>{action.tone}</em><span>{action.reason}</span>
          </li>)}
        </ul>
        <p className="activity-note">Bias is situational guidance from public data — not a recommendation to mint, buy, or sell.</p>
      </div>
    </div>

    <section className="panel cockpit-risk-panel" aria-labelledby="risk-war-title">
      <div className="panel-heading compact">
        <div><h2 id="risk-war-title">Risk war</h2><p>Profile by area · calculated indicators, not an audit</p></div>
      </div>
      <div className="cockpit-risk-grid">
        {risks.map(area => <div key={area.id} className={`cockpit-risk-card tone-${area.tone}`}>
          <strong>{area.label}</strong>
          <em>{area.tone}</em>
          <span>{area.detail}</span>
        </div>)}
      </div>
    </section>

    <section className="panel cockpit-today-panel" aria-labelledby="today-sell-title">
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
        <div><span>Estimated claim (net)</span><strong>{rewardStatus === 'loading' ? '…' : formatToken(dueReward.total, 2)}</strong><small>{formatUsd(fuelToUsd(dueReward.total, priceUsd))} · on-chain FUEL × Dex price</small></div>
        <div><span>Liquid FUEL</span><strong>{formatToken(cockpit?.fuelBalance ?? null, 2)}</strong><small>{formatUsd(fuelToUsd(cockpit?.fuelBalance ?? null, priceUsd))} · balance on-chain</small></div>
        <div><span>Combined if sold now</span><strong>{rewardStatus === 'loading' ? '…' : formatToken(todaySellAmount, 2)}</strong><small>{formatUsd(todayInsight.notionalUsd)} · {todayInsight.shareOfLiquidity == null ? '—' : `${(todayInsight.shareOfLiquidity * 100).toFixed(2)}% of Dex pool`}</small></div>
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
      {rewardStatus === 'loading' && <p className="activity-message" role="status">{rewardProgress || 'Estimating claimable FUEL…'}</p>}
      {rewardStatus === 'error' && <p className="activity-message" role="status">Claim value estimates unavailable right now. Dates and slot counts remain valid.</p>}
    </section>

    <section className="panel cockpit-inventory-panel" aria-labelledby="inventory-title">
      <div className="panel-heading">
        <div>
          <h2 id="inventory-title">Claims by unlock day · market value</h2>
          <p>On-chain net FUEL per day; USD uses Dexscreener price (on-chain pool mirror). Pick a day to size a partial sell vs that pool depth.</p>
        </div>
      </div>
      {!cockpit ? <p className="activity-note">Inventory loads after the batch scan finishes.</p> : dayGroups.length === 0 ? <p className="activity-note">No active mints at this block.</p> : <>
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
              <span>{rewardStatus === 'ready' ? formatToken(value.total, 2) : '…'} FUEL</span>
              <small>{rewardStatus === 'ready' ? formatUsd(fuelToUsd(value.total, priceUsd)) : (due ? 'Due / unlockable' : 'Upcoming')}</small>
            </button>
          })}
        </div>

        {selectedGroup && <div className="cockpit-day-detail">
          <div className="cockpit-day-summary">
            <div><span>Selected day</span><strong>{selectedGroup.date} UTC</strong><small>{Date.parse(`${selectedGroup.date}T00:00:00Z`) / 1000 <= now ? 'Claimable now (if past maturity)' : 'Not mature yet — estimate if claimed later at today’s rules'}</small></div>
            <div><span>Slots that day</span><strong>{selectedGroup.count}</strong></div>
            <div><span>Day total (net)</span><strong>{rewardStatus === 'loading' ? '…' : formatToken(selectedDayReward.total, 2)}</strong><small>{formatUsd(fuelToUsd(selectedDayReward.total, priceUsd))} · on-chain getGrossReward − late penalty × Dex price</small></div>
            <div><span>Selected sell size</span><strong>{formatToken(sellAmount, 2)}</strong><small>{formatUsd(insight.notionalUsd)} · {insight.shareOfLiquidity == null ? '—' : `${(insight.shareOfLiquidity * 100).toFixed(2)}% of Dex pool`}</small></div>
          </div>
          {rewardIncomplete && rewardStatus === 'ready' && <p className="activity-note">Some slot reward reads failed — day totals may be incomplete.</p>}

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
  </div>
}
