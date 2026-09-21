import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYTICS_EVENTS,
  ANALYTICS_KEY_PREFIX,
  flushAnalytics,
  handleAnalyticsEvent,
  handleAnalyticsSummary,
  resetAnalyticsForTests,
} from './analytics.mjs'

const today = () => new Date().toISOString().slice(0, 10)

function kv() {
  const store = new Map()
  const calls = { puts: 0 }
  return {
    calls,
    async get(key) { return store.has(key) ? store.get(key) : null },
    async put(key, value) { calls.puts += 1; store.set(key, value) },
    read(key) { return store.get(key) },
  }
}

const post = event => new Request('https://radar.test/api/analytics', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(event === undefined ? {} : { event }),
})

describe('POST /api/analytics', () => {
  beforeEach(() => resetAnalyticsForTests())

  it('accepts every listed event with 204 and an empty body', async () => {
    for (const event of ANALYTICS_EVENTS) {
      const response = await handleAnalyticsEvent(post(event), { ACTIVITY: kv() })
      assert.equal(response.status, 204)
      assert.equal(await response.text(), '')
    }
  })

  it('rejects unknown, missing, and non-string events with 400', async () => {
    for (const payload of [{ event: 'clicked' }, { event: 42 }, {}, undefined]) {
      const response = await handleAnalyticsEvent(post(payload?.event), { ACTIVITY: kv() })
      assert.equal(response.status, 400, JSON.stringify(payload))
    }
  })

  it('rejects malformed JSON with 400', async () => {
    const request = new Request('https://radar.test/api/analytics', { method: 'POST', body: 'not-json{' })
    assert.equal((await handleAnalyticsEvent(request, { ACTIVITY: kv() })).status, 400)
  })

  it('never stores anything but known event counts (no PII)', async () => {
    const store = kv()
    const env = { ACTIVITY: store }
    const request = new Request('https://radar.test/api/analytics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.7',
        'User-Agent': 'TestAgent/1.0',
      },
      body: JSON.stringify({ event: 'view_selected', address: '0x1234567890abcdef1234567890abcdef12345678', ip: '203.0.113.7' }),
    })
    assert.equal((await handleAnalyticsEvent(request, env)).status, 204)
    await flushAnalytics(env)
    const stored = JSON.parse(store.read(`${ANALYTICS_KEY_PREFIX}${today()}`))
    assert.deepEqual(Object.keys(stored).sort(), ['view_selected'])
    assert.equal(stored.view_selected, 1)
    assert.ok(!JSON.stringify(stored).includes('0x1234') && !JSON.stringify(stored).includes('203.0.113.7'))
  })

  it('merges in-memory counts into the stored summary instead of overwriting', async () => {
    const store = kv()
    const env = { ACTIVITY: store }
    await store.put(`${ANALYTICS_KEY_PREFIX}${today()}`, JSON.stringify({ view_selected: 3, wallet_lookup: 2 }))
    await handleAnalyticsEvent(post('view_selected'), env)
    await handleAnalyticsEvent(post('view_selected'), env)
    await handleAnalyticsEvent(post('chart_rendered'), env)
    await flushAnalytics(env)
    assert.deepEqual(JSON.parse(store.read(`${ANALYTICS_KEY_PREFIX}${today()}`)), {
      view_selected: 5,
      wallet_lookup: 2,
      chart_rendered: 1,
    })
  })

  it('writes to KV at most once per flush interval', async () => {
    const store = kv()
    const env = { ACTIVITY: store }
    for (let i = 0; i < 10; i++) await handleAnalyticsEvent(post('refresh_clicked'), env)
    assert.equal(store.calls.puts, 0)
    await flushAnalytics(env)
    assert.equal(store.calls.puts, 1)
  })

  it('resets in-memory counts after a flush so nothing is double-counted', async () => {
    const store = kv()
    const env = { ACTIVITY: store }
    await handleAnalyticsEvent(post('refresh_clicked'), env)
    await flushAnalytics(env)
    await flushAnalytics(env)
    assert.deepEqual(JSON.parse(store.read(`${ANALYTICS_KEY_PREFIX}${today()}`)), { refresh_clicked: 1 })
  })

  it('returns 204 even when KV is unavailable', async () => {
    assert.equal((await handleAnalyticsEvent(post('view_selected'), {})).status, 204)
    await flushAnalytics({})
  })
})

describe('GET /api/analytics/summary', () => {
  const get = query => new Request(`https://radar.test/api/analytics/summary${query ?? ''}`)

  it('returns 404 unless ANALYTICS_PRIVATE is set to 1', async () => {
    for (const env of [{}, { ANALYTICS_PRIVATE: '0' }, { ANALYTICS_PRIVATE: 'true' }]) {
      assert.equal((await handleAnalyticsSummary(get(), env)).status, 404)
    }
  })

  it('returns per-day summaries with the default of 7 days', async () => {
    const store = kv()
    await store.put(`${ANALYTICS_KEY_PREFIX}${today()}`, JSON.stringify({ view_selected: 4 }))
    const response = await handleAnalyticsSummary(get(), { ANALYTICS_PRIVATE: '1', ACTIVITY: store })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.days.length, 7)
    assert.equal(payload.days[0].date, today())
    assert.deepEqual(payload.days[0].counts, { view_selected: 4 })
    assert.ok(payload.days.every(day => typeof day.date === 'string' && day.counts && typeof day.counts === 'object'))
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  })

  it('honors days within 1..30 and rejects anything else', async () => {
    const env = { ANALYTICS_PRIVATE: '1', ACTIVITY: kv() }
    assert.equal((await (await handleAnalyticsSummary(get('?days=1'), env)).json()).days.length, 1)
    assert.equal((await (await handleAnalyticsSummary(get('?days=30'), env)).json()).days.length, 30)
    for (const bad of ['?days=0', '?days=31', '?days=abc', '?days=2.5', '?days=']) {
      assert.equal((await handleAnalyticsSummary(get(bad), env)).status, 400, bad)
    }
  })

  it('reports empty days instead of failing when KV is unavailable', async () => {
    const response = await handleAnalyticsSummary(get('?days=2'), { ANALYTICS_PRIVATE: '1' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      days: [
        { date: today(), counts: {} },
        { date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), counts: {} },
      ],
    })
  })
})
