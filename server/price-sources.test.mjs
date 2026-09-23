import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRetryAfterMs, fetchJsonWithRetry } from './price-sources.mjs'

test('parseRetryAfterMs honors positive seconds and clamps to the max', () => {
  assert.equal(parseRetryAfterMs('2'), 2_000)
  assert.equal(parseRetryAfterMs('30'), 30_000)
  // 120s would stall the cron; clamped to the 30s max
  assert.equal(parseRetryAfterMs('120'), 30_000)
})

test('parseRetryAfterMs treats zero/negative/empty as absent (fall back to backoff)', () => {
  assert.equal(parseRetryAfterMs('0'), null)
  assert.equal(parseRetryAfterMs('-5'), null)
  assert.equal(parseRetryAfterMs(''), null)
  assert.equal(parseRetryAfterMs('   '), null)
  assert.equal(parseRetryAfterMs(null), null)
  assert.equal(parseRetryAfterMs(undefined), null)
  assert.equal(parseRetryAfterMs('not-a-delay'), null)
})

test('parseRetryAfterMs honors a future HTTP date, ignores the past', () => {
  const future = new Date(Date.now() + 5_000).toUTCString()
  const ms = parseRetryAfterMs(future)
  assert.ok(ms > 0 && ms <= 30_000, `expected positive clamped delay, got ${ms}`)
  const past = new Date(Date.now() - 60_000).toUTCString()
  assert.equal(parseRetryAfterMs(past), null)
})

test('fetchJsonWithRetry uses exponential backoff when Retry-After is 0', async () => {
  const delays = []
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => (name === 'Retry-After' ? '0' : null) },
  })
  const sleep = async (ms) => {
    delays.push(ms)
  }
  await assert.rejects(
    () =>
      fetchJsonWithRetry('https://example.invalid/x', {
        pairKey: 'fuel',
        source: 'test',
        label: 'test source',
        fetchImpl,
        sleep,
      }),
    /HTTP 429/,
  )
  // attempt 1 -> 1000ms, attempt 2 -> 2000ms (never 0ms)
  assert.deepEqual(delays, [1_000, 2_000])
})
