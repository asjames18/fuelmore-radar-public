import {it} from 'node:test'
import assert from 'node:assert/strict'
import {publishSnapshot} from './publish-storage.mjs'
import {TOKEN,REPORT_KEY} from './activity-edge.mjs'
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_KV_NAMESPACE_ID:'b'.repeat(32),CLOUDFLARE_API_TOKEN:'test-private-token'}
function fixture(block='100') {
 const throughTimestamp=Math.floor(Date.now()/1000)-60
 const fromTimestamp=Math.floor(throughTimestamp/86400)*86400-6*86400
 return {schemaVersion:2,chainId:4663,token:TOKEN,fromBlock:'1',throughBlock:block,throughHash:'0x'+'ab'.repeat(32),fromTimestamp,throughTimestamp,generatedAt:new Date().toISOString(),index:{mode:'incremental'},maturity:{status:'unavailable'},days:Array.from({length:7},(_,i)=>({date:new Date((fromTimestamp+i*86400)*1000).toISOString().slice(0,10),mints:1,claims:0,mintWallets:1,claimWallets:0,claimedFuel:'0'}))}
}
it('publishes a complete report unchanged with secret authorization to one fixed KV key',async()=>{
 const requests=[],report=fixture()
 const result=await publishSnapshot(report,env,async(url,options)=>{requests.push({url,...options});return options.method==='GET'?new Response('',{status:404}):Response.json({success:true})})
 assert.equal(result.throughBlock,'100')
 assert.equal(requests.length,2)
 assert.equal(requests[1].url,`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.CLOUDFLARE_KV_NAMESPACE_ID}/values/${REPORT_KEY}`)
 assert.equal(requests[1].headers.Authorization,'Bearer test-private-token')
 assert.deepEqual(JSON.parse(requests[1].body),report)
})
it('rejects invalid or incomplete reports and configuration before network access',async()=>{
 for(const report of [{...fixture(),chainId:1},{...fixture(),throughHash:null},{...fixture(),days:[]},{...fixture(),throughTimestamp:1}])await assert.rejects(publishSnapshot(report,env,()=>assert.fail('network')))
 await assert.rejects(publishSnapshot(fixture(),{...env,CLOUDFLARE_ACCOUNT_ID:'../other'},()=>assert.fail('network')))
})
it('does not overwrite a newer stored snapshot',async()=>{
 let requests=0
 await assert.rejects(publishSnapshot(fixture('100'),env,async()=>{requests++;return Response.json(fixture('101'))}),/newer/)
 assert.equal(requests,1)
})
it('withholds writes when reading current storage fails and redacts backend errors',async()=>{
 let requests=0
 await assert.rejects(publishSnapshot(fixture(),env,async()=>{requests++;throw new Error('test-private-token')}),error=>!error.message.includes('test-private-token'))
 assert.equal(requests,1)
 await assert.rejects(publishSnapshot(fixture(),env,async(url,{method})=>method==='GET'?new Response('',{status:404}):Response.json({success:false,errors:[{message:'test-private-token'}]})),error=>!error.message.includes('test-private-token'))
})
