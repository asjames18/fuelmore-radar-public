// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FuelPlanner } from './FuelPlanner'
import { fetchPlannerQuote } from '../lib/planner'
vi.mock('../lib/planner', async original => ({ ...await original<typeof import('../lib/planner')>(), fetchPlannerQuote: vi.fn() }))
afterEach(cleanup)
beforeEach(() => {
  vi.mocked(fetchPlannerQuote).mockResolvedValue({ blockNumber: 100n, timestamp: Math.floor(Date.now() / 1000), fetchedAt: Date.now(), gasPrice: 1000000000n, maxMintTermSeconds: 27388800n, currentApy: 20n, direct: { mintFee: 150000000000000n, claimFee: null }, rows: [{ count: 10, mintFee: 1500000000000000n, claimFee: null }] })
})
it('clears displayed quotes when batch size changes and preserves unknown claim costs', async () => {
  render(<FuelPlanner/>)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fee comparison' }))
  await screen.findByText('0.0015 ETH')
  expect(screen.getByText('Partial snapshot — some reads failed')).toBeTruthy()
  expect(screen.getByText('Unavailable — formula unverified')).toBeTruthy()
  expect(screen.getByText(/MintVault \/ Pump Fund/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Batch size'), { target: { value: '25' } })
  expect(screen.queryByText('0.0015 ETH')).toBeNull()
})
it('failed refresh removes prior fees instead of refreshing their age', async () => {
  render(<FuelPlanner/>)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fee comparison' }))
  await screen.findByText('0.0015 ETH')
  vi.mocked(fetchPlannerQuote).mockRejectedValueOnce(Error('offline'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fee comparison' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('0.0015 ETH')).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh fee comparison' }).hasAttribute('disabled')).toBe(false))
})

it('converts the contract maximum from seconds to days and rejects longer plans', async () => {
  render(<FuelPlanner/>)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fee comparison' }))
  await screen.findByText('317 days')
  fireEvent.change(screen.getByLabelText('Mint duration in days'), { target: { value: '318' } })
  expect(screen.getByText('Unavailable — enter 7 days through the current maximum')).toBeTruthy()
})
