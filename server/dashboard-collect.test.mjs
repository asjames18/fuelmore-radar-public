import { it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DASHBOARD_KEY,
  buildDashboard,
  decodeDashboard,
  encodeDashboard,
  mergeDashboard,
  runDashboardSnapshot,
} from './dashboard-collect.mjs'

const FUEL = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
const MORE = '0xc0F1A40512114b25cc1F30b5DF0bb48691405555'
const FUEL_PAIR = '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69'
const MORE_PAIR = '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef'

const realFetch = globalThis.fetch

function pairPayload(symbol, pairAddress, tokenAddress) {
  return {
    pairs: [{
      chainId: 'robinhood',
      dexId: 'uniswap',
      labels: ['v3'],
      pairAddress,
      baseToken: { address: tokenAddress, symbol, name: symbol === 'FUEL' ? 'FUEL Token' : 'MORE Token' },
      priceUsd: '0.5',
      priceNative: '1',
      liquidity: { usd: 1000 },
      marketCap: 2000,
      fdv: 3000,
      volume: { h24: 100 },
      txns: { h24: { buys: 5, sells: 6 } },
      priceChange: { h1: 1, h6: 2, h24: 3 },
      pairCreatedAt: 1700000000000,
    }],
  }
}

const contractPayload = {
  is_verified: true,
  proxy_type: 'eip1967',
  implementations: [{ address_hash: '0x0000000000000000000000000000000000000001' }],
  name: 'FuelToken',
}

function tokenMeta(holdersCount, supply) {
  return { total_supply: supply.toString(), holders_count: holdersCount }
}

function holderItem(hash, value, isContract) {
  return { address: { hash, is_contract: isContract }, value: value.toString() }
}

function transferItem(tokenSymbol, txHash, ts) {
  return {
    transaction_hash: txHash,
    timestamp: ts,
    token: { symbol: tokenSymbol },
    total: { value: '1000000000000000000', decimals: '18' },
    from: { hash: '0x0000000000000000000000000000000000000000' },
    to: { hash: '0x1111111111111111111111111111111111111111' },
  }
}

const hexWord = (n) => '0x' + n.toString(16).padStart(64, '0')

function rpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/** Route stubbed fetch by URL for a fully-successful dashboard build. */
function stubFetchAll() {
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    const u = String(url)
    if (u.includes('dexscreener.com')) {
      const isFuel = u.endsWith(FUEL_PAIR)
      return Response.json(pairPayload(isFuel ? 'FUEL' : 'MORE', isFuel ? FUEL_PAIR : MORE_PAIR, isFuel ? FUEL : MORE))
    }
    if (u.includes('/smart-contracts/')) return Response.json(contractPayload)
    if (u.includes('/holders')) return Response.json({ items: [holderItem('0xaaaa00000000000000000000000000000000000001', 5000n, false), holderItem('0xbbbb00000000000000000000000000000000000002', 1000n, true)] })
    if (u.includes('/tokens/') && u.includes('/transfers')) {
      const isFuel = u.includes(FUEL)
      return Response.json({ items: [transferItem(isFuel ? 'FUEL' : 'MORE', '0xhash' + (isFuel ? '1' : '2'), '2026-09-24T11:50:00.000Z')] })
    }
    if (u.includes('/tokens/')) return Response.json(tokenMeta(42, 10000n))
    // JSON-RPC batch: distinguish by the methods in the posted batch.
    const body = JSON.parse(init.body)
    const batch = Array.isArray(body) ? body : [body]
    const methods = batch.map((c) => c.method)
    if (methods.includes('eth_getBlockByNumber')) {
      if (batch.length === 2) {
        return Response.json([rpcResponse(1, '0x1237'), rpcResponse(2, { number: '0x100', hash: '0x' + 'ab'.repeat(32), timestamp: '0x66f00000' })])
      }
      return Response.json([rpcResponse(1, '0x1237'), rpcResponse(2, { number: '0x100', hash: '0x' + 'ab'.repeat(32), timestamp: '0x66f00000' })])
    }
    return Response.json(batch.map((c) => rpcResponse(c.id, hexWord(7n))))
  }
  return () => calls
}

function makeDb() {
  const store = new Map()
  return {
    store,
    prepare: () => ({
      bind: (key, value) => ({
        first: async () => (store.has(key) ? { value: store.get(key) } : null),
        run: async () => { store.set(key, value) },
      }),
    }),
  }
}

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

function validSnapshot(overrides = {}) {
  const checkedAt = new Date().toISOString()
  const base = {
    sources: [
      { name: 'Dexscreener markets', status: 'available', checkedAt, detail: 'd' },
      { name: 'Blockscout contracts', status: 'available', checkedAt, detail: 'd' },
      { name: 'FUEL holders', status: 'available', checkedAt, detail: 'd' },
      { name: 'MORE holders', status: 'available', checkedAt, detail: 'd' },
      { name: 'FUEL transfers', status: 'available', checkedAt, detail: 'd' },
      { name: 'MORE transfers', status: 'available', checkedAt, detail: 'd' },
      { name: 'Protocol RPC reads', status: 'available', checkedAt, detail: 'd' },
    ],
    pairs: [{ symbol: 'FUEL', pairAddress: FUEL_PAIR, tokenAddress: FUEL }],
    contracts: [{ key: 'fuel', address: FUEL }],
    holders: {
      FUEL: { totalHolders: 1, topAddress: '0x1', topPercent: 50, topIsContract: false, topNonContractPercent: 50, topHolders: [] },
      MORE: { totalHolders: 0, topAddress: null, topPercent: null, topIsContract: null, topNonContractPercent: null, topHolders: [] },
    },
    activity: [{ hash: '0x1', timestamp: checkedAt, symbol: 'FUEL', event: 'Mint', amount: 1, from: '0x0', to: '0x1', status: 'Confirmed' }],
    protocol: {
      totalSupply: 1n, moreTotalSupply: 2n, globalRank: 3n, activeMinters: 4n, totalStaked: 5n,
      activeStakes: 6n, amp: 7n, eaar: 8n, maxTermSeconds: 9n,
      fuelBurnt: 10n, moreBurnt: 11n, ethUsedFuelBurns: 12n, ethUsedMoreBurns: 13n,
      totalDistributed: 14n, vaultBalance: 15n, vaultSwept: 16n, vaultCycle: 17n, vaultCycleEnd: 18n,
    },
    updatedAt: checkedAt,
    partial: false,
    ...overrides,
  }
  return base
}

it('round-trips a valid snapshot through encode/decode (bigints as strings)', () => {
  const body = encodeDashboard(validSnapshot())
  const decoded = decodeDashboard(body)
  assert.ok(decoded)
  assert.equal(typeof decoded.protocol.totalSupply, 'bigint')
  assert.equal(decoded.protocol.totalSupply, 1n)
  assert.ok(JSON.parse(body).data.protocol.totalSupply === '1')
})

it('rejects snapshots with the wrong chain, version, or missing sources', () => {
  const good = JSON.parse(encodeDashboard(validSnapshot()))
  assert.equal(decodeDashboard(JSON.stringify({ ...good, chainId: 1 })), null)
  assert.equal(decodeDashboard(JSON.stringify({ ...good, version: 2 })), null)
  const missing = { ...good, data: { ...good.data, sources: good.data.sources.slice(0, 6) } }
  assert.equal(decodeDashboard(JSON.stringify(missing)), null)
  assert.equal(decodeDashboard('not json'), null)
  assert.equal(decodeDashboard('x'.repeat(1_000_001)), null)
})

it('merge keeps the previous snapshot when it is newer', () => {
  const now = Date.now()
  const prev = validSnapshot({ updatedAt: new Date(now).toISOString() })
  const next = validSnapshot({ updatedAt: new Date(now - 60_000).toISOString() })
  assert.equal(mergeDashboard(prev, next), prev)
})

it('merge retains prior sections when a source fails (never invents data)', () => {
  const prev = validSnapshot({ updatedAt: '2026-09-24T10:00:00.000Z' })
  const incoming = validSnapshot({
    updatedAt: '2026-09-24T11:00:00.000Z',
    pairs: [],
    holders: {
      FUEL: { totalHolders: null, topAddress: null, topPercent: null, topIsContract: null, topNonContractPercent: null, topHolders: null },
      MORE: prev.holders.MORE,
    },
    protocol: Object.fromEntries(Object.keys(prev.protocol).map((k) => [k, null])),
  })
  incoming.sources[0].status = 'unavailable'
  incoming.sources[2].status = 'unavailable'
  incoming.sources[6].status = 'unavailable'
  const merged = mergeDashboard(prev, incoming)
  assert.deepEqual(merged.pairs, prev.pairs)
  assert.deepEqual(merged.holders.FUEL, prev.holders.FUEL)
  assert.deepEqual(merged.protocol, prev.protocol)
  assert.ok(merged.sources[0].retained)
  assert.equal(merged.partial, true)
  // Successful sections still come from the fresh run.
  assert.deepEqual(merged.contracts, incoming.contracts)
})

it('buildDashboard assembles all sections from live sources', async () => {
  stubFetchAll()
  const data = await buildDashboard({ RPC_URL: 'https://rpc.example' })
  assert.equal(data.pairs.length, 2)
  assert.equal(data.pairs[0].symbol, 'FUEL')
  assert.equal(data.contracts.length, 7)
  assert.ok(data.contracts.every((c) => c.reachable && c.verified))
  assert.equal(data.holders.FUEL.totalHolders, 42)
  assert.equal(data.holders.FUEL.topPercent, 50)
  assert.equal(data.holders.FUEL.topHolders.length, 2)
  assert.equal(data.activity.length, 2)
  assert.equal(data.activity[0].event, 'Mint')
  assert.equal(data.activity[0].amount, 1)
  assert.equal(data.protocol.totalSupply, 7n)
  assert.equal(data.protocol.vaultBalance, 7n)
  assert.equal(data.protocolObservation.blockNumber, '256')
  assert.equal(data.protocolObservation.blockTimestamp, String(0x66f00000n))
  assert.ok(data.sources.every((s) => s.status === 'available'))
  assert.equal(data.partial, false)
})

it('buildDashboard marks failed sources honestly and keeps going', async () => {
  stubFetchAll()
  const failing = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('dexscreener.com')) throw new Error('dex down')
    return failing(url, init)
  }
  const data = await buildDashboard({ RPC_URL: 'https://rpc.example' })
  assert.equal(data.pairs.length, 0)
  assert.equal(data.sources[0].status, 'unavailable')
  assert.equal(data.contracts.length, 7)
  assert.equal(data.partial, true)
})

it('runDashboardSnapshot writes a validated snapshot to D1 and never throws', async () => {
  stubFetchAll()
  const db = makeDb()
  const env = { DB: db, RPC_URL: 'https://rpc.example' }
  await runDashboardSnapshot(env)
  const raw = db.store.get(DASHBOARD_KEY)
  assert.ok(raw)
  const decoded = decodeDashboard(raw)
  assert.ok(decoded)
  assert.equal(decoded.pairs.length, 2)
  // Second run merges over the first and keeps the KV mirror untouched.
  await runDashboardSnapshot(env)
  assert.ok(decodeDashboard(db.store.get(DASHBOARD_KEY)))
})

it('runDashboardSnapshot never throws when every source fails', async () => {
  globalThis.fetch = async () => { throw new Error('network down') }
  const db = makeDb()
  await runDashboardSnapshot({ DB: db })
  // With no previous snapshot, the structurally-valid but fully-unavailable
  // shell is still written so the API reports honestly instead of 404ing.
  const decoded = decodeDashboard(db.store.get(DASHBOARD_KEY))
  assert.ok(decoded)
  assert.equal(decoded.partial, true)
  assert.ok(decoded.sources.every((s) => s.status === 'unavailable'))
  assert.equal(decoded.pairs.length, 0)
})
