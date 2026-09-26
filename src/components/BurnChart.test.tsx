// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { BurnChart } from './BurnChart'
import type { BurnsResponse } from '../lib/burns'

const payload: BurnsResponse = {
  status: 'ok',
  days: [
    { date: '2026-09-21', fuel: 527410.98, eth: 0.00972, drips: 19 },
    { date: '2026-09-22', fuel: 3869754.35, eth: 0.003613, drips: 7 },
  ],
  totals: { fuel: 4397165.33, eth: 0.013333, drips: 26 },
  methodology: 'Test burn methodology.',
  through_block: '69530000',
  through_time: new Date(1758525600 * 1000).toISOString(),
}

function mockFetch(data: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => data,
    })),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('renders totals, the chart, and the methodology', async () => {
  mockFetch(payload)
  render(<BurnChart />)
  await waitFor(() => expect(screen.getByText('FUEL buy & burn')).toBeTruthy())
  expect(screen.getByText('4.4M FUEL')).toBeTruthy()
  expect(screen.getByText('0.0133 ETH')).toBeTruthy()
  expect(screen.getByText('26')).toBeTruthy()
  expect(screen.getByText('Test burn methodology.')).toBeTruthy()
  expect(screen.getByText(/Data through block 69,530,000/)).toBeTruthy()
})

it('shows collecting instead of zeroes while the series is empty', async () => {
  mockFetch({ ...payload, status: 'collecting', days: [], totals: { fuel: null, eth: null, drips: null } })
  render(<BurnChart />)
  await waitFor(() => expect(screen.getByText('Collecting burn history…')).toBeTruthy())
  expect(screen.queryByText('4.4M FUEL')).toBeNull()
})

it('shows the syncing-paused note when burn data is stale', async () => {
  mockFetch(payload)
  render(<BurnChart />)
  await waitFor(() => expect(screen.getByText(/Syncing paused — showing last available data/)).toBeTruthy())
})

it('hides the syncing-paused note when burn data is fresh', async () => {
  mockFetch({ ...payload, through_time: new Date().toISOString() })
  render(<BurnChart />)
  await waitFor(() => expect(screen.getByText(/Data through block/)).toBeTruthy())
  expect(screen.queryByText(/Syncing paused/)).toBeNull()
})

it('shows an honest error when the request fails', async () => {
  mockFetch({}, false)
  render(<BurnChart />)
  await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy())
})
