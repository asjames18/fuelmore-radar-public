// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MarketChart } from './MarketChart'
import { formatChartTooltipValue } from '../lib/format'
afterEach(() => {cleanup();vi.unstubAllGlobals()})
const history=[{at:100000,fuelPrice:0.01,morePrice:0.00003,fuelLiquidity:1000,moreLiquidity:100},{at:160000,fuelPrice:0.012,morePrice:0.00004,fuelLiquidity:1200,moreLiquidity:110}]
function setup(){vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} });render(<MarketChart history={history}/>)}
it('defaults to real USD candles for both canonical pools without an observation table',()=>{
 setup()
 for(const token of ['FUEL','MORE']) {
  const frame=screen.getByTitle(`${token} USD candlestick chart`) as HTMLIFrameElement
  expect(frame.src).toContain(token==='FUEL'?'0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69':'0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef')
  expect(frame.src).toContain('chartStyle=1');expect(frame.src).toContain('chartType=usd')
 }
 expect(screen.queryByText(/Exact observations/)).toBeNull()
 expect(screen.queryByRole('table')).toBeNull()
})
it('offers an actual-dollar overlay and optional percentage comparison, then dollar liquidity',()=>{
 setup();fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
 expect(screen.getByText(/FUEL left · MORE right/)).toBeTruthy()
 expect(screen.queryByTitle('FUEL USD candlestick chart')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Change %'}))
 expect(screen.getByText(/Price change/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Liquidity'}))
 expect(screen.getByText(/Pool liquidity · USD/)).toBeTruthy()
 expect(screen.queryByRole('button',{name:'Change %'})).toBeNull()
 expect(screen.queryByRole('table')).toBeNull()
})
it('never renders a null observation as $0.00 or +0.00% in tooltips',()=>{
 expect(formatChartTooltipValue(null,false)).toBe('—')
 expect(formatChartTooltipValue(undefined,true)).toBe('—')
 expect(formatChartTooltipValue(NaN,false)).toBe('—')
 // A genuine zero is still a zero, not unknown.
 expect(formatChartTooltipValue(0,false)).toBe('$0.00')
 expect(formatChartTooltipValue(1.5,false)).toBe('$1.50')
 expect(formatChartTooltipValue(-2.5,true)).toBe('-2.50%')
})
it('reads the latest-observation strip from the same worker feed as the token cards',()=>{
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
  // The merged history's newest FUEL price is $0.012 — a browser-recorded
  // dashboard point. The worker quote must win so the strip matches the cards.
  const quotes = {
    FUEL: { priceUsd: 0.00000403, liquidityUsd: 200000, change24h: -12.34, observedAt: 160000, source: 'dexscreener' },
    MORE: { priceUsd: null, liquidityUsd: null, change24h: null, observedAt: null, source: null },
  }
  render(<MarketChart history={history} quotes={quotes}/>)
  fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
  const strip = screen.getByLabelText('Latest chart observations')
  expect(strip.textContent).toContain('$0.00000403')
  expect(strip.textContent).not.toContain('$0.012')
  // An unsupported worker value stays unknown instead of borrowing history.
  expect(strip.textContent).toContain('MORE—')
})
it('falls back to the merged series in the strip before the first worker fetch',()=>{
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
  render(<MarketChart history={history} quotes={null}/>)
  fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
  const strip = screen.getByLabelText('Latest chart observations')
  expect(strip.textContent).toContain('$0.012')
})
it('attributes the strip to the worker quotes when they drive it, not the merged point',()=>{
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
  // The merged history's newest point is browser-recorded (no source); the
  // caption must describe the worker quotes the strip actually shows.
  const quotes = {
    FUEL: { priceUsd: 0.00000403, liquidityUsd: 200000, change24h: -12.34, observedAt: 160000, source: 'dexscreener' },
    MORE: { priceUsd: null, liquidityUsd: null, change24h: null, observedAt: null, source: null },
  }
  render(<MarketChart history={history} quotes={quotes}/>)
  fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
  const note = screen.getByText(/Latest ·/)
  expect(note.textContent).toContain('FUEL via dexscreener')
  expect(note.textContent).toContain('MORE no worker quote yet')
  expect(note.textContent).not.toContain('recorded in this browser')
})
it('states the production snapshot cadence so the caption matches the Guide',()=>{
 setup()
 fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
 // Production cron is */5 and the Guide says "every 5 minutes"; the chart
 // caption must not contradict it with the old dev-era 15-minute figure.
 const note = screen.getByText(/the radar's collector records a point/)
 expect(note.textContent).toContain('about every 5 minutes')
 expect(note.textContent).not.toContain('15 minutes')
})
it('names collector coverage when a fixed range outruns the available history',()=>{
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
  const day = 86_400_000
  // Two days of history: 7D and 30D honestly show everything, but the note
  // says why they do not show 7 or 30 days.
  const twoDays=[0,day,2*day].map((at,i)=>({at,fuelPrice:0.01+i*0.002,morePrice:0.00003,fuelLiquidity:1000,moreLiquidity:100}))
  render(<MarketChart history={twoDays}/>)
  fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
  fireEvent.click(screen.getByRole('button',{name:'7D'}))
  const note = screen.getByText(/Collector history starts/)
  expect(note.textContent).toContain('the 7D view fills in as observations accumulate')
  // A covered range gets no note, and ALL needs none — it shows everything.
  fireEvent.click(screen.getByRole('button',{name:'1D'}))
  expect(screen.queryByText(/Collector history starts/)).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'ALL'}))
  expect(screen.queryByText(/Collector history starts/)).toBeNull()
})
