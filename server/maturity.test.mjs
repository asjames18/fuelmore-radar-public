import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMaturity } from './maturity.mjs'
const start=Date.parse('2026-09-15T00:00:00Z')/1000
const mint=(id,user,at,term=7)=>({id,user,sender:'0xwallet',kind:'mint',timestamp:at,term,blockNumber:at,logIndex:Number(id)})
test('includes old active mints and deduplicates repeated logs',()=>{
 const old=mint('1','0xa',start-20*86400,30)
 const report=buildMaturity([old,old],start)
 assert.equal(report.active.length,1)
 assert.equal(report.active[0].maturityTs,start+10*86400)
})
test('orders claim and remint in one block and preserves original scheduled history',()=>{
 const opening=mint('1','0xa',start-8*86400)
 const claim={...mint('2','0xa',start),kind:'claim'}
 const remint=mint('3','0xa',start)
 const report=buildMaturity([remint,opening,claim],start)
 assert.equal(report.active.length,1)
 assert.equal(report.active[0].maturityTs,start+7*86400)
 assert.equal(report.days.find(day=>day.date==='2026-09-14').scheduled,1)
 assert.equal(report.days.find(day=>day.date==='2026-09-22').scheduled,1)
})
test('marks exact maturity as due, and excludes closed positions from future projections',()=>{
 const due=mint('1','0xa',start-86400,1)
 const closed=mint('2','0xb',start,7)
 const claim={...mint('3','0xb',start),kind:'claim'}
 const report=buildMaturity([due,closed,claim],start)
 assert.equal(report.due,1)
 assert.equal(report.days.find(day=>day.date==='2026-09-22').scheduled,0)
})
