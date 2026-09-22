import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProtocolStats } from './ProtocolStats'
import type { ProtocolSnapshot } from '../lib/types'
it('does not turn incomplete burn totals into a zero or partial ETH total', () => {
  const protocol = { ethUsedFuelBurns: 1_000_000_000_000_000_000n, ethUsedMoreBurns: null } as ProtocolSnapshot
  const markup = renderToStaticMarkup(<ProtocolStats protocol={protocol}/>)
  expect(markup).toContain('ETH used for burns')
  expect(markup).not.toContain('1 ETH')
  expect(markup).not.toContain('0 ETH')
  expect(markup).toContain('—')
  expect(markup).toContain('Supply &amp; minting')
  expect(markup).toContain('Burns')
})
