/** Privacy-respecting usage counters for the FUEL / MORE Radar.
 *
 * Counts only: event names are aggregated per UTC day. Wallet addresses, IPs,
 * user agents, and any other identifier are never read, stored, or forwarded.
 *
 * Aggregation happens in Worker memory per isolate. D1 (the snapshots table)
 * is written at most once every 5 minutes per isolate.
 */

import { storeGet, storePut } from './d1-store.mjs'

export const ANALYTICS_EVENTS = [
  'view_selected',
  'cockpit_open',
  'wallet_lookup',
  'chart_rendered',
  'refresh_clicked',
  'donate_clicked',
  'contract_copied',
]

export const ANALYTICS_KEY_PREFIX = 'analytics-v1:'
export const ANALYTICS_FLUSH_MS = 5 * 60 * 1000

const utcDate = () => new Date().toISOString().slice(0, 10)

// Per-isolate aggregation state: { date, counts: { event: n }, lastFlush }
let state = null

export function resetAnalyticsForTests() {
  state = null
}

function freshState() {
  return { date: utcDate(), counts: {}, lastFlush: Date.now() }
}

// Read-modify-write ONE summary key under the state's UTC date, merging the
// in-memory counts into the stored JSON and resetting. Counts stay best-effort:
// a missing or corrupt KV binding must never fail an analytics request.
export async function flushAnalytics(env) {
  if (!state) return
  const key = `${ANALYTICS_KEY_PREFIX}${state.date}`
  let stored = {}
  try {
    const raw = await storeGet(env, key)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    }
  } catch {
    /* Corrupt summaries are replaced by fresh counts. */
  }
  for (const [event, count] of Object.entries(state.counts)) {
    if (!ANALYTICS_EVENTS.includes(event) || !Number.isSafeInteger(count) || count <= 0) continue
    const existing = stored[event]
    stored[event] = (Number.isSafeInteger(existing) && existing > 0 ? existing : 0) + count
  }
  state.counts = {}
  state.lastFlush = Date.now()
  if (Object.keys(stored).length) {
    try {
      await storePut(env, key, JSON.stringify(stored))
    } catch {
      /* Analytics never breaks the request path. */
    }
  }
}

/** POST /api/analytics — body must be JSON { event } with a known event name. */
export async function handleAnalyticsEvent(request, env) {
  let event = null
  try {
    const body = await request.json()
    event = body && typeof body === 'object' ? body.event : null
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (typeof event !== 'string' || !ANALYTICS_EVENTS.includes(event)) {
    return Response.json({ error: 'Unknown event' }, { status: 400 })
  }
  if (!state) state = freshState()
  if (state.date !== utcDate()) {
    // Flush yesterday's counts under the previous UTC date before rolling over.
    await flushAnalytics(env)
    state.date = utcDate()
  }
  state.counts[event] = (state.counts[event] || 0) + 1
  if (Date.now() - state.lastFlush >= ANALYTICS_FLUSH_MS) await flushAnalytics(env)
  return new Response(null, { status: 204 })
}

/** GET /api/analytics/summary?days=N — private only, gated on the env flag. */
export async function handleAnalyticsSummary(request, env) {
  if (env.ANALYTICS_PRIVATE !== '1') return Response.json({ error: 'Not found' }, { status: 404 })
  const url = new URL(request.url)
  const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 7
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return Response.json({ error: 'days must be an integer from 1 to 30' }, { status: 400 })
  }
  const summaries = []
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    let counts = {}
    try {
      const raw = await storeGet(env, `${ANALYTICS_KEY_PREFIX}${date}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) counts = parsed
      }
    } catch {
      /* Unreadable days surface as empty. */
    }
    summaries.push({ date, counts })
  }
  return Response.json({ days: summaries }, { headers: { 'Cache-Control': 'no-store' } })
}
