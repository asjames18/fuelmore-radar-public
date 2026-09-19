// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { PublicCockpit } from './PublicCockpit'
import * as cockpitApi from '../lib/cockpit'
import type { RadarData } from '../lib/types'
afterEach(() => {cleanup();vi.restoreAllMocks()})
it('starts with an empty wallet and no personal decision panels or RPC reads', () => {
 const fetch = vi.spyOn(globalThis,'fetch')
 const data = {pairs:[], holders:{}, contracts:[], partial:false} as unknown as RadarData
 render(<PublicCockpit data={data}/> )
 expect((screen.getByLabelText('Wallet') as HTMLInputElement).value).toBe('')
 expect(screen.queryByText(/Pinned Owner Wallet|Risk war|Direction signals|Action bias|Where the numbers come from/)).toBeNull()
 expect(screen.getByText(/Enter a wallet/)).toBeTruthy()
 expect(screen.queryByRole('link', { name: 'Open wallet on Blockscout' })).toBeNull()
 expect(fetch).not.toHaveBeenCalled()
 fetch.mockRestore()
})

it('labels a cancelled scan as cancelled and allows another read', async () => {
 vi.spyOn(cockpitApi,'fetchCockpitSnapshot').mockImplementation((_wallet,_progress,options) => new Promise((_resolve,reject)=> {
  options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})
 }))
 const data={pairs:[],holders:{},contracts:[],partial:false} as unknown as RadarData
 render(<PublicCockpit data={data}/>)
 fireEvent.change(screen.getByLabelText('Wallet'),{target:{value:'0x0000000000000000000000000000000000000000'}})
 fireEvent.click(screen.getByRole('button',{name:'Load'}))
 fireEvent.click(await screen.findByRole('button',{name:'Cancel reading'}))
 expect(await screen.findByText(/Reading cancelled/)).toBeTruthy()
 expect((screen.getByRole('button',{name:'Load'}) as HTMLButtonElement).disabled).toBe(false)
 expect(screen.queryByText(/Unable to refresh/)).toBeNull()
})
