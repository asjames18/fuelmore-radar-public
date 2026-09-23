import { it } from 'node:test'
import assert from 'node:assert/strict'
import { WATCHDOG, checkPipelineFreshness } from './watchdog.mjs'

const T0 = Date.parse('2026-09-21T14:30:00.000Z')
const iso = minutesAgo => new Date(T0 - minutesAgo * 60_000).toISOString()
const dashboard = minutesAgo => JSON.stringify({ version: 1, chainId: 4663, data: { updatedAt: iso(minutesAgo) } })
const activity = minutesAgo => JSON.stringify({ generatedAt: iso(minutesAgo) })

function makeKv(values = {}) {
  const store = new Map(Object.entries(values))
  return {
    store,
    get: async key => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, value) },
  }
}

// Minimal D1 stand-in: prepare(sql).bind(key).first() -> { value } | null.
function makeDb(values = {}, { fail = false } = {}) {
  return {
    prepare: () => ({
      bind: key => ({
        first: async () => {
          if (fail) throw new Error('d1 down')
          return key in values ? { value: values[key] } : null
        },
      }),
    }),
  }
}

function makeEnv(kv, token = 'ghp-test-token') {
  return { ACTIVITY: kv, [WATCHDOG.secretName]: token }
}

const base = () => ({ now: () => T0, fetchImpl: async () => { throw new Error('must not fetch') } })

it('does nothing when both snapshots are fresh', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(20), [WATCHDOG.activityKey]: activity(25) })
  let fetched = false
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }) } })
  assert.deepEqual(result, { checked: true, stale: false, dispatched: false, ages: { dashboard: 20, activity: 25 }, reason: 'fresh' })
  assert.equal(fetched, false)
})

it('dispatches a main-ref run when snapshots exceed the staleness threshold', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(310) })
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return new Response(null, { status: 204 })
  }
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl })
  assert.equal(result.checked, true)
  assert.equal(result.stale, true)
  assert.equal(result.dispatched, true)
  assert.equal(result.reason, 'dispatched')
  assert.equal(seen.url, 'https://api.github.com/repos/asjames18/fuelmore-radar/actions/workflows/refresh-activity.yml/dispatches')
  assert.equal(seen.init.method, 'POST')
  assert.equal(JSON.parse(seen.init.body).ref, 'main')
  assert.ok(seen.init.headers.Authorization.startsWith('Bearer '))
  assert.equal(kv.store.get(WATCHDOG.lastDispatchKey), iso(0))
})

it('treats a missing snapshot as stale and dispatches', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(10) })
  let fetched = false
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }) } })
  assert.equal(result.stale, true)
  assert.equal(result.dispatched, true)
  assert.equal(fetched, true)
})

it('respects the cooldown after a recent dispatch', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(300), [WATCHDOG.lastDispatchKey]: iso(30) })
  let fetched = false
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }) } })
  assert.equal(result.dispatched, false)
  assert.equal(result.reason, 'cooldown')
  assert.equal(fetched, false)
})

it('dispatches again after the cooldown expires', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(300), [WATCHDOG.lastDispatchKey]: iso(90) })
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => new Response(null, { status: 204 }) })
  assert.equal(result.dispatched, true)
  assert.equal(result.reason, 'dispatched')
})

it('does nothing but report when the dispatch token is missing', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(300) })
  let fetched = false
  const result = await checkPipelineFreshness({ ACTIVITY: kv }, { ...base(), fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }) } })
  assert.equal(result.stale, true)
  assert.equal(result.dispatched, false)
  assert.equal(result.reason, 'token-missing')
  assert.equal(fetched, false)
})

it('does not record a dispatch or claim success on non-204 responses', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(300) })
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => new Response('nope', { status: 401 }) })
  assert.equal(result.dispatched, false)
  assert.equal(result.reason, 'dispatch-failed')
  assert.equal(kv.store.has(WATCHDOG.lastDispatchKey), false)
})

it('never throws when the GitHub API call fails', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(300) })
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => { throw new Error('network down') } })
  assert.equal(result.dispatched, false)
  assert.equal(result.reason, 'dispatch-failed')
})

it('reports unavailable when no storage binding exists', async () => {
  const result = await checkPipelineFreshness({}, base())
  assert.deepEqual(result, { checked: false, stale: false, dispatched: false, ages: { dashboard: null, activity: null }, reason: 'storage-unavailable' })
})

it('prefers D1 snapshots over stale KV mirrors', async () => {
  // Regression test for the post-2026-09-22 world: the publisher writes D1
  // only, so KV mirrors are permanently stale. The watchdog must read the
  // store the publisher actually writes, not KV alone.
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(3000), [WATCHDOG.activityKey]: activity(3000) })
  const db = makeDb({ [WATCHDOG.dashboardKey]: dashboard(20), [WATCHDOG.activityKey]: activity(25) })
  let fetched = false
  const env = { ...makeEnv(kv), DB: db }
  const result = await checkPipelineFreshness(env, { ...base(), fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }) } })
  assert.deepEqual(result, { checked: true, stale: false, dispatched: false, ages: { dashboard: 20, activity: 25 }, reason: 'fresh' })
  assert.equal(fetched, false)
})

it('falls back to KV when the D1 read fails', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: dashboard(300), [WATCHDOG.activityKey]: activity(300) })
  const db = makeDb({}, { fail: true })
  const env = { ...makeEnv(kv), DB: db }
  const result = await checkPipelineFreshness(env, { ...base(), fetchImpl: async () => new Response(null, { status: 204 }) })
  assert.equal(result.stale, true)
  assert.equal(result.dispatched, true)
  assert.equal(result.reason, 'dispatched')
})

it('ignores a corrupt snapshot body and treats it as stale', async () => {
  const kv = makeKv({ [WATCHDOG.dashboardKey]: 'not-json{{{', [WATCHDOG.activityKey]: activity(10) })
  let fetched = false
  const result = await checkPipelineFreshness(makeEnv(kv), { ...base(), fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }) } })
  assert.equal(result.stale, true)
  assert.equal(result.dispatched, true)
  assert.equal(fetched, true)
})
