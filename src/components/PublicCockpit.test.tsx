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

it('labels a cancelled scan as cancelled and allows another read', async () => { vi.spyOn(cockpitApi,'fetchCockpitSnapshot').mockImplementation((_wallet,_progress,options) => new Promise((_resolve,reject)=> {
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

it('shares the saved-wallet watchlist: one-click load and remove', async () => {
 const wallet = '0x0000000000000000000000000000000000000001'
 localStorage.setItem('fuelmore-radar:watchlist:v1', JSON.stringify([wallet]))
 const snapshot = {
  address: wallet, slots: [], observedAt: 1_700_000_000, blockNumber: 1n, blockHash: '0xabc',
  buckets: [], activeMints: 0, dueOrLate: 0, nextMaturityTs: null, maxLatePenaltyPct: 0,
  fuelBalance: null, batchTotal: null, sampleIncomplete: false, globalRank: null,
  slotsPinnedBlockNumber: 1n, slotsPinnedBlockHash: '0xabc',
 }
 const smart = vi.spyOn(cockpitApi, 'fetchCockpitSnapshotSmart').mockResolvedValue({ snapshot: snapshot as never, source: 'server' })
 const data = { pairs: [], holders: {}, contracts: [], partial: false } as unknown as RadarData
 render(<PublicCockpit data={data}/>)
 const saved = screen.getByTitle(wallet)
 expect(saved.textContent).toMatch(/0x0000/)
 fireEvent.click(saved)
 expect(smart).toHaveBeenCalledWith(wallet, expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }))
 expect(await screen.findByText(/Active mints/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: /Remove saved wallet/ }))
 expect(screen.queryByTitle(wallet)).toBeNull()
 expect(JSON.parse(localStorage.getItem('fuelmore-radar:watchlist:v1') ?? '[]')).toEqual([])
 localStorage.clear()
})

it('saves the entered wallet to the shared watchlist', () => {
 const wallet = '0x0000000000000000000000000000000000000002'
 const data = { pairs: [], holders: {}, contracts: [], partial: false } as unknown as RadarData
 render(<PublicCockpit data={data}/>)
 fireEvent.change(screen.getByLabelText('Wallet'), { target: { value: wallet } })
 fireEvent.click(screen.getByRole('button', { name: 'Save entered wallet' }))
 expect(screen.getByTitle(wallet)).toBeTruthy()
 expect(screen.getByText(/Watchlist saved in this browser/)).toBeTruthy()
 expect(JSON.parse(localStorage.getItem('fuelmore-radar:watchlist:v1') ?? '[]')).toEqual([wallet])
 localStorage.clear()
})
