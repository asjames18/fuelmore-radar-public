// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MintersView } from './MintersView'
import type { MintersResponse } from '../lib/minter'

const payload: MintersResponse = {
  status: 'ok',
  count: 2,
  rows: [
    {
      wallet: '0xc9df60b8167a6f3fa7efd1aad27a58ecaf0bbf21',
      claimed: 100111555,
      sold: 100111555,
      bought: 2096,
      pct_sold: 100,
      mints_opened: 295,
      remint_count: 245,
      remint_eth: 0.07704973125,
      first_claim_ts: 1758492903,
      first_sale_ts: 1758492904,
      last_active_ts: 1758493000,
    },
    {
      wallet: '0x0c5f03863cf28ee225131863c0af8ddc1571ec79',
      claimed: 50909350,
      sold: 50909350,
      bought: 2389,
      pct_sold: 100,
      mints_opened: 150,
      remint_count: 100,
      remint_eth: 0.031414275,
      first_claim_ts: 1758499415,
      first_sale_ts: 1758499416,
      last_active_ts: 1758499500,
    },
  ],
  methodology: 'Test methodology note.',
  through_block: '69275861',
  through_time: new Date(1758499600 * 1000).toISOString(),
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

it('renders the minter table with claimed, sold, bought, pct and re-mints', async () => {
  mockFetch(payload)
  render(<MintersView onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
  const table = screen.getByRole('table')
  expect(within(table).getAllByText('100.1M').length).toBe(2)
  expect(within(table).getByText('2,096')).toBeTruthy()
  expect(within(table).getByText('2,389')).toBeTruthy()
  expect(within(table).getAllByText('100.0%').length).toBe(2)
  expect(within(table).getByText('245')).toBeTruthy()
  expect(within(table).getByText('0.0770 ETH')).toBeTruthy()
  expect(screen.getByText('Test methodology note.')).toBeTruthy()
  expect(screen.getByText(/Data through block 69,275,861/)).toBeTruthy()
})

it('shows collecting instead of zeroes while the collector backfills', async () => {
  mockFetch({ ...payload, status: 'collecting', rows: [], count: 0 })
  render(<MintersView onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getByText('Collecting minter data…')).toBeTruthy())
  expect(screen.queryByRole('table')).toBeNull()
})

it('shows an honest error when the request fails', async () => {
  mockFetch({}, false)
  render(<MintersView onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy())
})

it('sorts by column when headers are clicked', async () => {
  mockFetch(payload)
  render(<MintersView onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
  const fetchMock = vi.mocked(fetch)
  fetchMock.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Sort by Claimed' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(vi.mocked(fetch).mock.calls[0][0]).toContain('sort=claimed')
})

it('sends the wallet to the Cockpit lookup when clicked', async () => {
  mockFetch(payload)
  const lookup = vi.fn()
  render(<MintersView onLookupWallet={lookup} />)
  await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
  fireEvent.click(screen.getAllByTitle('Look up in Cockpit')[0])
  expect(lookup).toHaveBeenCalledWith('0xc9df60b8167a6f3fa7efd1aad27a58ecaf0bbf21')
})
