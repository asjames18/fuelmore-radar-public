// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MarketChart } from './MarketChart'
afterEach(() => {cleanup();vi.unstubAllGlobals()})
it('lets MORE use its own scale and exposes exact observations including missing values', () => {
 vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
 render(<MarketChart history={[
  {at:100000,fuelPrice:0.01,morePrice:0.00003,fuelLiquidity:1000,moreLiquidity:100},
  {at:130000,fuelPrice:0.01,morePrice:null,fuelLiquidity:1000,moreLiquidity:null},
  {at:160000,fuelPrice:0.01,morePrice:0.00004,fuelLiquidity:1000,moreLiquidity:100},
 ]}/> )
 fireEvent.click(screen.getByRole('button',{name:'MORE'}))
 expect(screen.getByRole('button',{name:'MORE'}).getAttribute('aria-pressed')).toBe('true')
 expect(screen.getByRole('table',{name:/MORE.*observations/})).toBeTruthy()
 expect(screen.getByText('$0.00003')).toBeTruthy()
 expect(screen.getByText('Unavailable')).toBeTruthy()
})
it('defaults to both tokens and switches the comparison to dollar liquidity',()=>{
 vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
 render(<MarketChart history={[{at:100000,fuelPrice:0.01,morePrice:0.00003,fuelLiquidity:1000,moreLiquidity:100}]}/>)
 expect(screen.getByRole('button',{name:'Compare'}).getAttribute('aria-pressed')).toBe('true')
 expect(screen.getByText(/Price change \(%\)/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Liquidity'}))
 expect(screen.getByText(/Pool liquidity · USD/)).toBeTruthy()
 expect(screen.getByRole('columnheader',{name:'FUEL liquidity (USD)'})).toBeTruthy()
 expect(screen.getByRole('columnheader',{name:'MORE liquidity (USD)'})).toBeTruthy()
})
