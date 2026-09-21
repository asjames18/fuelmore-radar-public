// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { track } from './analytics'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('falls back to fetch with keepalive when sendBeacon fails or is missing', async () => {
  let seen: { url: unknown; init: RequestInit | undefined } | null = null
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { seen = { url, init }; return new Response() }))
  vi.stubGlobal('navigator', { sendBeacon: () => false, doNotTrack: null })
  track('refresh_clicked')
  expect(seen).not.toBeNull()
  expect(seen!.url).toBe('/api/analytics')
  expect(seen!.init?.method).toBe('POST')
  expect(seen!.init?.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(seen!.init?.body).toBe('{"event":"refresh_clicked"}')
  expect(seen!.init?.keepalive).toBe(true)
})

it('sends only the event name through sendBeacon', () => {
  let seen: { url: unknown; body: unknown } | null = null
  vi.stubGlobal('navigator', { sendBeacon: (url: string, body: Blob) => { seen = { url, body }; return true }, doNotTrack: null })
  track('view_selected')
  expect(seen).not.toBeNull()
  expect(seen!.url).toBe('/api/analytics')
  expect(seen!.body).toBeInstanceOf(Blob)
})

it('swallows fetch rejections so analytics can never break the app', () => {
  const fetchMock = vi.fn(async () => { throw new Error('network down') })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('navigator', { doNotTrack: null })
  expect(() => track('refresh_clicked')).not.toThrow()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('skips tracking when Do Not Track is set', () => {
  const beacon = vi.fn(() => true)
  const fetchMock = vi.fn()
  vi.stubGlobal('navigator', { sendBeacon: beacon, doNotTrack: '1' })
  vi.stubGlobal('fetch', fetchMock)
  track('cockpit_open')
  expect(beacon).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})
