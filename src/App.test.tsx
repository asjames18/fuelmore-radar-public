// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'
import type { RadarData } from './lib/types'
const radarState = vi.hoisted(() => ({ data: null as RadarData | null, history: [] as unknown[], status: 'loading', error: null as string | null, refresh: vi.fn(), refreshing: false }))
vi.mock('./useRadarData', () => ({useRadarData:()=>radarState}))
vi.mock('./lib/planner', () => ({fetchMintFee: () => Promise.resolve({ mintFeeEth: null, gasPrice: null }), fetchFeePair: () => Promise.resolve({ mintFeeEth: null, claimFeeEth: null, gasPrice: null, at: null, error: 'mocked' })}))
afterEach(() => {
  cleanup()
  // selectView syncs ?view= into the URL; reset so tests stay isolated.
  window.history.replaceState(null, '', '/')
})
it('public nav keeps Planner as a coming-soon page', () => {
 render(<App/> )
 fireEvent.click(screen.getAllByRole('button',{name:'Planner'})[0])
 expect(screen.getByText(/The Planner is a future build/)).toBeTruthy()
})
it('cockpit view merges positions and claim modeling behind labeled tabs', () => {
 render(<App/> )
 fireEvent.click(screen.getAllByRole('button',{name:'Cockpit'})[0])
 expect(screen.getByText('Wallet position lookup')).toBeTruthy()
 fireEvent.click(screen.getByRole('tab',{name:/Inventory & claims/}))
 expect(screen.getByText(/Waiting for market data/)).toBeTruthy()
})
it('guide page explains every section in plain language', () => {
 render(<App/> )
 fireEvent.click(screen.getAllByRole('button',{name:'Guide'})[0])
 expect(screen.getByText('What the Radar is')).toBeTruthy()
 expect(screen.getByText(/Reading the numbers like a local/)).toBeTruthy()
})
it('renders exactly one mobile donation section and one footer donation chip', () => {
 const { container } = render(<App/>)
 expect(container.querySelectorAll('.donate-mobile').length).toBe(1)
 const footer = container.querySelector('footer') as HTMLElement | null
 expect(footer).toBeTruthy()
 expect(within(footer as HTMLElement).getAllByRole('button', { name: /copy donation address/i }).length).toBe(1)
 expect(screen.getAllByRole('button', { name: /copy donation address/i }).length).toBe(2)
})
it('keeps public sync automatic with only a timestamp and cadence', () => {
 render(<App/>)
 expect(screen.getByText(/Last sync:/)).toBeTruthy()
 expect(screen.getByText('Scheduled every 15 minutes')).toBeTruthy()
 expect(screen.queryByRole('button',{name:'Refresh'})).toBeNull()
 expect(screen.queryByText('SYNCING')).toBeNull()
 expect(screen.queryByText(/Saved data timestamps/)).toBeNull()
})

it('overview hub shows one card per radar section and navigates', () => {
 radarState.data = { pairs: [], holders: {}, activity: [], sources: [], contracts: [], protocol: null, updatedAt: Date.now(), partial: false } as unknown as RadarData
 render(<App/>)
 const section = screen.getByText('Explore the radar').closest('section') as HTMLElement
 const cards = within(section).getAllByRole('button')
 expect(cards.map(card => card.querySelector('strong')?.textContent)).toEqual(['Cockpit', 'Markets', 'Minters', 'Protocol', 'Contracts', 'Guide', 'Planner'])
 fireEvent.click(cards[0])
 expect(screen.getByText('Wallet position lookup')).toBeTruthy()
 radarState.data = null
})
it('overview shows number panels instead of the comparison chart, which lives in Markets', () => {
 radarState.data = { pairs: [], holders: {}, activity: [], sources: [], contracts: [], protocol: null, updatedAt: Date.now(), partial: false } as unknown as RadarData
 render(<App/>)
 expect(screen.getByText('Daily pulse')).toBeTruthy()
 expect(screen.queryByText('FUEL / MORE comparison')).toBeNull()
 fireEvent.click(screen.getAllByRole('button', { name: 'Markets' })[0])
 expect(screen.getByText('FUEL / MORE comparison')).toBeTruthy()
 radarState.data = null
})

it('deep link ?view= selects the view case-insensitively; unknown values fall back to Overview', () => {
  const title = () => document.querySelector('.page-title h1')?.textContent
  window.history.replaceState(null, '', '/?view=Minters')
  let r = render(<App/>)
  expect(title()).toBe('Minters')
  r.unmount()
  window.history.replaceState(null, '', '/?view=markets')
  r = render(<App/>)
  expect(title()).toBe('Markets')
  r.unmount()
  window.history.replaceState(null, '', '/?view=MINTERS')
  r = render(<App/>)
  expect(title()).toBe('Minters')
  r.unmount()
  // Unknown values must never blank the app: graceful Overview fallback.
  window.history.replaceState(null, '', '/?view=bogus')
  r = render(<App/>)
  expect(title()).toBe('Overview')
  expect(document.querySelector('.app-shell')).toBeTruthy()
  r.unmount()
})

it('in-app navigation keeps the view in the URL so links are shareable', () => {
  render(<App/>)
  fireEvent.click(screen.getAllByRole('button', { name: 'Minters' })[0])
  expect(new URLSearchParams(window.location.search).get('view')).toBe('Minters')
  expect(document.querySelector('.page-title h1')?.textContent).toBe('Minters')
})
