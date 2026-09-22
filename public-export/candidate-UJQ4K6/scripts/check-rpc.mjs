#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolveRpcUrl, PUBLIC_RPC } from '../server/rpc-config.mjs'
import { TOKEN } from '../server/activity.mjs'
const hex = value => '0x'+value.toString(16)
const hashPattern = /^0x[0-9a-fA-F]{64}$/
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Historical probe proves only these requests succeeded, not completeness of an archive. */
export async function probeRpc(call, historicalBlock) {
  if (BigInt(await call('eth_chainId', [])) !== 4663n) throw new Error('Unexpected RPC network')
  const head = BigInt(await call('eth_blockNumber', []))
  if (head < 64n || historicalBlock < 0n || historicalBlock > head-64n) throw new Error('Invalid probe block range')
  const pinned = hex(head-64n), historical = hex(historicalBlock)
  const before = await call('eth_getBlockByNumber', [pinned,false])
  const old = await call('eth_getBlockByNumber', [historical,false])
  if (!hashPattern.test(before?.hash) || before.number !== pinned || !hashPattern.test(old?.hash) || old.number !== historical) throw new Error('Invalid block response')
  for (const block of [pinned,historical]) {
    const result = await call('eth_call', [{to:TOKEN,data:'0x18160ddd'},block])
    if (!hashPattern.test(result)) throw new Error('Invalid historical contract response')
  }
  const logs = await call('eth_getLogs', [{address:TOKEN,topics:[transferTopic],fromBlock:historical,toBlock:historical}])
  if (!Array.isArray(logs) || logs.some(log => log.blockHash !== old.hash || log.blockNumber !== historical || log.address?.toLowerCase() !== TOKEN.toLowerCase() || log.topics?.[0] !== transferTopic || log.removed)) throw new Error('Invalid historical logs')
  const after = await call('eth_getBlockByNumber', [pinned,false])
  const oldAfter = await call('eth_getBlockByNumber', [historical,false])
  if (after?.hash !== before.hash || oldAfter?.hash !== old.hash) throw new Error('Snapshot changed')
  return {chainId:4663,blockNumber:String(head-64n),historicalBlock:String(historicalBlock),historicalRead:true,historicalLogs:true,consistent:true}
}

/** Characterize sampled workloads, not the provider's contractual limits. */
export async function probeWorkload(call, batch, block) {
  if (block < 49999n) throw new Error('Invalid workload block')
  const pinned = hex(block)
  const before = await call('eth_getBlockByNumber', [pinned, false])
  if (!hashPattern.test(before?.hash) || before.number !== pinned) throw new Error('Invalid workload block')
  const params = [{to: TOKEN, data: '0x18160ddd'}, pinned]
  const expected = await call('eth_call', params)
  if (!hashPattern.test(expected)) throw new Error('Invalid contract response')
  const started = Date.now()
  const values = await batch(Array.from({length: 6}, () => ({method: 'eth_call', params})))
  const batchElapsedMs = Date.now() - started
  if (!Array.isArray(values) || values.length !== 6 || values.some(value => value !== expected)) throw new Error('Invalid batch response')
  const logRanges = []
  for (const blocks of [10, 2000, 50000]) {
    const from = block - BigInt(blocks) + 1n
    const start = Date.now()
    let supported = false
    try {
      const logs = await call('eth_getLogs', [{address:TOKEN, topics:[transferTopic], fromBlock:hex(from), toBlock:pinned}])
      supported = Array.isArray(logs) && logs.every(log =>
        /^0x[0-9a-f]+$/i.test(log.blockNumber ?? '') && BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= block &&
        hashPattern.test(log.blockHash) && log.address?.toLowerCase() === TOKEN.toLowerCase() && log.topics?.[0] === transferTopic && !log.removed)
    } catch { /* Record unsupported/failed samples without disclosing provider errors. */ }
    logRanges.push({blocks, supported, elapsedMs: Date.now()-start})
  }
  const after = await call('eth_getBlockByNumber', [pinned, false])
  if (after?.hash !== before.hash) throw new Error('Snapshot changed')
  return {batchReads:6, batchElapsedMs, logRanges}
}

async function main() {
  const upstream = resolveRpcUrl(process.env)
  if (upstream === PUBLIC_RPC) throw new Error('Configure a managed RPC_URL before running this check')
  // Previously verified FUEL historical block; setup must work before collection.
  const historicalBlock = 63139884n
  let id=0
  const send = async payload => {
    const response=await fetch(upstream,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000)})
    if (!response.ok) throw new Error('Provider HTTP failure')
    const body=await response.json()
    const requests=Array.isArray(payload)?payload:[payload]
    const responses=Array.isArray(body)?body:[body]
    if (Array.isArray(payload)!==Array.isArray(body) || requests.length!==responses.length) throw new Error('Provider RPC shape failure')
    return requests.map(request => {
      const matches=responses.filter(value=>value?.id===request.id)
      const value=matches[0]
      if (matches.length!==1 || value.jsonrpc!=='2.0' || value.error || !('result' in value)) throw new Error('Provider RPC failure')
      return value.result
    })
  }
  const call=async (method,params)=>(await send({jsonrpc:'2.0',id:++id,method,params}))[0]
  const batch=async requests=>send(requests.map(request=>({jsonrpc:'2.0',id:++id,...request})))
  const capabilities=await probeRpc(call,historicalBlock)
  const workload=await probeWorkload(call,batch,BigInt(capabilities.blockNumber))
  console.log(JSON.stringify({...capabilities,workload},null,2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('RPC capability check failed. Verify backend RPC_URL, chain and historical access; no endpoint details logged.'); process.exitCode=1 })
}
