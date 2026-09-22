// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FuelActivity } from './FuelActivity'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('keeps a stale report visible with its warning instead of rejecting the API status', async () => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'stale', progress: null, error: 'Activity tip is behind', report: {
    days: [{ date: '2026-09-19', mints: 5, claims: 0, mintWallets: 2, claimWallets: 0, claimedFuel: '0' }],
    throughBlock: '123456', throughTimestamp: Math.floor(Date.now() / 1000) - 7200, generatedAt: new Date().toISOString(),
  } })))
  render(<FuelActivity/>)
  await screen.findByText(/123456/)
  expect(screen.getByText(/Activity tip is behind/)).toBeTruthy()
  expect(screen.queryByText(/Activity feed unavailable/)).toBeNull()
})
