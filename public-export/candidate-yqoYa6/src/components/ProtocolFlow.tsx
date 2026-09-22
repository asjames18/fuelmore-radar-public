import { ArrowDown, ArrowRight, ExternalLink } from 'lucide-react'
import { BLOCKSCOUT, CONTRACTS } from '../lib/contracts'
import { FEE_SPLIT } from '../lib/provenance'
import { formatEth, shortAddress } from '../lib/format'
import type { ProtocolSnapshot } from '../lib/types'

const destinations = {
  vault: CONTRACTS[4],
  fuelBurner: CONTRACTS[5],
  moreBurner: CONTRACTS[6],
} as const

export function ProtocolFlow({ protocol }: { protocol: ProtocolSnapshot }) {
  return (
    <section className="panel flow-panel" aria-labelledby="flow-title">
      <div className="panel-heading compact">
        <div><h2 id="flow-title">Protocol fee flow</h2><p>Source-verified FeeDistributor split · not a security audit</p></div>
        <span className="mono muted">Distributed {formatEth(protocol.totalDistributed)}</span>
      </div>
      <p className="activity-note">45/25/30 comes from verified <code>FeeDistributor.sol</code> on Robinhood Chain (Sourcify exact match). See <code>docs/provenance/CONTRACT_PROVENANCE.md</code>.</p>
      <div className="flow-grid">
        <div className="flow-source"><span>Mint fees</span><strong>100%</strong></div>
        <ArrowRight className="flow-arrow desktop-arrow" size={22}/><ArrowDown className="flow-arrow mobile-arrow" size={22}/>
        <div className="flow-destinations">
          {FEE_SPLIT.map((item) => {
            const contract = destinations[item.key]
            return <a key={item.label} href={`${BLOCKSCOUT}/address/${contract.address}`} target="_blank" rel="noreferrer" className="flow-node">
              <b>{item.percent}<small>Verified</small></b><span>{item.label}</span><small>{shortAddress(contract.address)} <ExternalLink size={11}/></small>
            </a>
          })}
        </div>
      </div>
    </section>
  )
}
