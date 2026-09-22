// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FeePreview } from './FeePreview'
import { fetchPlannerQuote } from '../lib/planner'
vi.mock('../lib/planner', async original => ({ ...await original<typeof import('../lib/planner')>(), fetchPlannerQuote: vi.fn() }))
afterEach(cleanup)
beforeEach(() => {
  vi.mocked(fetchPlannerQuote).mockResolvedValue({
    blockNumber: 100n,
    timestamp: Math.floor(Date.now() / 1000),
    fetchedAt: Date.now(),
    gasPrice: 1000000000n,
    maxMintTermSeconds: 27388800n,
    currentApy: 20n,
    direct: { mintFee: 10_000n, claimFee: 2_500n },
    rows: [{ count: 1, mintFee: 10_000n, claimFee: 2_500n }],
  })
})

it('quotes view-only fees and derived 45/25/30 shares without write-flow copy', async () => {
  render(<FeePreview/>)
  expect(screen.getByText(/no wallet/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }))
  expect(await screen.findByText('Direct mint fee')).toBeTruthy()
  expect(screen.getByText(/MintVault \/ Pump Fund/)).toBeTruthy()
  expect(screen.queryByText(/connect wallet/i)).toBeNull()
  expect(screen.queryByText(/approve/i)).toBeNull()
  expect(screen.queryByText(/send transaction/i)).toBeNull()
})

it('clears a quote when batch size changes and does not invent a zero fee', async () => {
  render(<FeePreview/>)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }))
  await screen.findByText(/MintVault \/ Pump Fund/)
  fireEvent.change(screen.getByLabelText('Fee preview batch size'), { target: { value: '10' } })
  expect(screen.queryByText('45% · MintVault / Pump Fund')).toBeNull()
})
