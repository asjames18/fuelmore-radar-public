// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AnalyticsPanel } from './AnalyticsPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stubSummary(payload: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ok ? Response.json(payload) : new Response('no', { status: 404 })))
}

it('renders per-day counts from the summary endpoint', async () => {
  stubSummary({ days: [
    { date: '2026-09-20', counts: { view_selected: 4, cockpit_open: 2, wallet_lookup: 1 } },
    { date: '2026-09-19', counts: {} },
  ] })
  render(<AnalyticsPanel/>)
  expect(await screen.findByText('2026-09-20')).toBeTruthy()
  expect(screen.getByText('2026-09-19')).toBeTruthy()
  expect(screen.getByText('Usage analytics')).toBeTruthy()
  expect(screen.getByText('dash.cloudflare.com', { exact: false })).toBeTruthy()
})

it('shows an empty state when no usage was recorded', async () => {
  stubSummary({ days: [] })
  render(<AnalyticsPanel/>)
  expect(await screen.findByText(/No usage recorded/)).toBeTruthy()
})

it('shows an error state when the summary endpoint is unavailable', async () => {
  stubSummary(null, false)
  render(<AnalyticsPanel/>)
  expect(await screen.findByText(/Usage summary unavailable/)).toBeTruthy()
})
