// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useRadarData } from './useRadarData'
import { fetchRadarData } from './lib/api'
import { encodeDashboard, SOURCE_NAMES } from './lib/dashboardSnapshot'
import { storageKey } from './lib/storage'
import { unavailableHolders, type RadarData, type ProtocolSnapshot } from './lib/types'
vi.mock('./lib/api',()=>({fetchRadarData:vi.fn()}))
const data=():RadarData=>({updatedAt:new Date().toISOString(),partial:false,pairs:[],contracts:[],activity:[],holders:{FUEL:unavailableHolders(),MORE:unavailableHolders()},sources:SOURCE_NAMES.map(name=>({name,status:'available',checkedAt:new Date().toISOString(),detail:''})),protocol:Object.fromEntries(['totalSupply','moreTotalSupply','globalRank','activeMinters','totalStaked','activeStakes','amp','eaar','maxTermSeconds','fuelBurnt','moreBurnt','ethUsedFuelBurns','ethUsedMoreBurns','totalDistributed','vaultBalance','vaultSwept','vaultCycle','vaultCycleEnd'].map(k=>[k,999n])) as ProtocolSnapshot})
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks()})
it('renders stored data immediately and retains it on failed refresh',async()=>{
 const previous=data();localStorage.setItem(storageKey('dashboard'),encodeDashboard(previous))
 vi.mocked(fetchRadarData).mockRejectedValue(new Error('offline'))
 const {result}=renderHook(()=>useRadarData())
 expect(result.current.data?.protocol.totalSupply).toBe(999n)
 await waitFor(()=>expect(result.current.error).toBe('offline'))
 expect(result.current.data?.updatedAt).toBe(previous.updatedAt)
 expect(result.current.status).toBe('stale')
})
it('a storage write failure cannot hide a successful refresh',async()=>{
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota')})
 vi.mocked(fetchRadarData).mockResolvedValue(data())
 const {result}=renderHook(()=>useRadarData())
 await waitFor(()=>expect(result.current.data?.protocol.totalSupply).toBe(999n))
 expect(result.current.error).toBeNull()
})
