import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RiskPanel } from './RiskPanel'
import type { RadarData } from '../lib/types'

it('treats confirmed zero 24h volume as 0× turnover instead of missing data', () => {
  const data = {
    partial: false,
    pairs: [{
      symbol: 'FUEL',
      liquidityUsd: 40_000,
      volume24h: 0,
    }],
    contracts: [],
    holders: {},
  } as unknown as RadarData
  const markup = renderToStaticMarkup(<RiskPanel data={data}/>)
  expect(markup).toContain('0.0× liquidity traded in 24h')
  expect(markup).not.toContain('Waiting for pool data')
})
