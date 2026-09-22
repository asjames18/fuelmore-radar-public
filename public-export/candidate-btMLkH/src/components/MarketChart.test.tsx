// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MarketChart } from './MarketChart'
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
