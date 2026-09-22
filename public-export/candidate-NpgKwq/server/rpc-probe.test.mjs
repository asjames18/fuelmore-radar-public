import { it } from 'node:test'
import assert from 'node:assert/strict'
import { probeRpc } from '../scripts/check-rpc.mjs'
const hash = '0x'+'ab'.repeat(32)
const oldHash = '0x'+'cd'.repeat(32)
function fixture({chain='0x1237', archive=true, mismatch=false, logs=[]}={}) {
 let pinnedReads=0
 return async (method, params) => {
   if (method === 'eth_chainId') return chain
   if (method === 'eth_blockNumber') return '0x1000'
   if (method === 'eth_getBlockByNumber') return {number:params[0], hash: params[0]==='0x20' ? oldHash : mismatch && ++pinnedReads>1 ? oldHash : hash}
   if (method === 'eth_call') { if (!archive && params[1]==='0x20') throw new Error('history absent'); return '0x'+'0'.repeat(63)+'1' }
   if (method === 'eth_getLogs') return logs
   throw new Error('unexpected method')
 }
}
it('rejects another chain before historical reads', async () => { await assert.rejects(probeRpc(fixture({chain:'0x1'}),32n), /Unexpected RPC network/) })
it('checks historical calls and hash consistency', async () => { assert.deepEqual(await probeRpc(fixture(),32n),{chainId:4663, blockNumber:'4032', historicalBlock:'32', historicalRead:true, historicalLogs:true, consistent:true}) })
it('does not call chain-ID success proof of archive support', async () => { await assert.rejects(probeRpc(fixture({archive:false}),32n), /history absent/) })
it('rejects a snapshot whose block hash changes', async () => { await assert.rejects(probeRpc(fixture({mismatch:true}),32n), /Snapshot changed/) })
it('rejects malformed log responses rather than recording capability success', async () => { await assert.rejects(probeRpc(fixture({logs:null}),32n), /Invalid historical logs/) })

it('measures batch support and reports rejected log ranges without claiming support', async () => {
  const { probeWorkload } = await import('../scripts/check-rpc.mjs')
  const read = async (method, params) => {
    if (method === 'eth_call') return '0x'+'0'.repeat(63)+'1'
    if (method === 'eth_getBlockByNumber') return {number:'0x100000',hash}
    if (method === 'eth_getLogs') {
      if (BigInt(params[0].toBlock)-BigInt(params[0].fromBlock)>=10n) throw new Error('provider limit')
      return []
    }
  }
  const result=await probeWorkload(read,async requests=>requests.map(()=> '0x'+'0'.repeat(63)+'1'),1048576n)
  assert.equal(result.batchReads,6)
  assert.deepEqual(result.logRanges.map(({blocks,supported})=>({blocks,supported})),[{blocks:10,supported:true},{blocks:2000,supported:false},{blocks:50000,supported:false}])
  assert.ok(result.logRanges.every(x=>Number.isFinite(x.elapsedMs)))
})
it('rejects incomplete batch results and changes to the workload snapshot', async () => {
  const { probeWorkload } = await import('../scripts/check-rpc.mjs')
  const word='0x'+'0'.repeat(63)+'1'
  const read=async method=>method==='eth_call'?word:method==='eth_getLogs'?[]:{number:'0x100000',hash}
  await assert.rejects(probeWorkload(read,async()=>[word],1048576n),/Invalid batch/)
  let reads=0
  const changing=async (method,params)=>method==='eth_getBlockByNumber'?{number:'0x100000',hash:++reads===1?hash:oldHash}:read(method,params)
  await assert.rejects(probeWorkload(changing,async()=>Array(6).fill(word),1048576n),/Snapshot changed/)
})

it('runs the RPC setup check in a clean checkout without a collected activity report', async () => {
  const { mkdtemp, realpath, mkdir, cp, writeFile, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { spawnSync } = await import('node:child_process')
  const root=fileURLToPath(new URL('..',import.meta.url))
  const dir=await realpath(await mkdtemp(join(tmpdir(),'radar-rpc-clean-')))
  try {
    await mkdir(join(dir,'scripts'))
    await cp(join(root,'scripts/check-rpc.mjs'),join(dir,'scripts/check-rpc.mjs'))
    await cp(join(root,'server'),join(dir,'server'),{recursive:true})
    await symlink(join(root,'node_modules'),join(dir,'node_modules'))
    await writeFile(join(dir,'rpc-fixture.mjs'), `
      globalThis.fetch=async (_url,options)=>{
        const body=JSON.parse(options.body)
        const reply=request=>{
          const {method,params}=request
          let result
          if(method==='eth_chainId')result='0x1237'
          else if(method==='eth_blockNumber')result='0x5000000'
          else if(method==='eth_getBlockByNumber')result={number:params[0],hash:'0x'+'ab'.repeat(32)}
          else if(method==='eth_call')result='0x'+'0'.repeat(63)+'1'
          else if(method==='eth_getLogs')result=[]
          else throw Error('Unexpected RPC method')
          return {jsonrpc:'2.0',id:request.id,result}
        }
        return Response.json(Array.isArray(body)?body.map(reply):reply(body))
      }
    `)
    const result=spawnSync(process.execPath,['--import',join(dir,'rpc-fixture.mjs'),join(dir,'scripts/check-rpc.mjs')],{cwd:dir,env:{...process.env,RPC_URL:'https://rpc.example.invalid'},encoding:'utf8'})
    assert.equal(result.status,0,result.stderr)
    const report=JSON.parse(result.stdout)
    assert.equal(report.chainId,4663)
    assert.equal(report.historicalBlock,'63139884')
    assert.equal(report.historicalRead,true)
  } finally { await rm(dir,{recursive:true,force:true}) }
})
