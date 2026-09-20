// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
vi.mock('./useRadarData', () => ({useRadarData:()=>({data:null,history:[],status:'loading',error:null,refresh:vi.fn()})}))
afterEach(cleanup)
it('public planner is marked coming soon without unverified calculator inputs', () => {
 render(<App/> )
 fireEvent.click(screen.getAllByRole('button',{name:'Planner'})[0])
 expect(screen.getByText(/Coming soon/)).toBeTruthy()
 expect(screen.queryByLabelText('Batch size')).toBeNull()
})
it('keeps public sync automatic with only a timestamp and cadence', () => {
 render(<App/>)
 expect(screen.getByText(/Last sync:/)).toBeTruthy()
 expect(screen.getByText('Updates every 15 minutes')).toBeTruthy()
 expect(screen.queryByRole('button',{name:'Refresh'})).toBeNull()
 expect(screen.queryByText('SYNCING')).toBeNull()
 expect(screen.queryByText(/Saved data timestamps/)).toBeNull()
})
