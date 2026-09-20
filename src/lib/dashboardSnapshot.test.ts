import { expect, it } from 'vitest'
import { decodeDashboard, encodeDashboard, mergeDashboard, SOURCE_NAMES } from './dashboardSnapshot'
import type { RadarData, ProtocolSnapshot } from './types'
import { unavailableHolders } from './types'
const keys = ['totalSupply','globalRank','activeMinters','totalStaked','activeStakes','amp','eaar','maxTermSeconds','fuelBurnt','moreBurnt','ethUsedFuelBurns','ethUsedMoreBurns','totalDistributed','vaultBalance','vaultSwept','vaultCycle','vaultCycleEnd']
function sample(at = '2026-09-19T00:00:00Z'): RadarData {
  return { sources: SOURCE_NAMES.map(name=>({name,status:'available',checkedAt:at,detail:'source'})), pairs:[], contracts:[], holders:{FUEL:{...unavailableHolders(),totalHolders:0,topHolders:[]},MORE:unavailableHolders()},activity:[],protocol:Object.fromEntries(keys.map(k=>[k,123456789123456789123456789n])) as ProtocolSnapshot,updatedAt:at,partial:false,protocolObservation:{blockNumber:'100',blockHash:'0x'+'a'.repeat(64),blockTimestamp:'1789776000'} }
}
it('round-trips exact bigint precision, empty results, and block provenance',()=>{
  const data=sample()
  expect(decodeDashboard(encodeDashboard(data))).toEqual(data)
})
it('retains complete source groups and their observation time after partial reads',()=>{
  const previous=sample(), incoming=sample('2026-09-19T00:05:00Z')
  incoming.protocol.totalSupply=3n;incoming.protocol.activeMinters=null
  incoming.sources[6].status='partial'
  incoming.holders.FUEL=unavailableHolders();incoming.sources[2].status='unavailable'
  const merged=mergeDashboard(previous,incoming)
  expect(merged.protocol).toEqual(previous.protocol)
  expect(merged.protocolObservation).toEqual(previous.protocolObservation)
  expect(merged.holders.FUEL.totalHolders).toBe(0)
  expect(merged.sources[6]).toMatchObject({retained:true,checkedAt:previous.updatedAt,attemptedAt:incoming.updatedAt,status:'partial'})
  expect(merged.sources[0].checkedAt).toBe(incoming.updatedAt)
  expect(merged.partial).toBe(true)
  expect(previous.sources[6].retained).toBeUndefined()
})
it('recovers after failure and keeps repeated failures tied to the original observation',()=>{
  const previous=sample(), failed=sample('2026-09-19T00:05:00Z');failed.sources[6].status='unavailable'
  const first=mergeDashboard(previous,failed)
  failed.updatedAt='2026-09-19T00:10:00Z'; failed.sources[6].checkedAt=failed.updatedAt
  expect(mergeDashboard(first,failed).sources[6].checkedAt).toBe(previous.updatedAt)
  expect(mergeDashboard(first,sample('2026-09-19T00:15:00Z')).sources[6].retained).toBeUndefined()
})
it('rejects malformed, wrong-chain, future, or incomplete snapshots',()=>{
  const wire=JSON.parse(encodeDashboard(sample()))
  for(const mutate of [()=>wire.chainId=1,()=>wire.data.protocol.totalSupply='NaN',()=>wire.data.updatedAt='2999-01-01',()=>wire.data.sources=[],()=>wire.data.protocol={}]) {
    const copy=JSON.stringify(wire);mutate();expect(decodeDashboard(JSON.stringify(wire))).toBeNull();Object.assign(wire,JSON.parse(copy))
  }
  expect(decodeDashboard('{broken')).toBeNull()
})
it('never rolls a saved observation back to an earlier sync',()=>{
  const previous=sample('2026-09-19T00:10:00Z')
  expect(mergeDashboard(previous,sample())).toBe(previous)
})
