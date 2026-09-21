// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'
import type { RadarData } from './lib/types'
const radarState = vi.hoisted(() => ({ data: null as RadarData | null, history: [] as unknown[], status: 'loading', error: null as string | null, refresh: vi.fn(), refreshing: false }))
vi.mock('./useRadarData', () => ({useRadarData:()=>radarState}))
afterEach(cleanup)
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
it('keeps public sync automatic with only a timestamp and cadence', () => {
 render(<App/>)
 expect(screen.getByText(/Last sync:/)).toBeTruthy()
 expect(screen.getByText('Updates every 15 minutes')).toBeTruthy()
 expect(screen.queryByRole('button',{name:'Refresh'})).toBeNull()
 expect(screen.queryByText('SYNCING')).toBeNull()
 expect(screen.queryByText(/Saved data timestamps/)).toBeNull()
})

it('overview hub shows one card per radar section and navigates', () => {
 radarState.data = { pairs: [], holders: {}, activity: [], sources: [], contracts: [], protocol: null, updatedAt: Date.now(), partial: false } as unknown as RadarData
 render(<App/>)
 const section = screen.getByText('Explore the radar').closest('section') as HTMLElement
 const cards = within(section).getAllByRole('button')
 expect(cards.map(card => card.querySelector('strong')?.textContent)).toEqual(['Cockpit', 'Markets', 'Protocol', 'Contracts', 'Guide', 'Planner'])
 fireEvent.click(cards[0])
 expect(screen.getByText('Wallet position lookup')).toBeTruthy()
 radarState.data = null
})
