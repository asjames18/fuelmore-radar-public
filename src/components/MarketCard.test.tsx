// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MarketCard } from './MarketCard'
import type { SideQuote } from '../lib/history'
import type { PairSnapshot } from '../lib/types'

const pair = {
  symbol: 'FUEL',
  name: 'FUEL',
  tokenAddress: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3',
  pairAddress: '0xpool',
  dexId: 'uniswap',
  version: 'v3',
  priceUsd: 0.00000622,
  priceNative: null,
  liquidityUsd: 100000,
  marketCap: null,
  fdv: null,
  volume24h: 5000,
  buys24h: null,
  sells24h: null,
  change1h: null,
  change6h: null,
  change24h: 1.5,
  pairCreatedAt: null,
} as PairSnapshot

afterEach(cleanup)

it('renders dashboard values when no worker quote is available', () => {
  render(<MarketCard pair={pair}/>)
  expect(screen.getByText('$0.00000622')).toBeDefined()
  expect(screen.getByText('+1.50%')).toBeDefined()
})

it('overrides price, liquidity, and change from the worker quote so cards match the chart', () => {
  const quote: SideQuote = { priceUsd: 0.00000403, liquidityUsd: 200000, change24h: -12.34, observedAt: Date.now(), source: 'dexscreener' }
  render(<MarketCard pair={pair} quote={quote}/>)
  expect(screen.getByText('$0.00000403')).toBeDefined()
  expect(screen.getByText('-12.34%')).toBeDefined()
  expect(screen.getByText('$200K')).toBeDefined()
})

it('falls back to dashboard values when the worker quote has no price', () => {
  const quote: SideQuote = { priceUsd: null, liquidityUsd: 200000, change24h: null, observedAt: null, source: null }
  render(<MarketCard pair={pair} quote={quote}/>)
  expect(screen.getByText('$0.00000622')).toBeDefined()
  expect(screen.getByText('+1.50%')).toBeDefined()
})

it('shows honest unknowns for unsupported worker values instead of borrowing dashboard values', () => {
  // Worker price present, but the series cannot support liquidity or a 24h
  // change: the card must not mix in the dashboard pipeline's numbers.
  const quote: SideQuote = { priceUsd: 0.00000403, liquidityUsd: null, change24h: null, observedAt: Date.now(), source: 'dexscreener' }
  render(<MarketCard pair={pair} quote={quote}/>)
  expect(screen.getByText('$0.00000403')).toBeDefined()
  const grid = screen.getByText('Liquidity').closest('div')!.parentElement!
  expect(grid.textContent).toContain('Liquidity—')
  expect(screen.queryByText('+1.50%')).toBeNull()
  expect(screen.queryByText('$100K')).toBeNull()
})
