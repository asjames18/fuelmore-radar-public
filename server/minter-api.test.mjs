import { it } from 'node:test'
import assert from 'node:assert/strict'
import { handleMintersRequest, handleFlowsDailyRequest, handleBurnsRequest } from './minter-api.mjs'

function fakeKv(entries = {}) {
  const store = new Map(Object.entries(entries))
  return {
    async get(key, type) {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async list({ prefix, cursor, limit = 1000 } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const slice = names.slice(start, start + limit)
      const next = start + slice.length
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: next >= names.length,
        cursor: String(next),
      }
    },
  }
}

const rowA = {
  wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  claimed: '100111555000000000000000000',
  sold: '100111555000000000000000000',
  bought: '2096000000000000000000',
  pct_sold: 100,
  mints_opened: '295',
  remint_count: '245',
  remint_eth_wei: '77049731250000000',
  first_claim_ts: 1758492903,
  first_sale_ts: 1758492904,
  last_active_ts: 1758493000,
  updated_block: '69250587',
}
const rowB = {
  wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  claimed: '50909350000000000000000000',
  sold: '50909350000000000000000000',
  bought: '2389000000000000000000',
  pct_sold: 100,
  mints_opened: '150',
  remint_count: '100',
  remint_eth_wei: '31414275000000000',
  first_claim_ts: 1758499415,
  first_sale_ts: 1758499416,
  last_active_ts: 1758499500,
  updated_block: '69250587',
}
const meta = {
  last_block: '69250587',
  last_run_ts: 1758499600,
  status: 'ok',
  backfill_done: true,
}

function kvWithRows() {
  return fakeKv({
    'minter:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': JSON.stringify(rowA),
    'minter:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': JSON.stringify(rowB),
    'meta:minter-collector': JSON.stringify(meta),
    'flows:daily:2026-09-21': JSON.stringify({
      date: '2026-09-21',
      buyers: [
        { w: '0xaa6bef47484a72aafd0a37361cbedb1fbace6dc6', fuel: '72000000000000000000000000', usd: 450 },
      ],
      sellers: [
        { w: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fuel: '100111555000000000000000000', usd: 620 },
        { w: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fuel: '50909350000000000000000000', usd: null },
      ],
      buy_vol_usd: 1200,
      sell_vol_usd: 900,
      usd_missing: 3,
      n_buys: 396,
      n_sells: 362,
      last_block: '69250587',
    }),
  })
}

const req = (path) => new Request(`https://radar.test${path}`, { method: 'GET' })

it('returns minter rows sorted by sold desc by default', async () => {
  const res = await handleMintersRequest(req('/api/minters'), kvWithRows())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.count, 2)
  assert.equal(body.rows[0].wallet, rowA.wallet)
  assert.equal(body.rows[1].wallet, rowB.wallet)
  assert.equal(body.rows[0].claimed, 100111555)
  assert.equal(body.rows[0].pct_sold, 100)
  assert.equal(body.rows[0].remint_count, 245)
  assert.ok(Math.abs(body.rows[0].remint_eth - 0.07704973125) < 1e-12)
  assert.equal(typeof body.methodology, 'string')
  assert.ok(body.methodology.length > 50)
  assert.equal(body.through_block, '69250587')
  assert.equal(body.through_time, new Date(1758499600 * 1000).toISOString())
})

it('supports sort, dir and limit params', async () => {
  const res = await handleMintersRequest(req('/api/minters?sort=claimed&dir=asc&limit=1'), kvWithRows())
  const body = await res.json()
  assert.equal(body.rows.length, 1)
  // asc by claimed: rowB (50.9M) before rowA (100.1M) — but limit=1 takes the first
  assert.equal(body.rows[0].wallet, rowB.wallet)
})

it('rejects unknown sort keys by falling back to default', async () => {
  const res = await handleMintersRequest(req('/api/minters?sort=wallet'), kvWithRows())
  const body = await res.json()
  assert.equal(body.rows[0].wallet, rowA.wallet)
})

it('reports collecting with empty rows when KV has no minter data', async () => {
  const res = await handleMintersRequest(req('/api/minters'), fakeKv({}))
  const body = await res.json()
  assert.equal(body.status, 'collecting')
  assert.deepEqual(body.rows, [])
  assert.equal(body.through_block, null)
})

it('returns 503 when KV is unavailable', async () => {
  const res = await handleMintersRequest(req('/api/minters'), null)
  assert.equal(res.status, 503)
})

it('returns the daily leaderboard for a given date', async () => {
  const res = await handleFlowsDailyRequest(req('/api/flows/daily?date=2026-09-21'), kvWithRows())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.date, '2026-09-21')
  assert.equal(body.sellers.length, 2)
  assert.equal(body.sellers[0].wallet, rowA.wallet)
  assert.equal(body.sellers[0].fuel, 100111555)
  assert.equal(body.buyers[0].fuel, 72000000)
  assert.equal(body.n_buys, 396)
  assert.equal(body.n_sells, 362)
  assert.equal(body.usd_missing, 3)
  assert.equal(typeof body.note, 'string')
  assert.equal(body.through_block, '69250587')
})

it('keeps null USD on entries that could not be calibrated', async () => {
  const res = await handleFlowsDailyRequest(req('/api/flows/daily?date=2026-09-21'), kvWithRows())
  const body = await res.json()
  assert.equal(body.sellers[1].usd, null)
  assert.equal(body.sellers[1].fuel, 50909350)
})

it('reports collecting for a date with no data', async () => {
  const res = await handleFlowsDailyRequest(req('/api/flows/daily?date=2026-01-01'), kvWithRows())
  const body = await res.json()
  assert.equal(body.status, 'collecting')
  assert.deepEqual(body.buyers, [])
  assert.equal(body.buy_vol_usd, null)
})

it('rejects malformed dates', async () => {
  const res = await handleFlowsDailyRequest(req('/api/flows/daily?date=yesterday'), kvWithRows())
  assert.equal(res.status, 400)
})

it('defaults to today in America/New_York', async () => {
  const expected = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const res = await handleFlowsDailyRequest(req('/api/flows/daily'), kvWithRows())
  const body = await res.json()
  assert.equal(body.date, expected)
})

function kvWithBurns() {
  return fakeKv({
    'burns:daily': JSON.stringify({
      version: 1,
      days: [
        { date: '2026-09-21', fuel: 527410.98, eth: 0.00972, drips: 19, dripIds: [] },
        { date: '2026-09-22', fuel: 3869754.35, eth: 0.003613, drips: 7, dripIds: [] },
      ],
      totals: { fuel: 4397165.33, eth: 0.013333, drips: 26 },
      watermark_block: '69530000',
      updated_at: '2026-09-22T09:00:00.000Z',
    }),
    'meta:burn-collector': JSON.stringify({
      last_block: '69530000',
      last_run_ts: 1758525600,
      status: 'ok',
    }),
  })
}

it('serves the daily burn series with totals and methodology', async () => {
  const res = await handleBurnsRequest(req('/api/burns'), kvWithBurns())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.days.length, 2)
  assert.equal(body.days[0].date, '2026-09-21')
  assert.equal(body.days[0].fuel, 527410.98)
  assert.equal(body.days[0].eth, 0.00972)
  assert.equal(body.days[0].drips, 19)
  assert.equal(body.totals.fuel, 4397165.33)
  assert.equal(body.totals.drips, 26)
  assert.equal(typeof body.methodology, 'string')
  assert.ok(body.methodology.includes('token.burn()'))
  assert.equal(body.through_block, '69530000')
  assert.ok(!('dripIds' in body.days[0]), 'internal drip ids are not exposed')
})

it('reports collecting when the burn series is missing', async () => {
  const res = await handleBurnsRequest(req('/api/burns'), fakeKv({}))
  const body = await res.json()
  assert.equal(body.status, 'collecting')
  assert.deepEqual(body.days, [])
  assert.equal(body.totals.fuel, null)
  assert.equal(typeof body.methodology, 'string')
})

it('returns 503 when KV is unavailable', async () => {
  const res = await handleBurnsRequest(req('/api/burns'), null)
  assert.equal(res.status, 503)
})
