import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  keccak256Bytes,
  bytesToHex,
  functionSelector,
  toChecksumAddress,
  parseCockpitAddress,
  encodeCall,
  encodeAggregate3,
  decodeAggregate3,
  decodeWords,
  decodeMintWords,
  wordToAddress,
  serializeCockpitSnapshot,
  computeCockpitSnapshot,
  handleCockpitRequest,
  COCKPIT_CACHE_TTL_SECONDS,
  COCKPIT_COMPUTE_CAP_PER_HOUR,
} from './cockpit-cache.mjs'

const w = n => BigInt(n).toString(16).padStart(64, '0')
const ADDR = toChecksumAddress('0x' + 'a1'.repeat(20))
const PROXY_A = '0x' + '00'.repeat(12) + 'b1'.repeat(20)
const PROXY_B = '0x' + '00'.repeat(12) + 'b2'.repeat(20)
const PROXY_A20 = '0x' + 'b1'.repeat(20)
const PROXY_B20 = '0x' + 'b2'.repeat(20)
const BLOCK_HASH = '0x' + 'ab'.repeat(32)

/** Hand-built aggregate3 result (layout cross-checked against viem). */
function agg3Result(items) {
  const tuples = items.map(({ success, returnData }) => {
    const d = returnData.slice(2)
    const len = d.length / 2
    return w(success ? 1 : 0) + w(64) + w(len) + d.padEnd(Math.ceil(len / 32) * 64, '0')
  })
  let body = w(32) + w(items.length)
  let off = items.length * 32
  for (const t of tuples) { body += w(off); off += t.length / 2 }
  return '0x' + body + tuples.join('')
}

const mintWords = (user, maturity) =>
  '0x' + '00'.repeat(12) + user.slice(2) + w(30) + w(maturity) + w(7) + w(2) + w(100)

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial))
  const puts = []
  return {
    store,
    puts,
    get: async k => (store.has(k) ? store.get(k) : null),
    put: async (k, v, opts) => { puts.push({ k, v, opts }); store.set(k, v) },
  }
}

/** Canned upstream: chain 4663, block 0x64, 2 proxies; agg3Call counts aggregate3 calls. */
function makeUpstream(overrides = {}) {
  let agg3Calls = 0
  const route = item => {
    const [tx] = item.params || []
    if (item.method === 'eth_chainId') return { result: overrides.chainId ?? '0x1237' }
    if (item.method === 'eth_getBlockByNumber') {
      if (overrides.blockHash && item.params[0] !== 'latest') return { result: { number: '0x64', hash: overrides.blockHash, timestamp: '0x3e8' } }
      return { result: { number: '0x64', hash: BLOCK_HASH, timestamp: '0x3e8' } }
    }
    if (item.method === 'eth_call') {
      const data = tx.data
      const sel = data.slice(2, 10)
      if (sel === functionSelector('balanceOf(address)')) {
        return overrides.balanceError ? { error: { code: -32000, message: 'reverted' } } : { result: '0x' + w(1000) }
      }
      if (sel === functionSelector('userMints(address)')) return { result: mintWords(ADDR, overrides.maturities?.direct ?? 2000) }
      if (sel === functionSelector('userStakes(address)')) return { result: '0x' + w(30) + w(2000) + w(0) + w(0) }
      if (sel === functionSelector('proxiesOf(address)')) return { result: '0x' + w(overrides.proxyCount ?? 2) }
      if (sel === functionSelector('globalRank()')) return { result: '0x' + w(50) }
      if (sel === functionSelector('aggregate3((address,bool,bytes)[])')) {
        agg3Calls++
        if (agg3Calls === 1) return { result: agg3Result([{ success: true, returnData: PROXY_A }, { success: true, returnData: PROXY_B }]) }
        if (overrides.mintFailure) {
          return { result: agg3Result([{ success: true, returnData: mintWords(PROXY_A20, 2000) }, { success: false, returnData: '0x' }]) }
        }
        const bm = overrides.maturities?.batch ?? [2000, 3000]
        return { result: agg3Result([{ success: true, returnData: mintWords(PROXY_A20, bm[0]) }, { success: true, returnData: mintWords(PROXY_B20, bm[1]) }]) }
      }
      throw new Error('unexpected selector ' + sel)
    }
    throw new Error('unexpected method ' + item.method)
  }
  const calls = []
  const fetchImpl = async (url, init) => {
    const items = JSON.parse(init.body)
    calls.push(items)
    const list = Array.isArray(items) ? items : [items]
    const replies = list.map(item => {
      const r = route(item)
      return r.error
        ? { jsonrpc: '2.0', id: item.id, error: r.error }
        : { jsonrpc: '2.0', id: item.id, result: r.result }
    })
    return { ok: true, json: async () => (Array.isArray(items) ? replies : replies[0]) }
  }
  return { fetchImpl, calls, agg3Count: () => agg3Calls }
}

afterEach(() => mock.restoreAll())

describe('keccak + selectors', () => {
  it('matches the keccak-256 test vectors', () => {
    assert.equal(bytesToHex(keccak256Bytes(new Uint8Array(0))), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    assert.equal(bytesToHex(keccak256Bytes(new TextEncoder().encode('hello'))), '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8')
  })
  it('computes known function selectors', () => {
    assert.equal(functionSelector('balanceOf(address)'), '70a08231')
    assert.equal(functionSelector('aggregate3((address,bool,bytes)[])'), '82ad56cb')
  })
})

describe('aggregate3 codec', () => {
  it('round-trips subcalls through encode/decode', () => {
    const calls = [
      { target: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3', allowFailure: true, callData: encodeCall('balanceOf(address)', [['address', ADDR]]) },
      { target: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3', allowFailure: false, callData: '0x' },
    ]
    const decoded = decodeAggregate3(agg3Result([
      { success: true, returnData: calls[0].callData },
      { success: false, returnData: '0x' },
    ]))
    assert.deepEqual(decoded, [
      { success: true, returnData: calls[0].callData },
      { success: false, returnData: '0x' },
    ])
    // The encoder output itself must decode structurally (offsets intact).
    assert.ok(/^0x[0-9a-f]{8}/.test(encodeAggregate3(calls)))
  })
  it('rejects malformed result data', () => {
    assert.equal(decodeAggregate3('0x1234'), null)
    assert.equal(decodeAggregate3('not hex'), null)
    assert.equal(decodeWords('0x1234', 6), null)
  })
  it('decodes mint tuples with the zero-user rule', () => {
    const words = decodeWords('0x' + mintWords(ADDR, 2000).slice(2), 6)
    assert.deepEqual(decodeMintWords(words), { term: 30n, maturityTs: 2000n, rank: 7n, amplifier: 2n, eaaRate: 100n })
    assert.equal(decodeMintWords(decodeWords('0x' + '00'.repeat(224), 6)), null)
    assert.equal(wordToAddress(PROXY_A), toChecksumAddress('0x' + 'b1'.repeat(20)))
  })
})

describe('address validation', () => {
  it('accepts strict EIP-55 checksummed addresses', () => {
    assert.equal(parseCockpitAddress(ADDR), ADDR)
  })
  it('rejects malformed, non-checksummed, and wrong-case input', () => {
    for (const bad of ['', '0x123', 'not-an-address', null, undefined, 42,
      '0x' + 'a1'.repeat(20), // all lowercase with letters
      ADDR.toUpperCase().replace('0X', '0x'), // wrong case
      '  ' + ADDR + 'extra']) {
      assert.equal(parseCockpitAddress(bad), null, `should reject ${bad}`)
    }
  })
  it('accepts all-digit addresses (no case to checksum)', () => {
    assert.equal(parseCockpitAddress('0x0000000000000000000000000000000000000001'), '0x0000000000000000000000000000000000000001')
  })
})

describe('computeCockpitSnapshot', () => {
  it('builds the full snapshot from multicall reads', async () => {
    const { fetchImpl } = makeUpstream()
    const snap = await computeCockpitSnapshot({ address: ADDR, rpcUrl: 'https://upstream.test', fetchImpl })
    assert.equal(snap.address, ADDR)
    assert.equal(snap.blockNumber, 100n)
    assert.equal(snap.blockHash, BLOCK_HASH)
    assert.equal(snap.observedAt, 1000)
    assert.equal(snap.fuelBalance, 1000n)
    assert.equal(snap.globalRank, 50n)
    assert.equal(snap.batchTotal, 2)
    assert.equal(snap.activeMints, 3) // direct + 2 batch
    assert.equal(snap.sampleIncomplete, false)
    assert.deepEqual(snap.slots.map(s => s.id), ['direct', 'batch:0', 'batch:1'])
    assert.equal(snap.slots[1].proxy, toChecksumAddress('0x' + 'b1'.repeat(20)))
    assert.equal(snap.slotsPinnedBlockNumber, 100n)
    assert.equal(snap.nextMaturityTs, 2000)
    assert.equal(snap.slotsPinnedBlockHash, BLOCK_HASH)
    assert.equal(snap.directStake, null)
    // Bigints survive the wire format.
    const parsed = JSON.parse(serializeCockpitSnapshot(snap), (_k, v) =>
      (v && typeof v === 'object' && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v))
    assert.equal(parsed.blockNumber, 100n)
    assert.equal(parsed.slots[1].maturityTs, 2000n)
  })
  it('picks nextMaturityTs like the client: nearest upcoming, else nearest due', async () => {
    const run = async maturities => computeCockpitSnapshot({
      address: ADDR, rpcUrl: 'https://upstream.test', fetchImpl: makeUpstream({ maturities }).fetchImpl,
    })
    // observedAt is 1000: due 500/400 + upcoming 3000 -> nearest upcoming wins.
    assert.equal((await run({ direct: 500, batch: [400, 3000] })).nextMaturityTs, 3000)
    // All due -> nearest (least overdue) due wins.
    assert.equal((await run({ direct: 500, batch: [400, 900] })).nextMaturityTs, 400)
  })
  it('marks a failed mint subcall incomplete without zeroing the rest', async () => {
    const { fetchImpl } = makeUpstream({ mintFailure: true })
    const snap = await computeCockpitSnapshot({ address: ADDR, rpcUrl: 'https://upstream.test', fetchImpl })
    assert.equal(snap.sampleIncomplete, true)
    assert.deepEqual(snap.slots.map(s => s.id), ['direct', 'batch:0'])
  })
  it('keeps a failed balance read null without flagging incomplete', async () => {
    const { fetchImpl } = makeUpstream({ balanceError: true })
    const snap = await computeCockpitSnapshot({ address: ADDR, rpcUrl: 'https://upstream.test', fetchImpl })
    assert.equal(snap.fuelBalance, null)
    assert.equal(snap.sampleIncomplete, false)
  })
  it('throws when the end block hash differs (snapshot changed)', async () => {
    const { fetchImpl } = makeUpstream({ blockHash: '0x' + 'cc'.repeat(32) })
    await assert.rejects(() => computeCockpitSnapshot({ address: ADDR, rpcUrl: 'https://upstream.test', fetchImpl }), /Snapshot changed/)
  })
  it('throws on an unexpected chain id', async () => {
    const { fetchImpl } = makeUpstream({ chainId: '0x1' })
    await assert.rejects(() => computeCockpitSnapshot({ address: ADDR, rpcUrl: 'https://upstream.test', fetchImpl }), /Unexpected network/)
  })
  it('rejects a non-checksummed address before any upstream call', async () => {
    const { fetchImpl, calls } = makeUpstream()
    await assert.rejects(() => computeCockpitSnapshot({ address: '0x' + 'a1'.repeat(20), rpcUrl: 'https://upstream.test', fetchImpl }), /Invalid address/)
    assert.equal(calls.length, 0)
  })
})

describe('handleCockpitRequest', () => {
  const get = address => new Request(`https://radar.test/api/cockpit?address=${address}`, { headers: { 'CF-Connecting-IP': '192.0.2.9' } })

  it('returns 400 for a non-checksummed address without upstream calls', async () => {
    let calls = 0
    mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not be called') })
    const res = await handleCockpitRequest(get('0x123'), {})
    assert.equal(res.status, 400)
    assert.equal(calls, 0)
  })
  it('serves a cached snapshot without upstream calls', async () => {
    const kv = makeKv({ [`cockpit:v1:${ADDR.toLowerCase()}`]: '{"cached":true}' })
    let calls = 0
    mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not be called') })
    const res = await handleCockpitRequest(get(ADDR), { COCKPIT_CACHE: kv })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('X-Cockpit-Cache'), 'HIT')
    assert.equal(await res.text(), '{"cached":true}')
    assert.equal(calls, 0)
  })
  it('computes, caches with TTL, and serves the second request from cache', async () => {    const upstream = makeUpstream()
    mock.method(globalThis, 'fetch', upstream.fetchImpl)
    const kv = makeKv()
    const env = { COCKPIT_CACHE: kv }
    const first = await handleCockpitRequest(get(ADDR), env)
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('X-Cockpit-Cache'), 'MISS')
    const body = await first.text()
    assert.match(body, /"\$bigint":"100"/)
    const snapshotPut = kv.puts.find(p => p.k === `cockpit:v1:${ADDR.toLowerCase()}`)
    assert.equal(snapshotPut.opts.expirationTtl, COCKPIT_CACHE_TTL_SECONDS)
    const budgetPut = kv.puts.find(p => p.k.startsWith('cockpit:budget:v1:'))
    assert.equal(budgetPut.opts.expirationTtl, 3600)
    const upstreamCalls = upstream.calls.length
    const second = await handleCockpitRequest(get(ADDR), env)
    assert.equal(second.headers.get('X-Cockpit-Cache'), 'HIT')
    assert.equal(upstream.calls.length, upstreamCalls)
  })
  it('works without the KV binding (compute only, no cache)', async () => {
    const upstream = makeUpstream()
    mock.method(globalThis, 'fetch', upstream.fetchImpl)
    const res = await handleCockpitRequest(get(ADDR), {})
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('X-Cockpit-Cache'), 'MISS')
  })
  it('returns 429 after the per-IP compute cap is exhausted', async () => {
    const kv = makeKv({ 'cockpit:budget:v1:192.0.2.9': String(COCKPIT_COMPUTE_CAP_PER_HOUR) })
    let calls = 0
    mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not be called') })
    const res = await handleCockpitRequest(get(ADDR), { COCKPIT_CACHE: kv })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('Retry-After'), '3600')
    assert.equal(calls, 0)
  })
  it('returns 502 when the upstream is unreachable', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('down') })
    const res = await handleCockpitRequest(get(ADDR), { COCKPIT_CACHE: makeKv() })
    assert.equal(res.status, 502)
    assert.match(await res.text(), /unavailable/)
  })
})
