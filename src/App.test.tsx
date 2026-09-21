// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'
import type { RadarData } from './lib/types'
const radarState = vi.hoisted(() => ({ data: null as RadarData | null, history: [] as unknown[], status: 'loading', error: null as string | null, refresh: vi.fn(), refreshing: false }))
vi.mock('./useRadarData', () => ({useRadarData:()=>radarState}))
vi.mock('./lib/planner', () => ({fetchMintFee: () => Promise.resolve({ mintFeeEth: null, gasPrice: null })}))
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
 expect(cards.map(card => card.querySelector('strong')?.textContent)).toEqual(['Cockpit', 'Markets', 'Protocol', 'Speculation', 'Contracts', 'Guide', 'Planner'])
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
it('speculation view renders assumptions and official project links', () => {
 radarState.data = { pairs: [], holders: {}, activity: [], sources: [], contracts: [], protocol: { totalSupply: 1000000n, moreTotalSupply: 500000n, fuelBurnt: 50000n, moreBurnt: 1000n }, updatedAt: Date.now(), partial: false } as unknown as RadarData
 render(<App/>)
 fireEvent.click(screen.getAllByRole('button',{name:'Speculation'})[0])
 expect(screen.getByText('What these numbers assume')).toBeTruthy()
 expect(screen.getByText('Supply · now and next 12 months')).toBeTruthy()
 expect(screen.getByRole('link',{name:/FUEL site/}).getAttribute('href')).toBe('https://fuelmoretokens.com/')
 expect(screen.getByRole('link',{name:/FUEL app/}).getAttribute('href')).toBe('https://app.fuelmoretokens.com/')
 expect(screen.getByRole('link',{name:/MORE site/}).getAttribute('href')).toBe('https://www.moretokens.com/')
 expect(screen.getByRole('link',{name:/MORE app/}).getAttribute('href')).toBe('https://app.moretokens.com/')
 radarState.data = null
})
