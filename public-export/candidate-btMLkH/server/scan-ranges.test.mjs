import { it } from 'node:test'
import assert from 'node:assert/strict'
import { scanRanges } from './scan-ranges.mjs'

it('reads bounded ranges concurrently and commits only contiguous completed groups', async () => {
  let active=0,max=0
  const seen=[],committed=[]
  await scanRanges({from:1n,to:45n,range:10n,concurrency:2,groupSize:3,
    read:async (from,to)=>{seen.push([from,to]);max=Math.max(max,++active);await new Promise(resolve=>setTimeout(resolve,1));active--;return [String(from)]},
    commit:async batch=>committed.push(batch)})
  assert.deepEqual(seen,[[1n,10n],[11n,20n],[21n,30n],[31n,40n],[41n,45n]])
  assert.equal(max,2)
  assert.deepEqual(committed,[{from:1n,to:30n,logs:['1','11','21']},{from:31n,to:45n,logs:['31','41']}])
})
it('retains the last complete group and never commits over a failed range', async () => {
  const committed=[]
  await assert.rejects(scanRanges({from:1n,to:60n,range:10n,concurrency:2,groupSize:2,
    read:async from=>{if(from===31n)throw new Error('outage');return [String(from)]},
    commit:async batch=>committed.push(batch.to)}),/outage/)
  assert.deepEqual(committed,[20n])
})
it('stops before starting another group when its run budget expires', async () => {
  let time=0
  const committed=[]
  await assert.rejects(scanRanges({from:1n,to:60n,range:10n,groupSize:2,deadline:10,now:()=>time,
    read:async()=>[],commit:async batch=>{committed.push(batch.to);time=11}}),/run budget/)
  assert.deepEqual(committed,[20n])
})
it('rejects invalid scheduling inputs before any network operation',async()=>{
 for(const options of [{range:0n},{concurrency:0},{groupSize:0}]) {
  await assert.rejects(scanRanges({from:1n,to:10n,range:10n,...options,read:()=>assert.fail('network'),commit:()=>{}}),/Invalid scan/)
 }
})
it('stops scheduling inside a group at deadline and withholds that group',async()=>{
 let time=0,reads=0
 await assert.rejects(scanRanges({from:1n,to:1000n,range:10n,concurrency:1,deadline:10,now:()=>time,
  read:async()=>{reads++;time=20;return []},commit:()=>assert.fail('expired group')}),/run budget/)
 assert.equal(reads,1)
})
