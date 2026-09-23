import {it, afterEach, mock} from 'node:test'
import assert from 'node:assert/strict'
import {publishSnapshot} from './publish-storage.mjs'
import {TOKEN,REPORT_KEY} from './activity-edge.mjs'

// The publisher writes snapshots to D1 via the Cloudflare D1 Query API.
const env={
 CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
 CLOUDFLARE_D1_DATABASE_ID:['b'.repeat(8),'b'.repeat(4),'b'.repeat(4),'b'.repeat(4),'b'.repeat(12)].join('-'),
 CLOUDFLARE_API_TOKEN:'test-private-token',
}
const D1_QUERY_URL=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.CLOUDFLARE_D1_DATABASE_ID}/query`

function fixture(block='100') {
 const throughTimestamp=Math.floor(Date.now()/1000)-60
 const fromTimestamp=Math.floor(throughTimestamp/86400)*86400-6*86400
 return {schemaVersion:2,chainId:4663,token:TOKEN,fromBlock:'1',throughBlock:block,throughHash:'0x'+'ab'.repeat(32),fromTimestamp,throughTimestamp,generatedAt:new Date().toISOString(),index:{mode:'incremental'},maturity:{status:'unavailable'},days:Array.from({length:7},(_,i)=>({date:new Date((fromTimestamp+i*86400)*1000).toISOString().slice(0,10),mints:1,claims:0,mintWallets:1,claimWallets:0,claimedFuel:'0'}))}
}

/** Mock the global fetch used by the D1 REST layer. `plans` answers each POST in order. */
function mockD1(plans) {
 const requests=[]
 mock.method(globalThis,'fetch',async(url,options)=>{
  const plan=plans.shift() ?? {success:true,result:[{}]}
  requests.push({url,...options})
  if(plan instanceof Error) throw plan
  return Response.json({success:true,...plan})
 })
 return requests
}

afterEach(()=>mock.restoreAll())

it('publishes a complete report unchanged with secret authorization to the fixed D1 key',async()=>{
 const report=fixture()
 const requests=mockD1([
  {result:[{results:[]}]}, // SELECT finds no previous snapshot
  {result:[{}]},           // INSERT upsert confirmed
 ])
 const result=await publishSnapshot(report,env)
 assert.equal(result.throughBlock,'100')
 assert.equal(requests.length,2)
 assert.equal(requests[1].url,D1_QUERY_URL)
 assert.equal(requests[1].headers.Authorization,'Bearer test-private-token')
 const putBody=JSON.parse(requests[1].body)
 assert.ok(String(putBody.sql).startsWith('INSERT INTO snapshots'))
 assert.deepEqual(putBody.params[0],REPORT_KEY)
 assert.deepEqual(JSON.parse(putBody.params[1]),report)
})
it('rejects invalid or incomplete reports and configuration before network access',async()=>{
 for(const report of [{...fixture(),chainId:1},{...fixture(),throughHash:null},{...fixture(),days:[]},{...fixture(),throughTimestamp:1}])await assert.rejects(publishSnapshot(report,env))
 await assert.rejects(publishSnapshot(fixture(),{...env,CLOUDFLARE_ACCOUNT_ID:'../other'}))
})
it('does not overwrite a newer stored snapshot',async()=>{
 const requests=mockD1([{result:[{results:[{value:JSON.stringify(fixture('101'))}]}]}])
 await assert.rejects(publishSnapshot(fixture('100'),env),/newer/)
 assert.equal(requests.length,1)
})
it('withholds writes when reading current storage fails and redacts backend errors',async()=>{
 const requests=mockD1([new Error('test-private-token')])
 await assert.rejects(publishSnapshot(fixture(),env),error=>!error.message.includes('test-private-token'))
 assert.equal(requests.length,1)
 const requests2=mockD1([{success:false,errors:[{message:'test-private-token'}]}])
 await assert.rejects(publishSnapshot(fixture(),env),error=>!error.message.includes('test-private-token'))
 assert.equal(requests2.length,1)
})
