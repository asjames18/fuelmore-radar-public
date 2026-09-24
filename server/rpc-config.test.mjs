import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRpcUrl } from './rpc-config.mjs'
it('uses legacy default only when no endpoint is configured', () => {
  assert.equal(resolveRpcUrl({}), 'https://rpc.mainnet.chain.robinhood.com')
  assert.equal(resolveRpcUrl({ RPC_URL: ' https://provider.test/v2/example?key=example ' }), 'https://provider.test/v2/example?key=example')
})
it('rejects invalid endpoints without disclosing credentials', () => {
  for (const value of [' ', 'http://provider.test/secret', 'https://user:secret@provider.test', 'file:///secret', 'https://provider.test/#secret']) {
    assert.throws(() => resolveRpcUrl({ RPC_URL: value }), error => error.message === 'Invalid backend RPC configuration')
  }
})
it('collector uses configured provider and stops on the wrong network', async () => {
  const { mock } = await import('node:test')
  const { collectActivity } = await import('./activity.mjs')
  const previous = process.env.RPC_URL
  process.env.RPC_URL = 'https://collector.test/v2/test-secret'
  const seen = []
  const mocked = mock.method(globalThis, 'fetch', async (url, options) => {
    const request = url instanceof Request ? url : new Request(url, options)
    const body = await request.json()
    seen.push([request.url, body.method])
    return Response.json({jsonrpc:'2.0', id:body.id, result:'0x1'})
  })
  try {
    await assert.rejects(collectActivity(), /Unexpected RPC network/)
    assert.deepEqual(seen, [['https://collector.test/v2/test-secret', 'eth_chainId']])
  } finally {
    mocked.mock.restore()
    if (previous === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = previous
  }
})
it('publisher failure exits unsuccessfully without exposing configured credentials', async () => {
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(process.execPath, ['server/publish-activity.mjs'], {cwd: new URL('../', import.meta.url), env:{...process.env, RPC_URL:'http://secret-user:secret-value@127.0.0.1:1'}, encoding:'utf8', timeout:8000})
  assert.equal(child.status, 1)
  assert.equal((child.stdout + child.stderr).includes('secret-value'), false)
})
it('validates configured log ranges and defaults managed endpoints to small ranges', async () => {
 const {resolveLogRange}=await import('./rpc-config.mjs')
 assert.equal(resolveLogRange({RPC_URL:'https://provider.test'}),10n)
 assert.equal(resolveLogRange({}),50000n)
 assert.equal(resolveLogRange({RPC_LOG_RANGE:'2000'}),2000n)
 for(const value of ['0','-1','1.5','50001','secret']) assert.throws(()=>resolveLogRange({RPC_LOG_RANGE:value}),/Invalid collector log range/)
})

it('burn collector defaults to the public RPC with 50k-block log ranges', async () => {
 const {resolveBurnRpcUrl,resolveBurnLogRange}=await import('./rpc-config.mjs')
 // No BURN_RPC_URL: public RPC + large ranges (the steady-state fix).
 assert.equal(resolveBurnRpcUrl({}), 'https://rpc.mainnet.chain.robinhood.com')
 assert.equal(resolveBurnRpcUrl({BURN_RPC_URL:''}), 'https://rpc.mainnet.chain.robinhood.com')
 assert.equal(resolveBurnLogRange({}), 50000n)
 // RPC_URL (managed endpoint) does NOT leak into the burn collector.
 assert.equal(resolveBurnRpcUrl({RPC_URL:'https://provider.test/v2/secret'}), 'https://rpc.mainnet.chain.robinhood.com')
 assert.equal(resolveBurnLogRange({RPC_URL:'https://provider.test/v2/secret'}), 50000n)
 // Explicit override honored and validated like the main resolver.
 assert.equal(resolveBurnRpcUrl({BURN_RPC_URL:' https://burns.test/v2/key '}), 'https://burns.test/v2/key')
 assert.equal(resolveBurnLogRange({BURN_RPC_URL:'https://burns.test'}), 10n)
 assert.equal(resolveBurnLogRange({BURN_LOG_RANGE:'2000'}), 2000n)
 for(const value of [' ', 'http://provider.test/secret', 'https://user:secret@provider.test', 'file:///secret', 'https://provider.test/#secret']) {
   assert.throws(() => resolveBurnRpcUrl({BURN_RPC_URL:value}), error => error.message === 'Invalid burn-collector RPC configuration')
 }
 for(const value of ['0','-1','1.5','50001','secret']) assert.throws(()=>resolveBurnLogRange({BURN_LOG_RANGE:value}),/Invalid burn-collector log range/)
})

it('classifies collector failures without copying provider messages or URLs',async()=>{
 const {collectorDiagnostic}=await import('./rpc-config.mjs')
 assert.deepEqual(collectorDiagnostic({message:'https://secret',cause:{status:429,message:'secret'}}),{category:'rate_limit',httpStatus:429})
 assert.deepEqual(collectorDiagnostic({cause:{name:'TimeoutError',message:'secret'}}),{category:'timeout'})
 assert.deepEqual(collectorDiagnostic({cause:{code:-32602,data:'secret'}}),{category:'rpc',rpcCode:-32602})
 assert.deepEqual(collectorDiagnostic(new Error('secret')),{category:'unknown'})
})
