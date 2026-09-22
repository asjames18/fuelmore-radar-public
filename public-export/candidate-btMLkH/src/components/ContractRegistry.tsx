import { ExternalLink, GitBranch, ShieldAlert, ShieldCheck } from 'lucide-react'
import { BLOCKSCOUT } from '../lib/contracts'
import { shortAddress } from '../lib/format'
import type { ContractStatus } from '../lib/types'

export function ContractRegistry({ contracts, full = false }: { contracts: ContractStatus[]; full?: boolean }) {
  const visible = full ? contracts : contracts.slice(0, 7)
  return (
    <section className="panel registry-panel" aria-labelledby="registry-title">
      <div className="panel-heading compact">
        <div><h2 id="registry-title">Contract registry</h2><p>Explorer source status · verification is not a security audit</p></div>
        <span className="mono muted">{contracts.length} tracked</span>
      </div>
      <div className="contract-table" role="table" aria-label="Contract registry">
        <div className="contract-row contract-header" role="row">
          <span>Name</span><span>Type</span><span>Address</span><span>Status</span><span>Explorer</span>
        </div>
        {visible.map((contract) => <div className="contract-row" role="row" key={contract.address}>
          <strong>{contract.name}</strong>
          <span>{contract.type}</span>
          <span className="mono address-cell">{shortAddress(contract.address, 8, 6)}</span>
          <span className={`verification ${contract.reachable && contract.verified ? 'verified' : 'unverified'}`}>
            {contract.reachable && contract.verified ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>}
            {!contract.reachable ? 'Unavailable' : contract.verified ? 'Verified' : contract.proxyType ? `Unverified · ${contract.proxyType}` : 'Unverified'}
          </span>
          <a href={`${BLOCKSCOUT}/address/${contract.address}`} target="_blank" rel="noreferrer" aria-label={`Open ${contract.name} in Blockscout`}><ExternalLink size={15}/></a>
          {contract.implementation && <div className="implementation"><GitBranch size={12}/> implementation {shortAddress(contract.implementation)}</div>}
        </div>)}
      </div>
    </section>
  )
}
