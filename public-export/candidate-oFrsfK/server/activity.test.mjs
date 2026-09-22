import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateActivity, readLogRange } from './activity.mjs'
const start = Date.parse('2026-09-14T00:00:00Z') / 1000
const event = (id, kind='mint', sender='0xabc', timestamp=start) => ({id, kind, sender, timestamp, amount:'1000000000000000001'})
test('batch events count positions, while wallets are unique per day and action', () => {
  const result = aggregateActivity([event('1'),event('2'),event('2'),event('3','claim','0xAbC')],start,start+86400)
  assert.equal(result[0].mints,2)
  assert.equal(result[0].mintWallets,1)
  assert.equal(result[0].claimWallets,1)
  assert.equal(result[0].claimedFuel,'1.000000000000000001')
  assert.equal(result[1].claims,0)
})
test('UTC midnight separates days and excludes out-of-range events', () => {
  const days=aggregateActivity([event('1','mint','0xa',start-1),event('2','mint','0xa',start+86399),event('3','mint','0xa',start+86400)],start,start+86400)
  assert.deepEqual(days.map(d=>d.mints),[1,1])
})
test('claim amounts preserve precision and all empty days are present', () => {
  const days=aggregateActivity([event('1','claim'),event('2','claim')],start,start+2*86400)
  assert.equal(days[0].claimedFuel,'2.000000000000000002')
  assert.equal(days.length,3)
  assert.equal(days[2].mintWallets,0)
})

test('splits provider-limited ranges without gaps or duplicates', async () => {
  const result=await readLogRange(async (from,to)=>{
    if(to-from>1n) throw new Error('logs matched by query exceeds limit of 10000')
    return Array.from({length:Number(to-from+1n)},(_,i)=>Number(from)+i)
  },0n,8n)
  assert.deepEqual(result,[0,1,2,3,4,5,6,7,8])
})
test('does not swallow unavailable-source errors as empty logs', async () => {
  await assert.rejects(readLogRange(async()=>{throw new Error('offline')},0n,2n),/offline/)
})
