import { useState, type ComponentType } from 'react'
import {
  Activity,
  Calculator,
  Blocks,
  ChartNoAxesCombined,
  CircleDollarSign,
  Compass,
  FileCode2,
  Menu,
  Radar,
  RefreshCw,
  ShieldCheck,
  WalletCards,
  X,
} from 'lucide-react'
import { DonateChip, DONATE_NETWORK_NOTE } from './components/DonateChip'
import { SnapshotFreshness } from './components/SnapshotFreshness'
import { FuelActivity } from './components/FuelActivity'
import { PublicCockpit } from './components/PublicCockpit'
import { ActivityTable } from './components/ActivityTable'
import { ContractRegistry } from './components/ContractRegistry'
import { MarketCard } from './components/MarketCard'
import { MarketChart } from './components/MarketChart'
import { PositionLookup } from './components/PositionLookup'
import { ProtocolFlow } from './components/ProtocolFlow'
import { ProtocolStats } from './components/ProtocolStats'
import { HolderBoard } from './components/HolderBoard'
import { FeePreview } from './components/FeePreview'
import { DEXSCREENER, PAIRS } from './lib/contracts'
import { formatUsd, shortAddress, timeAgo } from './lib/format'
import type { RadarData } from './lib/types'
import { useRadarData } from './useRadarData'
import './styles.css'

type View = 'Overview' | 'Cockpit' | 'Markets' | 'Protocol' | 'Positions' | 'Planner' | 'Contracts'

const NAV: Array<{ name: View; Icon: typeof Activity }> = [
  { name: 'Overview', Icon: ChartNoAxesCombined },
  { name: 'Cockpit', Icon: Compass },
  { name: 'Markets', Icon: CircleDollarSign },
  { name: 'Protocol', Icon: Blocks },
  { name: 'Positions', Icon: WalletCards },
  { name: 'Planner', Icon: Calculator },
  { name: 'Contracts', Icon: FileCode2 },
]

function DataSources() {
  return <div className="source-block">
    <span>Data sources</span>
    <a href="https://dexscreener.com/robinhood" target="_blank" rel="noreferrer"><i/>Dexscreener</a>
    <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer"><i/>Blockscout</a>
    <a href="https://docs.robinhood.com/chain/connecting/" target="_blank" rel="noreferrer"><i/>Robinhood RPC</a>
    <p>Balances and claims from chain RPC. Prices/liquidity via Dexscreener (their on-chain pool mirror). Delayed or partial values possible — not advice.</p>
  </div>
}

function Sidebar({ view, setView, open, close }: { view: View; setView: (view: View) => void; open: boolean; close: () => void }) {
  return <>
    {open && <button className="nav-scrim" onClick={close} aria-label="Close navigation"/>}
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="side-brand"><Radar size={22}/><span>RADAR</span><button onClick={close} aria-label="Close menu"><X size={20}/></button></div>
      <nav aria-label="Primary navigation">
        {NAV.map(({ name, Icon }) => <button key={name} aria-label={name} className={view === name ? 'selected' : ''} onClick={() => { setView(name); close() }}><Icon size={18}/><span>{name}</span></button>)}
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

function MarketsView({ data, history }: { data: RadarData; history: ReturnType<typeof useRadarData>['history'] }) {
  return <>
    <TokenCards data={data}/>
    <MarketChart history={history}/>
    <HolderBoard holders={data.holders}/>
    <section className="panel pool-table-panel">
      <div className="panel-heading"><div><h2>Pool execution context</h2><p>Price alone is not executable liquidity</p></div></div>
      <div className="pool-table">
        {data.pairs.map((pair) => <a key={pair.pairAddress} href={`${DEXSCREENER}/${pair.pairAddress}`} target="_blank" rel="noreferrer">
          <strong>{pair.symbol}/WETH</strong><span>{pair.version.toUpperCase()}</span><span>MCAP {formatUsd(pair.marketCap, true)}</span><span>{pair.buys24h?.toLocaleString() ?? '—'} buys</span><span>{pair.sells24h?.toLocaleString() ?? '—'} sells</span><span>{shortAddress(pair.pairAddress)}</span>
        </a>)}
      </div>
    </section>
  </>
}

export type PersonalFeatures = {
  Cockpit: ComponentType<{ data: RadarData }>
  Planner: ComponentType
  Diagnostics: ComponentType<{ data: RadarData }>
  Risk: ComponentType<{ data: RadarData }>
  defaultWallet: string
}
function App({ personal }: { personal?: PersonalFeatures }) {
  const Cockpit = personal?.Cockpit ?? PublicCockpit
  const Planner = personal?.Planner
  const Diagnostics = personal?.Diagnostics
  const Risk = personal?.Risk
  const { data, history, status, error, refresh, refreshing } = useRadarData()
  const [view, setView] = useState<View>('Overview')
  const [menuOpen, setMenuOpen] = useState(false)

  return <div className="app-shell">
    <Sidebar view={view} setView={setView} open={menuOpen} close={() => setMenuOpen(false)}/>
    <div className="workspace">
      <header className="topbar">
        <button className="menu-button" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={20}/></button>
        <div className="brand"><span>$FUEL</span><b>/</b><span>MORE</span><em>RADAR</em></div>
        {personal && <div className="network"><i className={status}/><span>Robinhood Chain</span><b>{status === 'loading' ? 'SYNCING' : status === 'live' ? 'CONNECTED' : status.toUpperCase()}</b></div>}
        <div className="top-actions">
          {personal ? <><div className="updated"><span>Saved sync attempt</span><strong>{data ? timeAgo(data.updatedAt) : '—'}</strong></div>
          <button className="refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/><span>Refresh</span></button></> : <div className="public-sync" aria-live="polite">
            <span title={data ? new Date(data.updatedAt).toISOString() : undefined}>Last sync: {data ? timeAgo(data.updatedAt) : 'waiting for data'}</span>
            <small>Updates every 15 minutes</small>
          </div>}
          <div className="read-only"><ShieldCheck size={16}/><span>Read-only</span></div>
        </div>
      </header>

      <main>
        <div className="page-title"><div><span>Robinhood Chain · Chain ID 4663</span><h1>{view}</h1></div><p>{view === 'Cockpit' ? (personal ? 'Personal decision desk — inventory and market context.' : 'Read your wallet’s mint inventory and maturity schedule.') : view === 'Overview' ? 'Market, protocol, and activity snapshot for FUEL / MORE.' : `Focused ${view.toLowerCase()} intelligence from public data.`}</p></div>
        {error && (personal || !data) && <div className="status-banner"><Activity size={16}/>{personal ? error : data ? 'Some data is delayed or unavailable. Check the timestamp beside each value.' : error}</div>}

        {personal && data && <SnapshotFreshness data={data}/>}
        {data && Diagnostics && <Diagnostics data={data}/>}
        {view === 'Cockpit' && data && <Cockpit data={data}/>}
        {view === 'Positions' && <PositionLookup defaultWallet={personal?.defaultWallet}/>}
        {view === 'Planner' && (Planner ? <Planner/> : <section className="panel"><div className="panel-heading"><div><h2>Coming soon</h2><p>Verified planning tools are being prepared. Wallet lookup and maturity schedules are available now.</p></div></div></section>)}
        {(view === 'Overview' || view === 'Protocol') && <FuelActivity/>}
        {!data ? <div className="loading-grid" aria-label="Loading dashboard"><div/><div/><div/><div/></div> : <>
          {view === 'Overview' && <>
            <TokenCards data={data}/>
            <div className={Risk ? "primary-grid" : "public-chart"}><MarketChart history={history}/>{Risk && <Risk data={data}/>}</div>
            <ProtocolFlow protocol={data.protocol}/>
            <ProtocolStats protocol={data.protocol}/>
            <HolderBoard holders={data.holders}/>
            <div className="bottom-grid"><ContractRegistry contracts={data.contracts}/><ActivityTable activity={data.activity} sources={data.sources}/></div>
          </>}
          {view === 'Markets' && <MarketsView data={data} history={history}/>} 
          {view === 'Protocol' && <><ProtocolStats protocol={data.protocol}/><ProtocolFlow protocol={data.protocol}/><FeePreview/><HolderBoard holders={data.holders}/>{Risk && <Risk data={data}/>}</>}
          {view === 'Contracts' && <><ContractRegistry contracts={data.contracts} full/>{Risk && <Risk data={data}/>}</>}
        </>}
      </main>

      <div className="donate-mobile">
        <DonateChip/>
        <small>Donations support the Radar · send on {DONATE_NETWORK_NOTE}</small>
      </div>
      <footer><span>$FUEL / MORE RADAR</span><p>Public data · snapshot, not advice</p><DonateChip/><a href={`${DEXSCREENER}/${PAIRS.fuel}`} target="_blank" rel="noreferrer">Open FUEL market</a></footer>
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {NAV.map(({ name, Icon }) => <button key={name} aria-label={name} className={view === name ? 'selected' : ''} onClick={() => setView(name)}><Icon size={19}/><span>{name}</span></button>)}
    </nav>
  </div>
}

export default App
