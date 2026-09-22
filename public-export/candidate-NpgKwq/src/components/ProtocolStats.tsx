import { Activity, Flame, Gauge, LockKeyhole } from 'lucide-react'
import { formatEth, formatToken } from '../lib/format'
import type { ProtocolSnapshot } from '../lib/types'

type Stat = { label: string; value: string; note: string; Icon: typeof Gauge }

function StatGroup({ title, stats }: { title: string; stats: Stat[] }) {
  return (
    <div className="stats-group">
      <h3>{title}</h3>
      <div className="stat-grid">
        {stats.map(({ label, value, note, Icon }) => (
          <article className="stat-cell" key={label}>
            <div><span>{label}</span><Icon size={17}/></div>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
    </div>
  )
}

export function ProtocolStats({ protocol }: { protocol: ProtocolSnapshot }) {
  const maxDays = protocol.maxTermSeconds == null ? null : Number(protocol.maxTermSeconds / 86_400n)
  const supply: Stat[] = [
    { label: 'FUEL supply', value: formatToken(protocol.totalSupply), note: 'current total supply', Icon: Gauge },
    { label: 'Mint rank', value: protocol.globalRank?.toLocaleString() ?? '—', note: `${protocol.activeMinters?.toLocaleString() ?? '—'} active mint positions`, Icon: Activity },
    { label: 'FUEL staked', value: formatToken(protocol.totalStaked), note: `${protocol.activeStakes?.toString() ?? '—'} active stakes`, Icon: LockKeyhole },
    { label: 'Max mint term', value: maxDays == null ? '—' : `${maxDays} days`, note: `AMP ${protocol.amp?.toString() ?? '—'} · EAAR ${protocol.eaar?.toString() ?? '—'}`, Icon: Gauge },
  ]
  const burns: Stat[] = [
    { label: 'FUEL burned', value: formatToken(protocol.fuelBurnt), note: 'reported by burn controller', Icon: Flame },
    { label: 'MORE burned', value: formatToken(protocol.moreBurnt), note: 'reported by burn controller', Icon: Flame },
    { label: 'ETH used for burns', value: formatEth(protocol.ethUsedFuelBurns === null || protocol.ethUsedMoreBurns === null ? null : protocol.ethUsedFuelBurns + protocol.ethUsedMoreBurns), note: 'both burn controllers', Icon: Flame },
  ]
  const vault: Stat[] = [
    { label: 'Pump fund', value: formatEth(protocol.vaultBalance), note: `cycle ${protocol.vaultCycle?.toString() ?? '—'}`, Icon: LockKeyhole },
  ]
  return (
    <section className="stats-board" aria-label="Protocol statistics">
      <StatGroup title="Supply & minting" stats={supply}/>
      <StatGroup title="Burns" stats={burns}/>
      <StatGroup title="Vault" stats={vault}/>
    </section>
  )
}
