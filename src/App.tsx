import { useState, type ComponentType } from 'react'
import {
  Activity,
  BookOpen,
  Blocks,
  Calculator,
  ChartNoAxesCombined,
  CircleDollarSign,
  Coins,
  ExternalLink,
  FileCode2,
  Menu,
  Radar,
  RefreshCw,
  ShieldCheck,
  WalletCards,
  X,
} from 'lucide-react'
import { SnapshotFreshness } from './components/SnapshotFreshness'
import { FuelActivity } from './components/FuelActivity'
import { MintersView } from './components/MintersView'
import { DailyFlowCards } from './components/DailyFlowCards'
import { PublicCockpit } from './components/PublicCockpit'
import { CockpitView } from './components/CockpitView'
import { Guide } from './components/Guide'
import { PlannerComingSoon } from './components/PlannerComingSoon'
import { ActivityTable } from './components/ActivityTable'
import { ContractRegistry } from './components/ContractRegistry'
import { MarketCard } from './components/MarketCard'
import { MarketChart } from './components/MarketChart'
import { OverviewStats } from './components/OverviewStats'
import { ProtocolFlow } from './components/ProtocolFlow'
import { ProtocolStats } from './components/ProtocolStats'
import { HolderBoard } from './components/HolderBoard'
import { FeePreview } from './components/FeePreview'
import { DonateChip } from './components/DonateChip'
import { DEXSCREENER, PAIRS } from './lib/contracts'
import { formatUsd, shortAddress, timeAgo } from './lib/format'
import type { HistoryPoint, RadarData } from './lib/types'
import { useRadarData } from './useRadarData'
import { track } from './lib/analytics'
import './styles.css'

type View = 'Overview' | 'Cockpit' | 'Markets' | 'Minters' | 'Protocol' | 'Contracts' | 'Guide' | 'Planner'

const NAV: Array<{ name: View; Icon: typeof Activity }> = [
  { name: 'Overview', Icon: ChartNoAxesCombined },
  { name: 'Cockpit', Icon: WalletCards },
  { name: 'Markets', Icon: CircleDollarSign },
  { name: 'Minters', Icon: Coins },
  { name: 'Protocol', Icon: Blocks },
  { name: 'Contracts', Icon: FileCode2 },
  { name: 'Guide', Icon: BookOpen },
  { name: 'Planner', Icon: Calculator },
]

const VIEW_NAMES: View[] = NAV.map((item) => item.name)

/**
 * Deep-link support: `?view=Minters` selects the view on initial load.
 * Case-insensitive; unknown or missing values fall back to Overview —
 * the app never renders blank for a bad query param.
 */
function initialViewFromUrl(): View {
  try {
    if (typeof window === 'undefined') return 'Overview'
    const raw = new URLSearchParams(window.location.search).get('view')
    if (raw) {
      const match = VIEW_NAMES.find((name) => name.toLowerCase() === raw.trim().toLowerCase())
      if (match) return match
    }
  } catch {
    // Malformed URL or restricted environment: fall through to Overview.
  }
  return 'Overview'
}

const SUBTITLES: Record<View, string> = {
  Overview: 'The numbers at a glance — daily activity, protocol stats, and one tap to everything else.',
  Cockpit: 'Look up any wallet — positions, maturity calendar, and FUEL claim modeling. No connection needed.',
  Markets: 'Price charts, liquidity depth, and holder distribution.',
  Minters: 'Wallets that claimed FUEL from mints — what they claimed, sold, and re-minted.',
  Protocol: 'Protocol health, fee flow, and minting activity.',
  Contracts: 'Contract address registry — check the address, not the name.',
  Guide: 'How to use the Radar, piece by piece.',
  Planner: 'Coming soon — prediction plans from current and future numbers.',
}

const OFFICIAL_LINKS = [
  { label: 'FUEL site', href: 'https://fuelmoretokens.com/' },
  { label: 'FUEL app', href: 'https://app.fuelmoretokens.com/' },
  { label: 'MORE site', href: 'https://www.moretokens.com/' },
  { label: 'MORE app', href: 'https://app.moretokens.com/' },
] as const

function OfficialLinks() {
  return <div className="official-links" aria-label="Official FUEL and MORE links">
    <span>Official</span>
    {OFFICIAL_LINKS.map(link => <a key={link.label} href={link.href} target="_blank" rel="noreferrer">{link.label}<ExternalLink size={11} aria-hidden/></a>)}
  </div>
}
function DataSources() {
  return <div className="source-block">
    <span>Data sources</span>
    <a href="https://dexscreener.com/robinhood" target="_blank" rel="noreferrer"><i/>Dexscreener</a>
    <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer"><i/>Blockscout</a>
    <a href="https://docs.robinhood.com/chain/connecting/" target="_blank" rel="noreferrer"><i/>Robinhood RPC</a>
    <p>Balances and claims from chain RPC. Prices/liquidity via Dexscreener (their on-chain pool mirror); the market-history collector fails over Dexscreener → GeckoTerminal → DexPaprika. Delayed or partial values possible — not advice.</p>
  </div>
}

function Sidebar({ view, setView, open, close, items }: { view: View; setView: (view: View) => void; open: boolean; close: () => void; items: typeof NAV }) {
  return <>
    {open && <button className="nav-scrim" onClick={close} aria-label="Close navigation"/>}
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="side-brand"><Radar size={22}/><span>RADAR</span><button onClick={close} aria-label="Close menu"><X size={20}/></button></div>
      <nav aria-label="Primary navigation">
        {items.map(({ name, Icon }) => <button key={name} aria-label={name} className={view === name ? 'selected' : ''} onClick={() => { setView(name); close() }}><Icon size={18}/><span>{name}</span></button>)}
      </nav>
      <DataSources/>
      <div className="readonly-card"><ShieldCheck size={18}/><div><strong>Read-only mode</strong><span>No wallet required</span></div></div>
    </aside>
  </>
}

function TokenCards({ data }: { data: RadarData }) {
  return <div className="market-grid">
    {data.pairs.map((pair) => <MarketCard key={pair.pairAddress} pair={pair} holders={data.holders[pair.symbol]}/>) }
  </div>
}

function MarketsView({ data, history, Risk, onLookupWallet }: { data: RadarData; history: HistoryPoint[]; Risk?: ComponentType<{ data: RadarData }>; onLookupWallet: (address: string) => void }) {  return <>
    <div className={Risk ? "primary-grid" : undefined}><MarketChart history={history}/>{Risk && <Risk data={data}/>}</div>
    <DailyFlowCards onLookupWallet={onLookupWallet}/>
    <section className="panel pool-table-panel">
      <div className="panel-heading"><div><h2>Pool execution context</h2><p>Price alone is not executable liquidity</p></div></div>
      <div className="pool-table">
        {data.pairs.map((pair) => <a key={pair.pairAddress} href={`${DEXSCREENER}/${pair.pairAddress}`} target="_blank" rel="noreferrer">
          <strong>{pair.symbol}/WETH</strong><span>{pair.version.toUpperCase()}</span><span>MCAP {formatUsd(pair.marketCap, true)}</span><span>{pair.buys24h?.toLocaleString() ?? '—'} buys</span><span>{pair.sells24h?.toLocaleString() ?? '—'} sells</span><span>{shortAddress(pair.pairAddress)}</span>
        </a>)}
      </div>
    </section>
    <HolderBoard holders={data.holders}/>
  </>
}

/**
 * The Overview is the front door: market snapshot first, then one card per
 * part of the radar so a first-time visitor sees everything the site does.
 * Cards link into the views instead of repeating their content.
 */
function ExploreRadar({ select }: { select: (view: View) => void }) {
  const cards = NAV.filter(item => item.name !== 'Overview')
  return <section className="panel explore-panel" aria-labelledby="explore-title">
    <div className="panel-heading"><div><h2 id="explore-title">Explore the radar</h2><p>Every part of the radar, one tap away</p></div></div>
    <div className="explore-grid">
      {cards.map(({ name, Icon }) => <button key={name} type="button" className="explore-card" onClick={() => select(name)}>
        <Icon size={20}/>
        <strong>{name}</strong>
        <span>{SUBTITLES[name]}</span>
      </button>)}
    </div>
  </section>
}

export type PersonalFeatures = {
  Cockpit: ComponentType<{ data: RadarData }>
  Planner: ComponentType
  Diagnostics: ComponentType<{ data: RadarData }>
  Risk: ComponentType<{ data: RadarData }>
  Analytics: ComponentType
  defaultWallet: string
}
function App({ personal }: { personal?: PersonalFeatures }) {
  const Cockpit = personal?.Cockpit ?? PublicCockpit
  const Planner = personal?.Planner
  const Diagnostics = personal?.Diagnostics
  const Risk = personal?.Risk
  const Analytics = personal?.Analytics
  const { data, history, status, error, refresh, refreshing } = useRadarData()
  const [view, setView] = useState<View>(initialViewFromUrl)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cockpitAddress, setCockpitAddress] = useState<string | null>(null)

  const selectView = (next: View) => {
    setView(next)
    // Keep the URL shareable; replaceState avoids polluting back-button history.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('view', next)
      window.history.replaceState(null, '', url)
    } catch {
      // Non-browser or restricted environment: view state still works.
    }
    track('view_selected')
  }
  // Jump from a minter/flow wallet row into the Cockpit lookup for that wallet.
  const lookupWallet = (address: string) => {
    setCockpitAddress(address)
    selectView('Cockpit')
  }
  // The private app renders its full Planner; public visitors see the coming-soon placeholder.
  const navItems = NAV

  return <div className="app-shell">
    <Sidebar view={view} setView={selectView} open={menuOpen} close={() => setMenuOpen(false)} items={navItems}/>
    <div className="workspace">
      <header className="topbar">
        <button className="menu-button" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={20}/></button>
        <div className="brand"><span>$FUEL</span><b>/</b><span>MORE</span><em>RADAR</em></div>
        {personal && <div className="network"><i className={status}/><span>Robinhood Chain</span><b>{status === 'loading' ? 'SYNCING' : status === 'live' ? 'CONNECTED' : status.toUpperCase()}</b></div>}
        <div className="top-actions">
          {personal ? <><div className="updated"><span>Saved sync attempt</span><strong>{data ? timeAgo(data.updatedAt) : '—'}</strong></div>
          <button className="refresh" onClick={() => { track('refresh_clicked'); void refresh() }} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/><span>Refresh</span></button></> : <div className="public-sync" aria-live="polite">
            <span title={data ? new Date(data.updatedAt).toISOString() : undefined}>Last sync: {data ? timeAgo(data.updatedAt) : 'waiting for data'}</span>
            <small>Scheduled every 15 minutes</small>
          </div>}
          <div className="read-only"><ShieldCheck size={16}/><span>Read-only</span></div>
        </div>
      </header>
      <OfficialLinks/>

      <main>
        <div className="page-title"><div><span>Robinhood Chain · Chain ID 4663</span><h1>{view}</h1></div><p>{SUBTITLES[view]}</p></div>
        {error && (personal || !data) && <div className="status-banner"><Activity size={16}/>{personal ? error : data ? 'Some data is delayed or unavailable. Check the timestamp beside each value.' : error}</div>}

        {personal && data && <SnapshotFreshness data={data}/>}
        {data && Diagnostics && <Diagnostics data={data}/>}
        {view === 'Cockpit' && <CockpitView key={cockpitAddress ?? 'default'} data={data} defaultWallet={cockpitAddress ?? personal?.defaultWallet} Cockpit={Cockpit}/>}
        {view === 'Minters' && <MintersView onLookupWallet={lookupWallet}/>}
        {view === 'Guide' && <Guide/>}
        {view === 'Planner' && (Planner ? <Planner/> : <PlannerComingSoon/>)}
        {view === 'Protocol' && <FuelActivity/>}
        {!data ? <div className="loading-grid" aria-label="Loading dashboard"><div/><div/><div/><div/></div> : <>
          {view === 'Overview' && <>
            <TokenCards data={data}/>
            <OverviewStats protocol={data.protocol} protocolObservation={data.protocolObservation} onSeeProtocol={() => selectView('Protocol')} onSeeMarkets={() => selectView('Markets')}/>
            <ExploreRadar select={selectView}/>
            {Analytics && <Analytics/>}
            <ActivityTable activity={data.activity} sources={data.sources}/>
          </>}
          {view === 'Markets' && <MarketsView data={data} history={history} Risk={Risk} onLookupWallet={lookupWallet}/>}
          {view === 'Protocol' && <><ProtocolStats protocol={data.protocol}/><ProtocolFlow protocol={data.protocol}/><FeePreview/>{Risk && <Risk data={data}/>}</>}
          {view === 'Contracts' && <><ContractRegistry contracts={data.contracts} full/>{Risk && <Risk data={data}/>}</>}
        </>}
      </main>

      <div className="donate-mobile">
        <DonateChip/>
        <small>Donations support the Radar · send on any chain</small>
      </div>
      <footer><span>$FUEL / MORE RADAR</span><p>Public data · snapshot, not advice</p><DonateChip/><a href={`${DEXSCREENER}/${PAIRS.fuel}`} target="_blank" rel="noreferrer">Open FUEL market</a></footer>
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {navItems.map(({ name, Icon }) => <button key={name} aria-label={name} className={view === name ? 'selected' : ''} onClick={() => selectView(name)}><Icon size={19}/><span>{name}</span></button>)}
    </nav>
  </div>
}

export default App
