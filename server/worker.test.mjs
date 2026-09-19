import { it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import worker from './worker.mjs'
const env = { ASSETS: { fetch: async () => new Response('<html>SPA</html>') } }
const ctx = { waitUntil() {} }
const request = body => new Request('https://radar.test/rpc', { method: 'POST', body: JSON.stringify(body) })
afterEach(() => mock.restoreAll())
it('does not return SPA HTML for unsupported RPC or API routes', async () => {
  assert.equal((await worker.fetch(new Request('https://radar.test/rpc'), env, ctx)).status, 405)
  assert.equal((await worker.fetch(new Request('https://radar.test/api/unknown'), env, ctx)).status, 404)
})
it('rejects empty or malformed batches before upstream requests', async () => {
  let called = false; mock.method(globalThis, 'fetch', async () => { called = true; return Response.json([]) })
  const response = await worker.fetch(request([]), env, ctx)
  assert.equal((await response.json()).error.code, -32600)
  assert.equal(called, false)
})
it('returns each batch ID when denying a mixed read/write batch', async () => {
  let called = false; mock.method(globalThis, 'fetch', async () => { called = true; return Response.json([]) })
  const response = await worker.fetch(request([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: ['0x'] }]), env, ctx)
  const body = await response.json()
  assert.deepEqual(body.map(item => item.id), [1,2])
  assert.ok(body.every(item => item.error))
  assert.equal(called, false)
})
it('drops upstream encoding and length headers after reading the response body', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('{"jsonrpc":"2.0","id":33,"result":"0x1"}', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '900', 'Content-Type': 'application/json' } }))
  const response = await worker.fetch(request({ jsonrpc: '2.0', id: 33, method: 'eth_getBalance', params: ['0x123','latest'] }), env, ctx)
  assert.equal(response.headers.get('Content-Encoding'), null)
  assert.equal(response.headers.get('Content-Length'), null)
  assert.equal((await response.json()).result, '0x1')
})
it('preserves caller ID on cached read results', async () => {
  let calls = 0; mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ jsonrpc: '2.0', id: 201, result: '0x1237' }) })
  const first = await worker.fetch(request({ jsonrpc: '2.0', id: 201, method: 'eth_chainId' }), env, ctx)
  assert.equal((await first.json()).id, 201)
  const second = await worker.fetch(request({ jsonrpc: '2.0', id: 202, method: 'eth_chainId' }), env, ctx)
  assert.equal((await second.json()).id, 202); assert.equal(calls, 1)
})
it('uses the configured upstream without leaking transport credentials', async () => {
  const endpoint = 'https://provider.test/v2/test-secret'
  let observed
  mock.method(globalThis, 'fetch', async url => { observed = url; throw new Error('Failed at ' + endpoint) })
  const response = await worker.fetch(request({ jsonrpc: '2.0', id: 910, method: 'eth_getBalance', params: ['0x123','latest'] }), { ...env, RPC_URL: endpoint }, ctx)
  assert.equal(observed, endpoint)
  assert.equal(response.status, 502)
  assert.equal((await response.text()).includes('test-secret'), false)
})
it('does not reuse another providers latest cache', async () => {
  mock.method(globalThis, 'fetch', async url => Response.json({jsonrpc:'2.0', id:1, result: String(url).includes('first') ? '0x1' : '0x2'}))
  const req = () => request({jsonrpc:'2.0', id:1, method:'eth_blockNumber'})
  assert.equal((await (await worker.fetch(req(), {...env, RPC_URL:'https://first.test'}, ctx)).json()).result, '0x1')
  assert.equal((await (await worker.fetch(req(), {...env, RPC_URL:'https://second.test'}, ctx)).json()).result, '0x2')
})
it('redacts upstream HTTP and JSON-RPC errors that echo secret endpoints', async () => {
  for (const status of [200, 500]) {
    mock.method(globalThis, 'fetch', async () => Response.json({jsonrpc:'2.0', id:33, error:{code:-32000,message:'https://provider.test/secret-token',data:'secret-token'}}, {status}))
    const response = await worker.fetch(request({jsonrpc:'2.0', id:33, method:'eth_getBalance', params:['0x123','latest']}), {...env, RPC_URL:'https://provider.test/secret-token'}, ctx)
    const text = await response.text()
    assert.equal(text.includes('secret-token'), false)
    assert.equal(JSON.parse(text).id,33)
  }
})
it('does not forward an upstream reason phrase containing credentials', async () => {
 mock.method(globalThis,'fetch',async () => Response.json({jsonrpc:'2.0',id:1,error:{code:-32000,message:'failed'}},{status:500,statusText:'https://provider.test/secret-token'}))
 const response = await worker.fetch(request({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:['0x123','latest']}),env,ctx)
 assert.equal(response.statusText.includes('secret-token'),false)
})
it('rejects oversized payloads and wide log scans before sending upstream', async () => {
 let calls=0;mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({})})
 const oversized=await worker.fetch(new Request('https://radar.test/rpc',{method:'POST',body:' '.repeat(65537)}),env,ctx)
 assert.equal(oversized.status,413)
 const wide=await worker.fetch(request({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{fromBlock:'0x0',toBlock:'0xffff'}]}),env,ctx)
 assert.equal(wide.status,400);assert.equal(calls,0)
})
it('coalesces simultaneous reads and preserves each caller ID', async () => {
 let calls=0,release
 mock.method(globalThis,'fetch',async()=>{calls++;await new Promise(resolve=>{release=resolve});return Response.json({jsonrpc:'2.0',id:701,result:'0xbeef'})})
 const uniqueEnv={...env,RPC_URL:'https://coalesce.test'}
 const read=id=>worker.fetch(request({jsonrpc:'2.0',id,method:'eth_call',params:[{to:'0x123'},'0x100']}),uniqueEnv,ctx)
 const a=read(701),b=read(702)
 while(!release)await new Promise(resolve=>setImmediate(resolve))
 release()
 const results=await Promise.all([a,b])
 assert.deepEqual(await Promise.all(results.map(r=>r.json().then(x=>x.id))),[701,702]);assert.equal(calls,1)
})
it('rejects mismatched upstream IDs without caching the response', async () => {
 let calls=0
 mock.method(globalThis,'fetch',async (_url,options)=>{calls++;const input=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:calls===1?999:input.id,result:'0xabcd'})})
 const configured={...env,RPC_URL:'https://correlation.test'}
 const read=id=>worker.fetch(request({jsonrpc:'2.0',id,method:'eth_call',params:[{to:'0x123'},'0x20']}),configured,ctx)
 assert.equal((await read(101)).status,502)
 const valid=await read(102)
 assert.equal((await valid.json()).id,102);assert.equal(calls,2)
})
it('rejects missing, duplicate and unrelated batch response IDs', async () => {
 const input=[1,2].map(id=>({jsonrpc:'2.0',id,method:'eth_getBalance',params:['0x123','latest']}))
 for(const ids of [[1],[1,1],[1,3],['1',2]]) {
  mock.method(globalThis,'fetch',async()=>Response.json(ids.map(id=>({jsonrpc:'2.0',id,result:'0x0'}))))
  assert.equal((await worker.fetch(request(input),env,ctx)).status,502)
 }
 mock.method(globalThis,'fetch',async()=>Response.json([2,1].map(id=>({jsonrpc:'2.0',id,result:'0x0'}))))
 assert.equal((await worker.fetch(request(input),env,ctx)).status,200)
})
it('does not expose a public activity storage mutation endpoint',async()=>{
 let writes=0
 const response=await worker.fetch(new Request('https://radar.test/api/fuel-activity/refresh',{method:'POST'}),{ACTIVITY:{get:async()=>null,put:async()=>{writes++}},ASSETS:{fetch:async()=>new Response('',{status:404})}})
 assert.equal(response.status,404)
 assert.equal(writes,0)
})
