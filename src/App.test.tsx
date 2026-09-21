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
it('speculation view renders forward projections from live inputs, degrading gracefully', async () => {
 const report = {
  maturity: { status: 'ready', days: [{ date: '2026-09-22', scheduled: 4092 }, { date: '2026-09-23', scheduled: 901 }] },
  days: [
   { date: '2026-09-18', mints: 870, claims: 4, claimedFuel: '400' },
   { date: '2026-09-19', mints: 900, claims: 6, claimedFuel: '600' },
   { date: '2026-09-20', mints: 950, claims: 5, claimedFuel: '500' },
   { date: '2026-09-21', mints: 999, claims: 999, claimedFuel: '999999' },
  ],
  throughTimestamp: Math.floor(Date.now() / 1000),
  throughBlock: '0xabc',
  generatedAt: new Date().toISOString(),
 }
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ report }) }))
 radarState.data = {
  pairs: [
   { symbol: 'FUEL', name: 'FUEL', tokenAddress: '0x' + '11'.repeat(20), pairAddress: '0x' + '22'.repeat(20), dexId: 'testdex', version: 'v3', priceUsd: 0.004539, priceNative: 1.665e-06, marketCap: 4285, liquidityUsd: 5549.48, volume24h: 385.47 },
   { symbol: 'MORE', name: 'MORE', tokenAddress: '0x' + '33'.repeat(20), pairAddress: '0x' + '44'.repeat(20), dexId: 'testdex', version: 'v3', priceUsd: 3.823e-05, priceNative: 1.405e-08, marketCap: 36331, liquidityUsd: 3947.62, volume24h: 55.23 },
  ],
  holders: {}, activity: [], sources: [], contracts: [],
  protocol: {
   totalSupply: 943628222586147348158940n, moreTotalSupply: null,
   fuelBurnt: 25994772660845759936641n, moreBurnt: 4896317975811800492964756n,
  },
  updatedAt: Date.now(), partial: false,
 } as unknown as RadarData
 render(<App/>)
 fireEvent.click(screen.getAllByRole('button',{name:'Speculation'})[0])
 // The forward view renders even though the mint-fee read is mocked to null:
 // the supply trajectory degrades to claims-only instead of blanking the page.
 expect(await screen.findByText(/where today's chain state points/)).toBeTruthy()
 expect(await screen.findByText('Future supply · FUEL')).toBeTruthy()
 // The supply trajectory degrades to claims-only: recharts splits legend
 // labels across SVG nodes, so assert the plain-text degradation note.
 expect(screen.getByText(/Burns are excluded until the mint-fee read succeeds/)).toBeTruthy()
 expect(screen.getByText('The math behind the page')).toBeTruthy()
 // The burn section honestly reports its missing input with a retry affordance.
 expect(screen.getByText(/Burn projection unavailable/)).toBeTruthy()
 // MORE supply stays a labeled gap while the supply read is null — never zero.
 expect(screen.getByText(/MORE supply projection unavailable/)).toBeTruthy()
 vi.unstubAllGlobals()
 radarState.data = null
})
