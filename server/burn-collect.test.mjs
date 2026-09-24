import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FUEL_BURNER,
  BUY_AND_BURN_TOPIC,
  BURNS_KEY,
  BURN_META_KEY,
  decodeBurnLog,
  utcDate,
  aggregateDripsDetail,
  mergeBurnSeries,
  runBurnCollector,
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

function fakeChain({ logs = [], timestamps = new Map(), head = 70000100n }) {
  const seenBatches = []
  return {
    seenBatches,
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
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
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
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, true)
    assert.equal(res.dripsScanned, 0)
    assert.deepEqual(kv.writes, [BURN_META_KEY])
  })

  it('does not double-count drips when re-scanning an overlapping range', async () => {
    const kv = fakeKv()
    const ts = new Map([['70000010', 1790035200]])
    const log = burnLog({ blockNumber: 70000010n, logIndex: 0n, ethWei: 10n ** 15n, fuelWei: 10n ** 21n })
    const chain = fakeChain({ logs: [log], timestamps: ts, head: 70000020n })
    const first = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
    assert.equal(first.ok, true)
    // Simulate a watermark rewind (retry of the same range): the same drip
    // is scanned again but must not be counted twice.
    const chain2 = fakeChain({ logs: [log], timestamps: ts, head: 70000020n })
    // Force the watermark back by hand-writing an older meta.
    await kv.put(BURN_META_KEY, JSON.stringify({ last_block: '70000009', last_run_ts: 1, status: 'ok' }))
    kv.writes.length = 0
    const second = await runBurnCollector({ ACTIVITY: kv }, { chain: chain2, deadline: Date.now() + 60000 })
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
      assert.ok(args.batchCalls <= 40, 'batch exceeds 40 calls')
      return origLogsBatched(args)
    }
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, true)
    // The scan is packed for both caps: contiguous 10-block ranges from
    // watermark+1 to head, batched for one subrequest per 40 ranges.
    const seenRanges = chain.seenBatches.flat().map(([from, to]) => ({ from, to }))
    assert.ok(seenRanges.length > 1)
    assert.equal(seenRanges[0].from.toString(), '69497246')
    assert.equal(seenRanges.at(-1).to.toString(), '69497300')
    for (let i = 0; i < seenRanges.length; i++) {
      const r = seenRanges[i]
      assert.ok(r.to - r.from < 10n, `range ${i} exceeds 10 blocks`)
      if (i > 0) assert.equal(r.from.toString(), (seenRanges[i - 1].to + 1n).toString())
    }
    for (const b of chain.seenBatches) assert.ok(b.length <= 40, 'batch exceeds 40 calls')
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.totals.drips, 3)
    assert.ok(Math.abs(series.totals.fuel - 1500) < 1e-6)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '69497300')
  })
})

describe('provider log-range chunking', () => {
  it('scans in batched 10-block ranges and merges across them', async () => {
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
    const res = await runBurnCollector({ ACTIVITY: kv }, { chain, deadline: Date.now() + 60000 })
    assert.equal(res.ok, true)
    assert.equal(res.dripsScanned, 2)
    // One batched call: 70000000..70000030 is 31 blocks -> 4 ranges of
    // <=10 blocks in a single batch (one subrequest).
    assert.equal(batchedArgs.rangeBlocks, 10n)
    assert.equal(batchedArgs.batchCalls, 40)
    assert.equal(chain.seenBatches.length, 1)
    assert.equal(chain.seenBatches[0].length, 4)
    const ranges = chain.seenBatches[0]
    assert.equal(ranges[0][0].toString(), '70000000')
    assert.equal(ranges.at(-1)[1].toString(), '70000030')
    for (const [s, e] of ranges) assert.ok(e - s < 10n, 'range exceeds 10 blocks')
    const series = await kv.get(BURNS_KEY, 'json')
    assert.equal(series.totals.drips, 2)
    const meta = await kv.get(BURN_META_KEY, 'json')
    assert.equal(meta.last_block, '70000030')
  })
})
