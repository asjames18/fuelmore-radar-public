import { it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import worker, { recordMinterCollectorFailure } from './worker.mjs'
const env = { RPC_RATE_LIMITER: { limit: async () => ({success:true}) }, ASSETS: { fetch: async () => new Response('<html>SPA</html>') } }
const ctx = { waitUntil() {} }
const request = body => new Request('https://radar.test/rpc', { method: 'POST', headers: {'CF-Connecting-IP':'192.0.2.1'}, body: JSON.stringify(body) })
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

it('denies a platform-limited batch before fetching upstream and charges each logical read', async () => {
  let upstream=0,admissions=0
  const keys=[]
  mock.method(globalThis,'fetch',async()=>{upstream++;return Response.json([{jsonrpc:'2.0',id:1,result:'0x1'},{jsonrpc:'2.0',id:2,result:'0x2'}])})
  const limited={...env,RPC_RATE_LIMITER:{limit:async({key})=>{keys.push(key);return {success:++admissions<2}}}}
  const response=await worker.fetch(request([{jsonrpc:'2.0',id:1,method:'eth_getBalance',params:['0x1','latest']},{jsonrpc:'2.0',id:2,method:'eth_getBalance',params:['0x2','latest']}]),limited)
  assert.equal(response.status,429)
  assert.equal(response.headers.get('Retry-After'),'60')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*')
  assert.equal(admissions,2);assert.equal(keys[0],'radar-rpc:192.0.2.1');assert.equal(keys[0],keys[1]);assert.equal(upstream,0)
})
it('fails closed when platform protection or a trusted client address is missing', async () => {
  let upstream=0;mock.method(globalThis,'fetch',async()=>{upstream++;return Response.json({jsonrpc:'2.0',id:41,result:'0x1'})})
  const body={jsonrpc:'2.0',id:41,method:'eth_getBalance',params:['0x1','latest']}
  const missing=await worker.fetch(request(body),{...env,RPC_RATE_LIMITER:undefined})
  const unidentified=await worker.fetch(new Request('https://radar.test/rpc',{method:'POST',body:JSON.stringify(body)}),env)
  assert.equal(missing.status,503);assert.equal(unidentified.status,503);assert.equal(upstream,0)
})
it('redacts platform failures and refuses malformed limiter results', async () => {
  const body={jsonrpc:'2.0',id:42,method:'eth_getBalance',params:['0x1','latest']}
  let upstream=0;mock.method(globalThis,'fetch',async()=>{upstream++;return Response.json({jsonrpc:'2.0',id:42,result:'0x1'})})
  for(const limit of [async()=>{throw Error('sensitive diagnostics')},async()=>({}),async()=>({success:'true'})]) {
    const response=await worker.fetch(request(body),{...env,RPC_RATE_LIMITER:{limit}})
    assert.equal(response.status,503)
    assert.equal((await response.text()).includes('sensitive diagnostics'),false)
    assert.equal(upstream,0)
  }
})
it('checks the platform limit before returning a previously cached RPC value', async () => {
  const body={jsonrpc:'2.0',id:43,method:'eth_chainId'}
  const isolated={...env,RPC_URL:'https://cache-platform.test'}
  mock.method(globalThis,'fetch',async()=>Response.json({jsonrpc:'2.0',id:43,result:'0x1237'}))
  assert.equal((await worker.fetch(request(body),isolated)).status,200)
  const limited=await worker.fetch(request({...body,id:44}),{...isolated,RPC_RATE_LIMITER:{limit:async()=>({success:false})}})
  assert.equal(limited.status,429)
})
it('serves the saved shared dashboard without any upstream fetch', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch upstream') })
  const body = JSON.stringify({version:1,chainId:4663,data:{updatedAt:'2026-09-20T00:00:00Z'}})
  const response = await worker.fetch(new Request('https://radar.test/api/dashboard'), {...env,ACTIVITY:{get:async key=>key==='dashboard-snapshot-v1'?body:null}},ctx)
  assert.equal(await response.text(),body)
  assert.equal(response.headers.get('Cache-Control'),'public, max-age=30')
})
it('does not invent dashboard data when storage is empty or unavailable', async () => {
  for (const store of [{get:async()=>null},{get:async()=>{throw new Error('offline')}}]) {
    const response = await worker.fetch(new Request('https://radar.test/api/dashboard'), {...env,ACTIVITY:store},ctx)
    assert.equal(response.status,503)
  }
  assert.equal((await worker.fetch(new Request('https://radar.test/api/dashboard',{method:'POST'}),env,ctx)).status,405)
})
it('scheduled() runs the burns collector and advances its watermark', async () => {
  const headBlock = 70000000n
  const store = new Map()
  store.set('meta:burn-collector', JSON.stringify({ last_block: (headBlock - 5n).toString(), last_run_ts: 1, status: 'ok' }))
  const kv = { get: async (k, type) => { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v) }, put: async (k, v) => { store.set(k, v) } }
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const result = body.method === 'eth_blockNumber' ? '0x' + headBlock.toString(16)
      : body.method === 'eth_getLogs' ? []
      : '0x0'
    return Response.json({ jsonrpc: '2.0', id: body.id ?? 1, result })
  })
  const pending = []
  const cronCtx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})) } }
  await worker.scheduled({}, { ACTIVITY: kv }, cronCtx)
  await Promise.all(pending)
  const meta = JSON.parse(store.get('meta:burn-collector'))
  assert.equal(meta.last_block, headBlock.toString())
  assert.ok(typeof meta.last_run_ts === 'number' && meta.last_run_ts > 1)
})
it('scheduled() runs the minter collector when its watermark is stale', async () => {
  const headBlock = 70000000n
  const store = new Map()
  store.set('meta:minter-collector', JSON.stringify({ last_block: (headBlock - 5000n).toString(), last_run_ts: 0, status: 'ok' }))
  const kv = {
    get: async (k, type) => { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v) },
    put: async (k, v) => { store.set(k, v) },
    list: async () => ({ keys: [], list_complete: true }),
  }
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const one = (call) => {
      const result = call?.method === 'eth_blockNumber' ? '0x' + headBlock.toString(16)
        : call?.method === 'eth_getLogs' ? []
        : '0x0'
      return { jsonrpc: '2.0', id: call?.id ?? 1, result }
    }
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  })
  const pending = []
  const cronCtx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})) } }
  await worker.scheduled({}, { ACTIVITY: kv }, cronCtx)
  await Promise.all(pending)
  const meta = JSON.parse(store.get('meta:minter-collector'))
  assert.equal(meta.last_block, headBlock.toString())
  assert.ok(typeof meta.last_run_ts === 'number' && meta.last_run_ts > 0)
})
it('scheduled() runs the cheap at-head check on every tick once caught up', async () => {
  const headBlock = 70000000n
  const nowS = Math.floor(Date.now() / 1000)
  const store = new Map()
  store.set('meta:minter-collector', JSON.stringify({ last_block: (headBlock - 5000n).toString(), last_run_ts: nowS, status: 'ok' }))
  let upstream = 0
  const kv = {
    get: async (k, type) => { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v) },
    put: async (k, v) => { store.set(k, v) },
  }
  mock.method(globalThis, 'fetch', async () => { upstream++; return Response.json({ jsonrpc: '2.0', id: 1, result: '0x0' }) })
  const pending = []
  const cronCtx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})) } }
  await worker.scheduled({}, { ACTIVITY: kv }, cronCtx)
  await Promise.all(pending)
  // Watermark untouched and no minter data keys written: the collector runs
  // on every tick now (no hourly gate) but found fromBlock > head and
  // returned early after one cheap head read. The burns collector and market
  // snapshot still ran (they make their own upstream calls).
  const meta = JSON.parse(store.get('meta:minter-collector'))
  assert.equal(meta.last_block, (headBlock - 5000n).toString())
  assert.equal(meta.last_run_ts, nowS)
  assert.ok(![...store.keys()].some((k) => k.startsWith('minter:') || k.startsWith('flows:daily:')))
  assert.ok(upstream > 0)
})
it('scheduled() records the minter collector failure reason and backs off', async () => {
  const headBlock = 70000000n
  const store = new Map()
  store.set('meta:minter-collector', JSON.stringify({ last_block: (headBlock - 5000n).toString(), last_run_ts: 0, status: 'ok' }))
  const kv = {
    get: async (k, type) => { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v) },
    put: async (k, v) => { store.set(k, v) },
    list: async () => ({ keys: [], list_complete: true }),
  }
  // eth_blockNumber fails so the minter collector reports head-unreadable.
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const one = (call) => {
      if (call?.method === 'eth_blockNumber') throw new Error('rpc down')
      return { jsonrpc: '2.0', id: call?.id ?? 1, result: call?.method === 'eth_getLogs' ? [] : '0x0' }
    }
    if (Array.isArray(body)) {
      const calls = body.map(one)
      return Response.json(calls)
    }
    return Response.json(one(body))
  })
  const pending = []
  const cronCtx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})) } }
  await worker.scheduled({}, { ACTIVITY: kv }, cronCtx)
  await Promise.all(pending)
  const meta = JSON.parse(store.get('meta:minter-collector'))
  assert.equal(meta.status, 'error')
  assert.equal(meta.reason, 'head-unreadable')
  assert.equal(meta.last_block, (headBlock - 5000n).toString())
  assert.ok(typeof meta.last_attempt_ts === 'number' && meta.last_attempt_ts > 0)
  const marker = store.get('meta:minter-collector')
  // A second immediate tick must back off: no new failure record, no retry scan.
  const pending2 = []
  const cronCtx2 = { waitUntil(p) { pending2.push(Promise.resolve(p).catch(() => {})) } }
  await worker.scheduled({}, { ACTIVITY: kv }, cronCtx2)
  await Promise.all(pending2)
  assert.equal(store.get('meta:minter-collector'), marker)
})
it('recordMinterCollectorFailure keeps diagnostics honest and never throws', async () => {
  const store = new Map()
  const kv = { put: async (k, v) => { store.set(k, v) } }
  await recordMinterCollectorFailure({ ACTIVITY: kv }, { last_block: '123' }, 999, 'scan-failed', new Error('boom'))
  const meta = JSON.parse(store.get('meta:minter-collector'))
  assert.equal(meta.status, 'error')
  assert.equal(meta.reason, 'scan-failed')
  assert.equal(meta.error, 'boom')
  assert.equal(meta.last_block, '123')
  assert.equal(meta.last_attempt_ts, 999)
  // Long error text is truncated; a throwing KV binding does not propagate.
  const longErr = new Error('x'.repeat(500))
  await recordMinterCollectorFailure({ ACTIVITY: kv }, null, 1000, 'deadline', longErr)
  const meta2 = JSON.parse(store.get('meta:minter-collector'))
  assert.equal(meta2.error.length, 200)
  await recordMinterCollectorFailure({ ACTIVITY: { put: async () => { throw new Error('kv down') } } }, null, 1001, 'kv-unavailable', null)
})
