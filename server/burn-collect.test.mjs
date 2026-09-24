import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FUEL_BURNER,
  BUY_AND_BURN_TOPIC,
  BURNS_KEY,
  BURN_META_KEY,
  BURN_BATCH_PACING_MS,
  decodeBurnLog,
  utcDate,
  aggregateDripsDetail,
  mergeBurnSeries,
  runBurnCollector,
  fetchBurnDripsViaTransfers,
  fetchBurnLogsBlockscout,
} from './burn-collect.mjs'

const TOPIC = BUY_AND_BURN_TOPIC

function padTopic(hexNoPrefix) {
  return '0x' + hexNoPrefix.padStart(64, '0')
}

function burnLog({ blockNumber, logIndex, ethWei, fuelWei, address = FUEL_BURNER, topic0 = TOPIC, txHash = '0xabc' }) {
  return {
    address,
    topics: [
      topic0,
      padTopic(ethWei.toString(16)),
      padTopic(fuelWei.toString(16)),
      padTopic('11'.repeat(20)),
    ],
    blockNumber: '0x' + blockNumber.toString(16),
    logIndex: '0x' + logIndex.toString(16),
    transactionHash: txHash,
  }
}

describe('decodeBurnLog', () => {
  it('decodes eth and fuel amounts from indexed topics', () => {
    const drip = decodeBurnLog(
      burnLog({ blockNumber: 70000000n, logIndex: 3n, ethWei: 1000000000000000n, fuelWei: 5000000000000000000000n }),
    )
    assert.ok(drip)
    assert.equal(drip.ethWei, 1000000000000000n)
    assert.equal(drip.fuelWei, 5000000000000000000000n)
    assert.equal(drip.blockNumber, 70000000n)
    assert.equal(drip.dripId, '70000000:3')
  })

  it('rejects logs from other contracts, other events, or zero burns', () => {
    assert.equal(
      decodeBurnLog(burnLog({ blockNumber: 1n, logIndex: 0n, ethWei: 1n, fuelWei: 1n, address: '0x0000000000000000000000000000000000000001' })),
      null,
    )
    assert.equal(
      decodeBurnLog(burnLog({ blockNumber: 1n, logIndex: 0n, ethWei: 1n, fuelWei: 1n, topic0: padTopic('dd'.repeat(32)) })),
      null,
    )
    assert.equal(
      decodeBurnLog(burnLog({ blockNumber: 1n, logIndex: 0n, ethWei: 1n, fuelWei: 0n })),
      null,
    )
    assert.equal(decodeBurnLog(null), null)
  })
})

describe('utcDate', () => {
  it('formats a UTC calendar date', () => {
    // 2026-09-22 00:00:00 UTC
    assert.equal(utcDate(1790035200), '2026-09-22')
    assert.equal(utcDate(0), null)
    assert.equal(utcDate('nope'), null)
  })
})

describe('aggregateDripsDetail + mergeBurnSeries', () => {
  const ts = new Map([['70000000', 1790035200]]) // 2026-09-22 UTC

  it('buckets drips by UTC date and is idempotent on re-merge', () => {
    const drips = [
      decodeBurnLog(burnLog({ blockNumber: 70000000n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 10n ** 21n })),
      decodeBurnLog(burnLog({ blockNumber: 70000000n, logIndex: 1n, ethWei: 2n * 10n ** 15n, fuelWei: 3n * 10n ** 21n })),
    ]
    const fresh = aggregateDripsDetail(drips, ts)
    const first = mergeBurnSeries(null, fresh)
    assert.equal(first.changed, true)
    assert.equal(first.days.length, 1)
    assert.equal(first.days[0].date, '2026-09-22')
    assert.equal(first.days[0].drips, 2)
    assert.equal(first.totals.drips, 2)
    assert.ok(Math.abs(first.totals.fuel - 4000) < 1e-6)
    assert.ok(Math.abs(first.totals.eth - 0.003) < 1e-12)

    // Re-merging the same drips changes nothing (idempotent).
    const second = mergeBurnSeries({ days: first.days }, fresh)
    assert.equal(second.changed, false)
    assert.deepEqual(second.totals, first.totals)

    // A new drip on the same day merges in.
    const more = [
      decodeBurnLog(burnLog({ blockNumber: 70000000n, logIndex: 2n, ethWei: 10n ** 15n, fuelWei: 10n ** 21n })),
    ]
    const third = mergeBurnSeries({ days: first.days }, aggregateDripsDetail(more, ts))
    assert.equal(third.changed, true)
    assert.equal(third.days[0].drips, 3)
    assert.ok(Math.abs(third.totals.fuel - 5000) < 1e-6)
  })

  it('skips drips whose block timestamp is unknown', () => {
    const drips = [decodeBurnLog(burnLog({ blockNumber: 70000001n, logIndex: 0n, ethWei: 1n, fuelWei: 10n ** 18n }))]
    const fresh = aggregateDripsDetail(drips, ts)
    assert.equal(fresh.size, 0)
  })
})

function fakeKv() {
  const store = new Map()
  const writes = []
  return {
    writes,
    async get(key, type) {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) {
      writes.push(key)
      store.set(key, value)
    },
  }
}

function fakeChain({ logs = [], timestamps = new Map(), head = 70000100n, receiptsMap = new Map() }) {
  const seenBatches = []
  return {
    seenBatches,
    async receipts(hashes) {
      const map = new Map()
      for (const h of hashes) map.set(h, receiptsMap.get(h) ?? null)
      return map
    },
    async headBlock() {
      return head
    },
    // Honors the requested block ranges like a real node: filters the canned
    // logs (stored with hex blockNumber) to each requested range.
    async logsBatched({ fromBlock, toBlock, rangeBlocks = 10n, batchCalls = 40 } = {}) {
      const ranges = []
      for (let s = BigInt(fromBlock); s <= BigInt(toBlock); s += rangeBlocks) {
        const e = s + rangeBlocks - 1n < toBlock ? s + rangeBlocks - 1n : toBlock
        ranges.push([s, e])
      }
      const batches = []
      for (let i = 0; i < ranges.length; i += batchCalls) batches.push(ranges.slice(i, i + batchCalls))
      seenBatches.push(...batches)
      return logs.filter((l) => {
        const b = BigInt(l.blockNumber)
        return ranges.some(([s, e]) => b >= s && b <= e)
      })
    },
    async blockTimestamps() {
      return timestamps
    },
  }
}

describe('runBurnCollector', () => {
  it('cold start scans from the first-burn block and writes series + meta', async () => {
    const kv = fakeKv()
    const ts = new Map([['63115001', 1789431120]])
    const chain = fakeChain({
      logs: [burnLog({ blockNumber: 63115001n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 5n * 10n ** 20n })],
      timestamps: ts,
      head: 63116000n,
    })
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(res.ok, true)
    assert.equal(res.dripsScanned, 1)
    assert.deepEqual(kv.writes, [BURNS_KEY, BURN_META_KEY])
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.days.length, 1)
    assert.equal(series.totals.drips, 1)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '63116000')
  })

  it('quiet hour: no new drips writes only the meta watermark', async () => {
    const kv = fakeKv()
    const chain = fakeChain({ logs: [], head: 70000100n })
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(res.ok, true)
    assert.equal(res.dripsScanned, 0)
    assert.deepEqual(kv.writes, [BURN_META_KEY])
  })

  it('does not double-count drips when re-scanning an overlapping range', async () => {
    const kv = fakeKv()
    const ts = new Map([['70000010', 1790035200]])
    const log = burnLog({ blockNumber: 70000010n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 10n ** 21n })
    const chain = fakeChain({ logs: [log], timestamps: ts, head: 70000020n })
    const first = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(first.ok, true)
    // Simulate a watermark rewind (retry of the same range): the same drip
    // is scanned again but must not be counted twice.
    const chain2 = fakeChain({ logs: [log], timestamps: ts, head: 70000020n })
    // Force the watermark back by hand-writing an older meta.
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '70000009', last_run_ts: 1, status: 'ok' }))
    kv.writes.length = 0
    const second = await runBurnCollector({ ACTIVITY: kv }, { chain: chain2, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(second.ok, true)
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.totals.drips, 1)
    assert.ok(Math.abs(series.totals.fuel - 1000) < 1e-6)
  })

  it('already at head returns empty without writing', async () => {
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '70000100', last_run_ts: 1, status: 'ok' }))
    kv.writes.length = 0
    const chain = fakeChain({ logs: [], head: 70000100n })
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, true)
    assert.equal(res.empty, true)
    assert.deepEqual(kv.writes, [])
  })

  it('returns ok:false (no throw) when KV is unavailable', async () => {
    const res = await runBurnCollector({}, { chain: fakeChain({}), deadline: Date.now() + 60000 })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'kv-unavailable')
  })

  it('records the failure reason in the meta without moving the watermark', async () => {
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '69497245', last_run_ts: 1, status: 'ok' }))
    const chain = fakeChain({ logs: [], head: 69500000n })
    chain.logsBatched = async () => {
      throw new Error('boom')
    }
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'scan-failed')
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '69497245')
    assert.equal(meta.status, 'error')
    assert.equal(meta.reason, 'scan-failed')
    assert.ok(meta.last_run_ts > 1)
  })
})

describe('seed watermark fallback', () => {
  it('honors the series watermark when the meta key is missing', async () => {
    const kv = fakeKv()
    // Seeded history only: no meta key, watermark embedded in the series.
    await kv.put(
      BURNS_KEY,
      JSON.stringify({
        version: 1,
        days: [{ date: '2026-09-22', fuel: 1000, eth: 0.001, drips: 2, dripIds: [] }],
        totals: { fuel: 1000, eth: 0.001, drips: 2 },
        watermark_block: '69497245',
        updated_at: '2026-09-22T09:00:00.000Z',
      }),
    )
    kv.writes.length = 0
    // A new drip lands after the watermark; the collector must start from
    // 69497246 and merge it without re-scanning seeded history.
    const ts = new Map([['69497250', 1790035200]])
    const chain = fakeChain({
      logs: [burnLog({ blockNumber: 69497250n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 5n * 10n ** 20n })],
      timestamps: ts,
      head: 69497300n,
    })
    const origLogsBatched = chain.logsBatched.bind(chain)
    chain.logsBatched = async (args) => {
      assert.ok(args.rangeBlocks <= 10n, 'range exceeds provider 10-block cap')
      assert.ok(args.batchCalls <= 100, 'batch exceeds 100 calls')
      return origLogsBatched(args)
    }
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, true)
    // The scan is packed for both caps: contiguous 10-block ranges from
    // watermark+1 to head, batched for one subrequest per 100 ranges.
    const seenRanges = chain.seenBatches.flat().map(([from, to]) => ({ from, to }))
    assert.ok(seenRanges.length > 1)
    assert.equal(seenRanges[0].from.toString(), '69497246')
    assert.equal(seenRanges.at(-1).to.toString(), '69497300')
    for (let i = 0; i < seenRanges.length; i++) {
      const r = seenRanges[i]
      assert.ok(r.to - r.from < 10n, `range ${i} exceeds 10 blocks`)
      if (i > 0) assert.equal(r.from.toString(), (seenRanges[i - 1].to + 1n).toString())
    }
    for (const b of chain.seenBatches) assert.ok(b.length <= 100, 'batch exceeds 100 calls')
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.totals.drips, 3)
    assert.ok(Math.abs(series.totals.fuel - 1500) < 1e-6)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '69497300')
  })
})

describe('provider log-range chunking', () => {
  it('scans in 10-block ranges by default (managed endpoint) and merges across them', async () => {
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '69999999', last_run_ts: 1, status: 'ok' }))
    const ts = new Map([
      ['70000005', 1790035200],
      ['70000028', 1790035200],
    ])
    const chain = fakeChain({
      logs: [
        burnLog({ blockNumber: 70000005n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 10n ** 21n }),
        burnLog({ blockNumber: 70000028n, logIndex: 0n, ethWei: 2n * 10n ** 15n, fuelWei: 3n * 10n ** 21n }),
      ],
      timestamps: ts,
      head: 70000030n,
    })
    let batchedArgs = null
    const origLogsBatched = chain.logsBatched.bind(chain)
    chain.logsBatched = async (args) => {
      batchedArgs = args
      return origLogsBatched(args)
    }
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(res.ok, true)
    assert.equal(res.dripsScanned, 2)
    // 70000000..70000030 is 31 blocks -> four 10-block ranges on the
    // managed endpoint (one batch, pacing machinery active).
    assert.equal(batchedArgs.rangeBlocks, 10n)
    assert.equal(batchedArgs.batchCalls, 100)
    assert.equal(batchedArgs.pacingMs, BURN_BATCH_PACING_MS)
    assert.equal(chain.seenBatches.length, 1)
    const ranges = chain.seenBatches[0]
    assert.equal(ranges.length, 4)
    assert.equal(ranges[0][0].toString(), '70000000')
    assert.equal(ranges[0][1].toString(), '70000009')
    for (const [s, e] of ranges) assert.ok(e - s < 10n, 'range exceeds provider 10-block cap')
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.totals.drips, 2)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '70000030')
  })

  it('reads the chain through the managed endpoint (RPC_URL)', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body)
      const items = Array.isArray(payload) ? payload : [payload]
      seen.push([url, items])
      const replies = items.map((item) => {
        if (item.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: item.id, result: '0x43ec2fb' } // 71222011
        if (item.method === 'eth_getLogs') return { jsonrpc: '2.0', id: item.id, result: [] }
        return { jsonrpc: '2.0', id: item.id, result: null }
      })
      return Response.json(Array.isArray(payload) ? replies : replies[0])
    }
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '71220000', last_run_ts: 1, status: 'ok' }))
    const res = await runBurnCollector({ ACTIVITY: kv, RPC_URL: 'https://provider.test/v2/secret' }, { fetchImpl, deadline: Date.now() + 60000, transports: ['scan'] })
    assert.equal(res.ok, true)
    // Every request went to the managed endpoint (the 2026-09-24 revert:
    // worker egress to the public RPC 429s, so the collector is back on
    // the managed path for steady-state scans).
    assert.ok(seen.length >= 1)
    assert.ok(seen.every(([url]) => url === 'https://provider.test/v2/secret'))
    const logItems = seen.flatMap(([, items]) => items).filter((item) => item.method === 'eth_getLogs')
    assert.ok(logItems.length >= 1)
    // The ~2k-block gap is chunked at the managed endpoint's 10-block cap.
    for (const item of logItems) {
      const filter = item.params[0]
      assert.ok(BigInt(filter.toBlock) - BigInt(filter.fromBlock) <= 9n)
    }
  })
})

describe('transfers transport', () => {
  const BLOCK = 71299072n
  const BLOCK_HEX = '0x43ff000'
  const TS_ISO = '2026-09-24T10:05:00.000Z'
  const TS_SEC = Math.floor(Date.parse(TS_ISO) / 1000)

  function transfersPage(items, pageKey) {
    return {
      jsonrpc: '2.0',
      id: 1,
      result: { transfers: items, ...(pageKey ? { pageKey } : {}) },
    }
  }

  function dripTransfer(hash = '0xtx1') {
    return { hash, blockNum: BLOCK_HEX, metadata: { blockTimestamp: TS_ISO } }
  }

  function dripReceipt(txHash = '0xtx1') {
    return {
      logs: [
        burnLog({ blockNumber: BLOCK, logIndex: 3n, ethWei: 10n ** 15n, fuelWei: 5n * 10n ** 20n, txHash }),
      ],
    }
  }

  it('finds drips via transfers + receipts and advances the watermark', async () => {
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '71299070', last_run_ts: 1, status: 'ok' }))
    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body)
      assert.equal(payload.method, 'alchemy_getAssetTransfers')
      const params = payload.params[0]
      assert.deepEqual(params.contractAddresses, ['0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'])
      assert.equal(params.fromAddress, FUEL_BURNER)
      assert.equal(params.toAddress, '0x0000000000000000000000000000000000000000')
      assert.equal(params.fromBlock, '0x43fefff')
      assert.equal(params.toBlock, '0x43ff008')
      return Response.json(transfersPage([dripTransfer()]))
    }
    const chain = fakeChain({ head: 71299080n, receiptsMap: new Map([['0xtx1', dripReceipt()]]) })
    const res = await runBurnCollector(
      { ACTIVITY: kv },
      { fetchImpl, chain, deadline: Date.now() + 60000, transports: ['transfers'] },
    )
    assert.equal(res.ok, true)
    assert.equal(res.transport, 'transfers')
    assert.equal(res.dripsScanned, 1)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '71299080')
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.totals.drips, 1)
    assert.equal(series.days.length, 1)
    assert.equal(series.days[0].date, '2026-09-24')
    assert.ok(Math.abs(series.days[0].fuel - 500) < 1e-6)
  })

  it('follows transfers pagination across pages', async () => {
    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body)
      const params = payload.params[0]
      if (!params.pageKey) return Response.json(transfersPage([dripTransfer('0xtx1')], 'page-2'))
      assert.equal(params.pageKey, 'page-2')
      return Response.json(transfersPage([dripTransfer('0xtx2')]))
    }
    const chain = fakeChain({
      receiptsMap: new Map([
        ['0xtx1', dripReceipt('0xtx1')],
        ['0xtx2', dripReceipt('0xtx2')],
      ]),
    })
    const { drips, tsByBlock } = await fetchBurnDripsViaTransfers({
      fetchImpl,
      rpcUrls: ['https://provider.test/x'],
      chain,
      fromBlock: 71299070n,
      toBlock: 71299080n,
    })
    assert.equal(drips.length, 2)
    assert.equal(tsByBlock.get(BLOCK.toString()), TS_SEC)
  })

  it('skips a transfer whose tx carries no BuyAndBurn event (never invents)', async () => {
    const fetchImpl = async () => Response.json(transfersPage([dripTransfer()]))
    const chain = fakeChain({ receiptsMap: new Map([['0xtx1', { logs: [] }]]) })
    const { drips } = await fetchBurnDripsViaTransfers({
      fetchImpl,
      rpcUrls: ['https://provider.test/x'],
      chain,
      fromBlock: 71299070n,
      toBlock: 71299080n,
    })
    assert.equal(drips.length, 0)
  })

  it('treats a malformed transfers response as unsupported (not zero drips)', async () => {
    const fetchImpl = async () => Response.json({ jsonrpc: '2.0', id: 1, result: null })
    const chain = fakeChain({})
    await assert.rejects(
      () => fetchBurnDripsViaTransfers({ fetchImpl, rpcUrls: ['https://provider.test/x'], chain, fromBlock: 1n, toBlock: 2n }),
      /malformed response/,
    )
  })
})

describe('transport fallback chain', () => {
  it('falls back to the scan when transfers is unsupported (-32601) and blockscout is challenged', async () => {
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '69999999', last_run_ts: 1, status: 'ok' }))
    const ts = new Map([['70000005', 1790035200]])
    const chain = fakeChain({
      logs: [burnLog({ blockNumber: 70000005n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 10n ** 21n })],
      timestamps: ts,
      head: 70000030n,
    })
    const fetchImpl = async (url, init) => {
      if (!init?.body) return new Response('challenge', { status: 403 })
      const payload = JSON.parse(init.body)
      if (payload.method === 'alchemy_getAssetTransfers') {
        return Response.json({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'Method not found' } })
      }
      throw new Error('unexpected RPC method ' + payload.method)
    }
    const res = await runBurnCollector({ ACTIVITY: kv }, { fetchImpl, chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, true)
    assert.equal(res.transport, 'scan')
    assert.equal(res.dripsScanned, 1)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '70000030')
  })

  it('records all-transports-failed without moving the watermark when everything fails', async () => {
    const kv = fakeKv()
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '69497245', last_run_ts: 1, status: 'ok' }))
    const chain = fakeChain({ head: 69500000n })
    chain.logsBatched = async () => {
      throw new Error('boom')
    }
    const fetchImpl = async () => new Response('nope', { status: 500 })
    const res = await runBurnCollector({ ACTIVITY: kv }, { fetchImpl, chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'all-transports-failed')
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '69497245')
    assert.equal(meta.status, 'error')
    assert.equal(meta.reason, 'all-transports-failed')
  })
})

describe('blockscout transport', () => {
  function bsItem(overrides = {}) {
    return {
      block_number: 71299072,
      index: 3,
      transaction_hash: '0xtx1',
      timestamp: '2026-09-24T10:05:00.000Z',
      topics: [
        BUY_AND_BURN_TOPIC,
        '0x' + (10n ** 15n).toString(16).padStart(64, '0'),
        '0x' + (5n * 10n ** 20n).toString(16).padStart(64, '0'),
        '0x' + '11'.repeat(20).padStart(64, '0'),
      ],
      ...overrides,
    }
  }

  it('maps explorer log items into decodable drips', async () => {
    const fetchImpl = async (url) => {
      assert.ok(String(url).includes('/api/v2/addresses/'))
      assert.ok(String(url).includes(`topic0=${BUY_AND_BURN_TOPIC}`))
      return Response.json({ items: [bsItem()], next_page_params: null })
    }
    const { logs, tsByBlock } = await fetchBurnLogsBlockscout({ fetchImpl, fromBlock: 71299070n, toBlock: 71299080n })
    assert.equal(logs.length, 1)
    const drip = decodeBurnLog(logs[0])
    assert.ok(drip)
    assert.equal(drip.fuelWei, 5n * 10n ** 20n)
    assert.equal(drip.dripId, '71299072:3')
    assert.equal(tsByBlock.get('71299072'), Math.floor(Date.parse('2026-09-24T10:05:00.000Z') / 1000))
  })

  it('throws on a challenge/403 so the caller falls through', async () => {
    const fetchImpl = async () => new Response('Just a moment...', { status: 403 })
    await assert.rejects(
      () => fetchBurnLogsBlockscout({ fetchImpl, fromBlock: 1n, toBlock: 2n }),
      /blockscout HTTP 403/,
    )
  })

  it('stops paginating once items fall below fromBlock', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(String(url))
      if (calls.length === 1) {
        return Response.json({
          items: [bsItem()],
          next_page_params: { block_number: 71299000, index: 0, items_count: 50 },
        })
      }
      return Response.json({ items: [bsItem({ block_number: 71298000 })], next_page_params: null })
    }
    const { logs } = await fetchBurnLogsBlockscout({ fetchImpl, fromBlock: 71299070n, toBlock: 71299080n })
    assert.equal(logs.length, 1)
    assert.equal(calls.length, 2)
  })
})
