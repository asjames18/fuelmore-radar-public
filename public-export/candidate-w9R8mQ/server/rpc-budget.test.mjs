import { it } from 'node:test'
import assert from 'node:assert/strict'
import { validateReadBudget, createRpcBudget, retryDelay } from './rpc-budget.mjs'
it('bounds log spans and rejects unbounded or malformed filters', () => {
  const logs = filter => [{method:'eth_getLogs', params:[filter]}]
  assert.equal(validateReadBudget(logs({fromBlock:'0x10',toBlock:'0x20'})), null)
  for (const filter of [{}, {fromBlock:'earliest',toBlock:'latest'}, {fromBlock:'0x0',toBlock:'0xffff'}, {fromBlock:'0x20',toBlock:'0x10'}]) assert.ok(validateReadBudget(logs(filter)))
  assert.equal(validateReadBudget(logs({blockHash:'0x'+'a'.repeat(64)})), null)
})
it('deduplicates concurrent work and releases slots after failures', async () => {
 const budget = createRpcBudget({maxConcurrent:1})
 let release, calls=0
 const job=()=>{calls++;return new Promise(resolve=>{release=resolve})}
 const a=budget.run('same',job), b=budget.run('same',job)
 await assert.rejects(budget.run('other',job), /busy/)
 release('ok')
 assert.deepEqual(await Promise.all([a,b]),['ok','ok']);assert.equal(calls,1)
 await assert.rejects(budget.run('error',async()=>{throw new Error('failed')}),/failed/)
 assert.equal(await budget.run('after',async()=>7),7)
})
it('charges batch units against each client and resets the window', () => {
 let now=0;const budget=createRpcBudget({now:()=>now,unitsPerMinute:5})
 assert.equal(budget.admit('a',4),true);assert.equal(budget.admit('a',2),false)
 assert.equal(budget.admit('b',2),true);now=60000;assert.equal(budget.admit('a',5),true)
})
it('honors Retry-After without exceeding the remaining time budget', () => {
 assert.equal(retryDelay('5',0,6000,0,()=>0),5000)
 assert.equal(retryDelay('60',0,6000,0,()=>0),null)
 assert.equal(retryDelay(null,1,6000,0,()=>0),600)
})
it('does not retain a completed synchronous failure as pending work', async () => {
 const budget=createRpcBudget()
 await assert.rejects(budget.run('key',()=>{throw new Error('failed')}),/failed/)
 assert.equal(await budget.run('key',async()=>42),42)
})
