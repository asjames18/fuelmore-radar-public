import { lateClaimPenaltyPct } from './provenance'
import type { WalletPosition } from './types'
export type CalendarEntry = { id: string; label: string; kind: 'mint' | 'stake'; maturityTs: number }
export type DueTone = 'upcoming' | 'due' | 'late'
export type MintDueState = {
  tone: DueTone
  label: string
  penaltyPct: number | null
  secsLate: number
}
export function walletCalendar(position: WalletPosition): CalendarEntry[] {
  const entries: CalendarEntry[] = []
  if (position.reads.mint && position.mint) entries.push({ id: 'direct-mint', label: 'Direct FUEL mint', kind: 'mint', maturityTs: Number(position.mint.maturityTs) })
  if (position.reads.stake && position.stake) entries.push({ id: 'direct-stake', label: 'Direct FUEL stake', kind: 'stake', maturityTs: Number(position.stake.maturityTs) })
  for (const item of position.batch.items) if (item.available && item.mint) entries.push({ id: `batch-${item.index}`, label: `Batch slot ${item.index + 1}`, kind: 'mint', maturityTs: Number(item.mint.maturityTs) })
  return entries.sort((a, b) => a.maturityTs - b.maturityTs || a.id.localeCompare(b.id))
}
export function maturityState(timestamp: number, now: number) {
  if (timestamp > now) return 'Upcoming'
  return timestamp >= Math.floor(now / 86400) * 86400 ? 'Matured today' : 'Past maturity'
}
/** Date-only due flag for stakes. Does not apply the mint late-penalty schedule. */
export function dateDueTone(timestamp: number, now: number): Exclude<DueTone, 'late'> {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) throw new Error('Invalid maturity timestamp')
  return timestamp > now ? 'upcoming' : 'due'
}
/**
 * FUEL mint due/late state from verified Token._penalty. Does not compute
 * claim amounts — penalty percent is a schedule, not a payout.
 */
export function mintDueState(maturityTs: number, now: number): MintDueState {
  if (!Number.isFinite(maturityTs) || !Number.isFinite(now)) throw new Error('Invalid maturity timestamp')
  if (maturityTs > now) return { tone: 'upcoming', label: 'Upcoming', penaltyPct: null, secsLate: 0 }
  const secsLate = now - maturityTs
  const penaltyPct = lateClaimPenaltyPct(secsLate)
  if (penaltyPct === 0) {
    return { tone: 'due', label: 'Due · penalty-free window', penaltyPct, secsLate }
  }
  return { tone: 'late', label: `Late · ${penaltyPct}% penalty schedule`, penaltyPct, secsLate }
}
export function mintCardClass(maturityTs: number, now: number) {
  return `position-card position-${mintDueState(maturityTs, now).tone}`
}
export function dateCardClass(timestamp: number, now: number) {
  return `position-card position-${dateDueTone(timestamp, now)}`
}
export function monthCells(month: string): Array<string | null> {
  const [year, number] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, number - 1, 1))
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return [...Array<null>(first.getUTCDay()).fill(null), ...Array.from({ length: days }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)]
}
