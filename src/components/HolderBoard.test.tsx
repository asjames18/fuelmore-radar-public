import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HolderBoard } from './HolderBoard'
import { unavailableHolders, type HolderSummary } from '../lib/types'

it('keeps unavailable holder lists distinct from a confirmed empty census', () => {
  const missing = renderToStaticMarkup(<HolderBoard holders={{ FUEL: unavailableHolders(), MORE: unavailableHolders() }}/>)
  expect(missing).toContain('Top-holder list unavailable')
  expect(missing).not.toContain('No holders returned')
  const empty: HolderSummary = { ...unavailableHolders(), totalHolders: 0, topHolders: [] }
  const confirmed = renderToStaticMarkup(<HolderBoard holders={{ FUEL: empty, MORE: empty }}/>)
  expect(confirmed).toContain('No holders returned at this explorer snapshot')
})

it('renders explorer-supplied rows without filling missing percents as zero', () => {
  const holders: HolderSummary = {
    totalHolders: 12,
    topAddress: '0x1111111111111111111111111111111111111111',
    topPercent: 40,
    topIsContract: true,
    topNonContractPercent: null,
    topHolders: [
      { address: '0x1111111111111111111111111111111111111111', percent: 40, isContract: true },
      { address: '0x2222222222222222222222222222222222222222', percent: null, isContract: false },
    ],
  }
  const markup = renderToStaticMarkup(<HolderBoard holders={{ FUEL: holders, MORE: unavailableHolders() }}/>)
  expect(markup).toContain('40.00%')
  expect(markup).toContain('—')
  expect(markup).toContain('Contract')
  expect(markup).toContain('Wallet')
})
