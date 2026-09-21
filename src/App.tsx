import { useState, type ComponentType } from 'react'
import {
  Activity,
  BookOpen,
  Blocks,
  Calculator,
  ChartNoAxesCombined,
  CircleDollarSign,
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
import { PublicCockpit } from './components/PublicCockpit'
import { CockpitView } from './components/CockpitView'
import { Guide } from './components/Guide'
import { PlannerComingSoon } from './components/PlannerComingSoon'
import { ActivityTable } from './components/ActivityTable'
import { ContractRegistry } from './components/ContractRegistry'
import { MarketCard } from './components/MarketCard'
import { MarketChart } from './components/MarketChart'
import { ProtocolFlow } from './components/ProtocolFlow'
import { ProtocolStats } from './components/ProtocolStats'
import { HolderBoard } from './components/HolderBoard'
import { FeePreview } from './components/FeePreview'
import { DEXSCREENER, PAIRS } from './lib/contracts'
import { formatUsd, shortAddress, timeAgo } from './lib/format'
import type { RadarData } from './lib/types'
import { useRadarData } from './useRadarData'
import { track } from './lib/analytics'
import './styles.css'

type View = 'Overview' | 'Cockpit' | 'Markets' | 'Protocol' | 'Contracts' | 'Guide' | 'Planner'

const NAV: Array<{ name: View; Icon: typeof Activity }> = [
  { name: 'Overview', Icon: ChartNoAxesCombined },
  { name: 'Cockpit', Icon: WalletCards },
  { name: 'Markets', Icon: CircleDollarSign },
  { name: 'Protocol', Icon: Blocks },
  { name: 'Contracts', Icon: FileCode2 },
  { name: 'Guide', Icon: BookOpen },
  { name: 'Planner', Icon: Calculator },
]

const SUBTITLES: Record<View, string> = {
  Overview: 'Live market snapshot for FUEL / MORE on Robinhood Chain.',
  Cockpit: 'Look up any wallet — positions, maturity calendar, and FUEL claim modeling. No connection needed.',
  Markets: 'Liquidity depth and holder distribution.',
  Protocol: 'Protocol health, fee flow, and minting activity.',
  Contracts: 'Verified contract addresses — check the address, not the name.',
  Guide: 'How to use the Radar, piece by piece.',
  Planner: 'Coming soon — prediction plans from current and future numbers.',
}

function DataSources() {
  return <div className="source-block">
    <span>Data sources</span>
    <a href="https://dexscreener.com/robinhood" target="_blank" rel="noreferrer"><i/>Dexscreener</a>
    <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer"><i/>Blockscout</a>
    <a href="https://docs.robinhood.com/chain/connecting/" target="_blank" rel="noreferrer"><i/>Robinhood RPC</a>
    <p>Balances and claims from chain RPC. Prices/liquidity via Dexscreener (their on-chain pool mirror). Delayed or partial values possible — not advice.</p>
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

function MarketsView({ data }: { data: RadarData }) {
  return <>
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
  const [view, setView] = useState<View>('Overview')
  const [menuOpen, setMenuOpen] = useState(false)

  const selectView = (next: View) => {
    setView(next)
    track('view_selected')
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
            <small>Updates every 15 minutes</small>
          </div>}
          <div className="read-only"><ShieldCheck size={16}/><span>Read-only</span></div>
        </div>
      </header>

      <main>
        <div className="page-title"><div><span>Robinhood Chain · Chain ID 4663</span><h1>{view}</h1></div><p>{SUBTITLES[view]}</p></div>
        {error && (personal || !data) && <div className="status-banner"><Activity size={16}/>{personal ? error : data ? 'Some data is delayed or unavailable. Check the timestamp beside each value.' : error}</div>}

        {personal && data && <SnapshotFreshness data={data}/>}
        {data && Diagnostics && <Diagnostics data={data}/>}
        {view === 'Cockpit' && <CockpitView data={data} defaultWallet={personal?.defaultWallet} Cockpit={Cockpit}/>}
        {view === 'Guide' && <Guide/>}
        {view === 'Planner' && (Planner ? <Planner/> : <PlannerComingSoon/>)}
        {view === 'Protocol' && <FuelActivity/>}
        {!data ? <div className="loading-grid" aria-label="Loading dashboard"><div/><div/><div/><div/></div> : <>
          {view === 'Overview' && <>
            <TokenCards data={data}/>
            <div className={Risk ? "primary-grid" : "public-chart"}><MarketChart history={history}/>{Risk && <Risk data={data}/>}</div>
            {Analytics && <Analytics/>}
            <ActivityTable activity={data.activity} sources={data.sources}/>
          </>}
          {view === 'Markets' && <MarketsView data={data}/>}
          {view === 'Protocol' && <><ProtocolStats protocol={data.protocol}/><ProtocolFlow protocol={data.protocol}/><FeePreview/>{Risk && <Risk data={data}/>}</>}
          {view === 'Contracts' && <><ContractRegistry contracts={data.contracts} full/>{Risk && <Risk data={data}/>}</>}
        </>}
      </main>

      <footer><span>$FUEL / MORE RADAR</span><p>Public data · snapshot, not advice</p><a href={`${DEXSCREENER}/${PAIRS.fuel}`} target="_blank" rel="noreferrer">Open FUEL market</a></footer>
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {navItems.map(({ name, Icon }) => <button key={name} aria-label={name} className={view === name ? 'selected' : ''} onClick={() => selectView(name)}><Icon size={19}/><span>{name}</span></button>)}
    </nav>
  </div>
}

export default App
