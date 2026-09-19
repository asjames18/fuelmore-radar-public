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
