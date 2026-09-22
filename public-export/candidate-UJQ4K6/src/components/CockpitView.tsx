import { useState, type ComponentType } from 'react'
import { PositionLookup } from './PositionLookup'
import { track } from '../lib/analytics'
import type { RadarData } from '../lib/types'

type WalletTab = 'positions' | 'cockpit'

const TABS: Array<{ id: WalletTab; title: string; blurb: string }> = [
  { id: 'positions', title: 'Positions', blurb: 'Mints, maturity calendar, watchlist' },
  { id: 'cockpit', title: 'Inventory & claims', blurb: 'Inventory depth, claim & sell modeling' },
]

/**
 * The public Cockpit page. Positions (general lookup) and the FUEL cockpit
 * (deep inventory + claim/sell modeling) used to be two nav items with two
 * wallet inputs — one page with labeled tabs replaces both, with no
 * duplicated content. The cockpit component is injectable so the private
 * app keeps its owner cockpit.
 */
export function CockpitView({ data, defaultWallet = '', Cockpit }: {
  data: RadarData | null
  defaultWallet?: string
  Cockpit: ComponentType<{ data: RadarData }>
}) {
  const [tab, setTab] = useState<WalletTab>('positions')

  function select(next: WalletTab) {
    setTab(next)
    track('view_selected')
    if (next === 'cockpit') track('cockpit_open')
  }

  return <div className="cockpit-view">
    <div className="cockpit-tabs" role="tablist" aria-label="Cockpit tools">
      {TABS.map(({ id, title, blurb }) => <button
        key={id}
        type="button"
        role="tab"
        aria-selected={tab === id}
        className={tab === id ? 'selected' : ''}
        onClick={() => select(id)}
      ><strong>{title}</strong><span>{blurb}</span></button>)}
    </div>
    {tab === 'positions'
      ? <PositionLookup defaultWallet={defaultWallet}/>
      : data
        ? <Cockpit data={data}/>
        : <p className="activity-message" role="status">Waiting for market data…</p>}
  </div>
}
