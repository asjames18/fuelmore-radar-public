import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { mintCardClass } from '../lib/maturity'
import { PositionDateBadge, PositionMintBadge } from './PositionStatus'

it('styles FUEL mint cards as upcoming, due, or late without claim amounts', () => {
  const now = Date.parse('2026-09-15T12:00:00Z') / 1000
  expect(mintCardClass(now + 10, now)).toContain('position-upcoming')
  expect(mintCardClass(now, now)).toContain('position-due')
  expect(mintCardClass(now - 86_400, now)).toContain('position-late')
  const due = renderToStaticMarkup(<PositionMintBadge maturityTs={now} now={now}/>)
  const late = renderToStaticMarkup(<PositionMintBadge maturityTs={now - 86_400} now={now}/>)
  expect(due).toContain('Due · penalty-free window')
  expect(late).toContain('1% penalty schedule')
  expect(due).not.toContain('FUEL')
  expect(late).not.toContain('claimable')
})

it('keeps stake/date badges free of the mint penalty schedule', () => {
  const now = 1_000
  const markup = renderToStaticMarkup(<PositionDateBadge timestamp={500} now={now} dueLabel="Matured"/>)
  expect(markup).toContain('Matured')
  expect(markup).not.toContain('penalty')
})
