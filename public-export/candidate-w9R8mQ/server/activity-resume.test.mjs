import {it,mock} from 'node:test'
import assert from 'node:assert/strict'
import {toFunctionSelector} from 'viem'
import {collectActivity,TOKEN} from './activity.mjs'
const hash=n=>'0x'+BigInt(n).toString(16).padStart(64,'0')
const checkpoint={schemaVersion:1,chainId:4663,token:TOKEN,genesisTs:1,fromBlock:'100',throughBlock:'109',throughHash:hash(109),throughTimestamp:109,blockHashes:{'109':hash(109)},records:[]}
it('persists validated partial scan progress and resumes without publishing an incomplete report',async()=>{
 const before={rpc:process.env.RPC_URL,range:process.env.RPC_LOG_RANGE}
 process.env.RPC_URL='https://resume.test';process.env.RPC_LOG_RANGE='10'
 let changed=false,endReads=0
 const ranges=[]
 const transport=mock.method(globalThis,'fetch',async(url,options)=>{
  const req=await (url instanceof Request?url:new Request(url,options)).json()
  let result
  if(req.method==='eth_chainId')result='0x1237'
  else if(req.method==='eth_blockNumber')result='0x4d2'
  else if(req.method==='eth_getBlockByNumber')result={number:req.params[0],hash:hash(BigInt(req.params[0])+(changed && req.params[0]==='0x492' && ++endReads>1?1n:0n)),timestamp:req.params[0],transactions:[]}
  else if(req.method==='eth_call')result='0x'+(req.params[0].data===toFunctionSelector('genesisTs()')?'1':'0').padStart(64,'0')
  else if(req.method==='eth_getLogs'){ranges.push([BigInt(req.params[0].fromBlock),BigInt(req.params[0].toBlock)]);result=[]}
  else assert.fail(req.method)
  return Response.json({jsonrpc:'2.0',id:req.id,result})
 })
 try {
  let saved
  await assert.rejects(collectActivity(()=>{},checkpoint,{onCheckpoint:async index=>{saved=index;throw new Error('simulated stop')}}),/simulated stop/)
  assert.equal(saved.throughBlock,'1109')
  assert.equal(saved.throughHash,hash(1109))
  assert.ok(ranges.every(([from,to])=>to-from<10n))
  ranges.length=0
  const {report,index}=await collectActivity(()=>{},saved)
  assert.equal(ranges[0][0],1110n)
  assert.equal(index.throughBlock,'1170')
  assert.equal(report.throughBlock,'1170')
  assert.equal(report.throughHash,hash(1170))
  assert.equal(report.maturity.status,'ready')
  changed=true
  await assert.rejects(collectActivity(()=>{},checkpoint,{onCheckpoint:()=>assert.fail('unsafe checkpoint')}),/checkpoint withheld/)
 }finally{
  transport.mock.restore()
  for(const [name,value] of [['RPC_URL',before.rpc],['RPC_LOG_RANGE',before.range]])if(value===undefined)delete process.env[name];else process.env[name]=value
 }
})
it('aborts an in-flight provider read when the total run deadline expires',async()=>{
 let aborted=false
 const transport=mock.method(globalThis,'fetch',async(input,init)=>{
  const signal=init.signal
  await new Promise((resolve,reject)=>{
   if(signal.aborted){aborted=true;reject(signal.reason);return}
   signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true})
  })
 })
 try {
  await assert.rejects(collectActivity(()=>{},null,{maxRunMs:20,onCheckpoint:()=>assert.fail('incomplete checkpoint')}))
  assert.equal(aborted,true)
 }finally{transport.mock.restore()}
})
