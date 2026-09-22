// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DailyFlowCards } from './DailyFlowCards'
import type { DailyFlowsResponse } from '../lib/minter'

const payload: DailyFlowsResponse = {
  status: 'ok',
  date: '2026-09-21',
  buyers: [
    { wallet: '0xaa6bef47484a72aafd0a37361cbedb1fbace6dc6', fuel: 132973199, usd: 1070.02 },
  ],
  sellers: [
    { wallet: '0xc9df60b8167a6f3fa7efd1aad27a58ecaf0bbf21', fuel: 100112140, usd: 204.34 },
    { wallet: '0x0c5f03863cf28ee225131863c0af8ddc1571ec79', fuel: 50911739, usd: null },
  ],
  buy_vol_usd: 1500,
  sell_vol_usd: 900,
  n_buys: 397,
  n_sells: 363,
  usd_missing: 1,
  note: 'Test flows note.',
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

it('renders top buyers and sellers with FUEL and approximate USD', async () => {
  mockFetch(payload)
  render(<DailyFlowCards onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getByText('Top buyers')).toBeTruthy())
  expect(screen.getByText('Top sellers')).toBeTruthy()
  expect(screen.getByText('133M FUEL')).toBeTruthy()
  expect(screen.getByText('~$1,070.02')).toBeTruthy()
  expect(screen.getByText('~USD unavailable')).toBeTruthy()
  expect(screen.getByText('397')).toBeTruthy()
  expect(screen.getByText('Test flows note.')).toBeTruthy()
})

it('shows collecting instead of zeroes while the day has no data', async () => {
  mockFetch({ ...payload, status: 'collecting', buyers: [], sellers: [] })
  render(<DailyFlowCards onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getAllByText("Collecting today's flow…").length).toBe(2))
})

it('shows an honest error when the request fails', async () => {
  mockFetch({}, false)
  render(<DailyFlowCards onLookupWallet={() => {}} />)
  await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeTruthy())
})

it('sends the wallet to the Cockpit lookup when clicked', async () => {
  mockFetch(payload)
  const lookup = vi.fn()
  render(<DailyFlowCards onLookupWallet={lookup} />)
  await waitFor(() => expect(screen.getByText('Top buyers')).toBeTruthy())
  fireEvent.click(screen.getAllByTitle('Look up in Cockpit')[0])
  expect(lookup).toHaveBeenCalledWith('0xaa6bef47484a72aafd0a37361cbedb1fbace6dc6')
})
