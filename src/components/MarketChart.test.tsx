// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MarketChart } from './MarketChart'

// No canvas in jsdom: the candle panes fall back to their text state, which is
// exactly what we assert on here.
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {},
  ColorType: { Solid: 'solid' },
  createChart: () => { throw new Error('no canvas in tests') },
}))

afterEach(() => {cleanup();vi.unstubAllGlobals()})
const DAY = 86400000
const point = (at: number) => ({at,fuelPrice:0.01,morePrice:0.00003,fuelLiquidity:1000,moreLiquidity:100})
// Short history (< 7 days): Dexscreener iframes stay visible.
const shortHistory=[point(100000),point(160000)]
// Deep history (>= 7 days): our own candles take over automatically.
const deepHistory=[point(100000),point(100000+8*DAY)]
function setup(history: typeof shortHistory){vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} });render(<MarketChart history={history}/>)}

it('keeps Dexscreener iframes while our snapshot history is still ramping up',()=>{
 setup(shortHistory)
 const frames=document.querySelectorAll('iframe')
 expect(frames).toHaveLength(2)
 expect(frames[0].getAttribute('src')).toContain('dexscreener.com')
 const links=screen.getAllByRole('link',{name:'Open chart ↗'})
 expect(links).toHaveLength(2)
 expect(links[0].getAttribute('href')).toContain('0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69')
 expect(links[1].getAttribute('href')).toContain('0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef')
 expect(screen.getByText(/our own candles take over automatically/)).toBeTruthy()
})

it('switches to our own candle panes automatically once history covers 7 days',()=>{
 setup(deepHistory)
 expect(screen.getByText('FUEL / USD')).toBeTruthy()
 expect(screen.getByText('MORE / USD')).toBeTruthy()
 const links=screen.getAllByRole('link',{name:'Open chart ↗'})
 expect(links).toHaveLength(2)
 expect(links[0].getAttribute('href')).toContain('0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69')
 expect(links[1].getAttribute('href')).toContain('0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef')
 // No third-party embeds remain once our candles take over.
 expect(document.querySelector('iframe')).toBeNull()
 expect(screen.getByText(/Our candles · aggregated/)).toBeTruthy()
})

it('offers an actual-dollar overlay and optional percentage comparison, then dollar liquidity',()=>{
 setup(shortHistory);fireEvent.click(screen.getByRole('button',{name:'Compare USD'}))
 expect(screen.getByText(/FUEL left · MORE right/)).toBeTruthy()
 expect(document.querySelector('iframe')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Change %'}))
 expect(screen.getByText(/Price change/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Liquidity'}))
 expect(screen.getByText(/Pool liquidity · USD/)).toBeTruthy()
 expect(screen.queryByRole('button',{name:'Change %'})).toBeNull()
 expect(screen.queryByRole('table')).toBeNull()
})

it('narrows the candle view to a single token',()=>{
 setup(shortHistory);fireEvent.click(screen.getByRole('button',{name:'FUEL'}))
 expect(document.querySelectorAll('iframe')).toHaveLength(1)
 expect(screen.getAllByRole('link',{name:'Open chart ↗'})).toHaveLength(1)
})
