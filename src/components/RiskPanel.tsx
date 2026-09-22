import { AlertTriangle, CheckCircle2, CircleAlert, ShieldCheck } from 'lucide-react'
import type { RadarData } from '../lib/types'

export function RiskPanel({ data }: { data: RadarData }) {
  const fuel = data.pairs.find((pair) => pair.symbol === 'FUEL')
  const more = data.pairs.find((pair) => pair.symbol === 'MORE')
  const verified = data.contracts.filter((contract) => contract.verified).length
  const reachable = data.contracts.filter((contract) => contract.reachable).length
  const highTurnover = fuel?.liquidityUsd != null && fuel.liquidityUsd > 0 && fuel.volume24h != null
    ? fuel.volume24h / fuel.liquidityUsd
    : null
  const bothPools = fuel?.liquidityUsd != null && more?.liquidityUsd != null
  const lowestPool = bothPools ? Math.min(fuel.liquidityUsd!, more.liquidityUsd!) : null
  const holderValues = [data.holders.FUEL?.topNonContractPercent, data.holders.MORE?.topNonContractPercent]
  const largestWallet = holderValues.every(value => value != null) ? Math.max(...holderValues as number[]) : null

  const risks = [
    {
      tone: (lowestPool == null || lowestPool < 25_000 ? 'warn' : 'good') as 'warn' | 'good',
      title: 'Thin executable liquidity',
      body: lowestPool == null ? 'Pool data incomplete; liquidity assessment unavailable.' : `Lowest pool: $${Math.round(lowestPool).toLocaleString()}. Slippage can dominate price.`,
    },
    {
      tone: (highTurnover == null || highTurnover > 5 ? 'warn' : 'good') as 'warn' | 'good',
      title: 'FUEL turnover',
      body: highTurnover == null ? 'Waiting for pool data.' : `${highTurnover.toFixed(1)}× liquidity traded in 24h.`,
    },
    {
      tone: (verified === data.contracts.length ? 'good' : 'risk') as 'risk' | 'good',
      title: 'Source verification',
      body: reachable === data.contracts.length
        ? `${verified} verified · ${data.contracts.length - verified} unverified on Blockscout.`
        : `${verified} verified · ${data.contracts.length - reachable} status checks unavailable.`,
    },
    {
      tone: (largestWallet == null || largestWallet > 10 ? 'warn' : 'good') as 'warn' | 'good',
      title: 'Largest non-contract holder',
      body: largestWallet != null ? `${largestWallet.toFixed(2)}% of token supply.` : 'Holder classification unavailable.',
    },
  ]

  return (
    <aside className="panel risk-panel" aria-labelledby="risk-title">
      <div className="panel-heading compact">
        <div><h2 id="risk-title">Risk signals</h2><p>Calculated indicators · not a security audit</p></div>
        <ShieldCheck size={18} />
      </div>
      <div className="risk-list">
        {risks.map((risk) => {
          const Icon = risk.tone === 'good' ? CheckCircle2 : risk.tone === 'warn' ? AlertTriangle : CircleAlert
          return <div className={`risk-row ${risk.tone}`} key={risk.title}>
            <Icon size={20} />
            <div><strong>{risk.title}</strong><span>{risk.body}</span></div>
          </div>
        })}
      </div>
    </aside>
  )
}
