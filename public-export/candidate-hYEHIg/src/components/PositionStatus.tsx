import { dateDueTone, mintDueState, type DueTone } from '../lib/maturity'

export function PositionMintBadge({ maturityTs, now }: { maturityTs: number; now: number }) {
  const state = mintDueState(maturityTs, now)
  return <span className={`maturity-badge ${state.tone}`}>{state.label}</span>
}

export function PositionDateBadge({ timestamp, now, dueLabel = 'Due' }: { timestamp: number; now: number; dueLabel?: string }) {
  const tone: DueTone = dateDueTone(timestamp, now)
  return <span className={`maturity-badge ${tone}`}>{tone === 'upcoming' ? 'Upcoming' : dueLabel}</span>
}
