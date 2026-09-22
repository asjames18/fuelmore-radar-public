import { expect, it } from 'vitest'
import { dateDueTone, dateCardClass, maturityState, mintCardClass, mintDueState, monthCells, walletCalendar } from './maturity'
import type { WalletPosition } from './types'
it('uses UTC days and includes the exact maturity instant as matured', () => {
  const now = Date.parse('2026-09-15T12:00:00Z') / 1000
  expect(maturityState(now + 1, now)).toBe('Upcoming')
  expect(maturityState(now, now)).toBe('Matured today')
  expect(maturityState(now - 86400, now)).toBe('Past maturity')
})
it('separates upcoming, due, and late mint states without inventing claim amounts', () => {
  const now = Date.parse('2026-09-15T12:00:00Z') / 1000
  expect(mintDueState(now + 1, now)).toMatchObject({ tone: 'upcoming', penaltyPct: null })
  expect(mintDueState(now, now)).toMatchObject({ tone: 'due', penaltyPct: 0, label: 'Due · penalty-free window' })
  expect(mintDueState(now - 86_400, now)).toMatchObject({ tone: 'late', penaltyPct: 1 })
  expect(dateDueTone(now + 1, now)).toBe('upcoming')
  expect(dateDueTone(now, now)).toBe('due')
  expect(mintCardClass(now, now)).toContain('position-due')
  expect(dateCardClass(now + 1, now)).toContain('position-upcoming')
})
it('lays out leap February and UTC month boundaries', () => {
  const cells = monthCells('2028-02')
  expect(cells.filter(Boolean)).toHaveLength(29)
  expect(cells[0]).toBeNull()
  expect(cells.at(-1)).toBe('2028-02-29')
})
it('includes direct and successfully read batch positions without inventing failed slots', () => {
  const mint = { maturityTs: 200n } as NonNullable<WalletPosition['mint']>
  const position = { reads: { mint: true, stake: true }, mint, stake: null, batch: { items: [{ index: 0, available: true, mint }, { index: 1, available: false, mint }, { index: 2, available: true, mint: null }] } } as WalletPosition
  expect(walletCalendar(position).map(entry => entry.id).sort()).toEqual(['batch-0', 'direct-mint'])
})
