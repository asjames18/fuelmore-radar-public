import { resolveRpcUrl } from './rpc-config.mjs'
import { loadReport, activityEnvelope } from './activity-edge.mjs'
import { findDisallowedRpcMethods } from './rpc-allowlist.mjs'
import { handleAnalyticsEvent, handleAnalyticsSummary } from './analytics.mjs'
import { handleCockpitRequest } from './cockpit-cache.mjs'
import { storeGet } from './d1-store.mjs'
import { handleMintersRequest, handleBurnsRequest, handleFlowsDailyRequest } from './minter-api.mjs'

import { createRpcBudget, validateReadBudget, fetchRpcWithinBudget, readLimitedBody } from './rpc-budget.mjs'
import { runMarketSnapshot, readMarketHistory } from './market-collect.mjs'
import { runBurnCollector } from './burn-collect.mjs'
import { runMinterCollector } from './minter-collect.mjs'
import { runDashboardSnapshot } from './dashboard-collect.mjs'
import { checkPipelineFreshness } from './watchdog.mjs'

const rpcCache = new Map()
const rpcBudget = createRpcBudget()

// Platform counters span isolates within a Cloudflare location. They are
// approximate abuse protection, not a global usage/billing quota.
async function platformReadLimit(request, env, units) {
  const unavailable = () => Response.json({jsonrpc:'2.0',id:null,error:{code:-32603,message:'RPC gateway protection unavailable; retry shortly'}},
    {status:503,headers:{'Access-Control-Allow-Origin':'*','Retry-After':'60','Cache-Control':'no-store'}})
  const ip=request.headers.get('CF-Connecting-IP')
  if(!ip || ip.length>128 || typeof env.RPC_RATE_LIMITER?.limit!=='function')return unavailable()
  try {
    // A JSON-RPC batch consumes one token per logical method, preventing batching
    // from multiplying the provider workload allowed by the platform limit.
    for(let i=0;i<units;i++) {
      const result=await env.RPC_RATE_LIMITER.limit({key:`radar-rpc:${ip}`})
      if(result?.success===false)return Response.json({jsonrpc:'2.0',id:null,error:{code:-32005,message:'Read limit reached; retry shortly'}},
        {status:429,headers:{'Access-Control-Allow-Origin':'*','Retry-After':'60','Cache-Control':'no-store'}})
      if(result?.success!==true)return unavailable()
    }
  } catch { return unavailable() }
  return null
}

async function serveActivity(request, env) {
  const loaded = await loadReport(env)
  const report = loaded.report


  if (report) {
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - report.throughTimestamp))
    return new Response(JSON.stringify(activityEnvelope(report, { source: loaded.source })), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30',
        'X-Activity-Source': loaded.source,
        'X-Activity-Age-Seconds': String(ageSeconds),
      },
    })
  }

  return new Response(JSON.stringify(activityEnvelope(null)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

const MINTER_META_KEY = 'meta:minter-collector'
const MINTER_COLLECTOR_INTERVAL_S = 3600
const MINTER_COLLECTOR_RETRY_S = 900

/**
 * Run the minter collector at most hourly. This cron fires every five minutes; the
 * collector is designed for hourly runs (100k-block per-run cap, watermarked
 * catch-up). A failed run records last_attempt_ts so the next tick backs off
 * instead of re-scanning every 5 minutes. Never throws.
 */
async function runMinterCollectorHourly(env) {
  try {
    let meta = null
    try {
      meta = await env.ACTIVITY?.get?.(MINTER_META_KEY, 'json')
    } catch { /* gating read is best-effort; a missing meta means run */ }
    const nowS = Math.floor(Date.now() / 1000)
    const lastRun = typeof meta?.last_run_ts === 'number' ? meta.last_run_ts : 0
    if (nowS - lastRun < MINTER_COLLECTOR_INTERVAL_S) return
    const lastAttempt = typeof meta?.last_attempt_ts === 'number' ? meta.last_attempt_ts : 0
    if (nowS - lastAttempt < MINTER_COLLECTOR_RETRY_S) return
    const result = await runMinterCollector(env)
    if (result?.ok) return
    console.error(JSON.stringify({ msg: 'minter-collector-error', reason: result?.reason ?? 'unknown' }))
    try {
      await env.ACTIVITY?.put?.(
        MINTER_META_KEY,
        JSON.stringify({ ...(meta && typeof meta === 'object' ? meta : {}), last_attempt_ts: nowS, status: 'error' }),
      )
    } catch { /* backoff marker is best-effort */ }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'minter-collector-error', error: err?.message ?? String(err) }))
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // Proxy RPC requests to Robinhood Chain RPC with deduplication and sanitized CORS headers
    if (url.pathname === '/rpc') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          },
        })
      }

      if (request.method === 'POST') {
        try {
          const body = await readLimitedBody(request)
          if (body === null) return new Response('RPC payload too large', { status: 413 })
          const now = Date.now()

          let parsed = null
          try {
            parsed = JSON.parse(body)
          } catch {
            return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, { headers: { "Access-Control-Allow-Origin": "*" } })
          }

          const items = Array.isArray(parsed) ? parsed : [parsed]
          if (!items.length || items.length > 100 || items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || item.jsonrpc !== '2.0' || typeof item.method !== 'string' || (item.params !== undefined && (!item.params || typeof item.params !== 'object')))) {
            return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request or batch (maximum 100)' } }, { headers: { 'Access-Control-Allow-Origin': '*' } })
          }
          const disallowed = findDisallowedRpcMethods(parsed)
          if (disallowed.length) {
            const errors = items.map(item => ({ jsonrpc: '2.0', id: item.id ?? null,
              error: { code: -32601, message: 'Batch or method not allowed on read-only proxy' } }))
            return Response.json(Array.isArray(parsed) ? errors : errors[0], {
              headers: { 'Access-Control-Allow-Origin': '*', 'X-Rpc-Proxy': 'denied' },
            })
          }

          const budgetError = validateReadBudget(items)
          if (budgetError) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32602, message: budgetError } }, { status: 400 })
          const platformLimit=await platformReadLimit(request,env,items.length)
          if(platformLimit)return platformLimit
          if (!rpcBudget.admit(request.headers.get('CF-Connecting-IP'), items.length)) {
            return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'Read limit reached; retry shortly' } }, { status: 429, headers: { 'Retry-After': '60' } })
          }
          const upstream = resolveRpcUrl(env)
          const isBatch = Array.isArray(parsed)
          const isCacheable = !isBatch && parsed?.method && ['eth_call', 'eth_blockNumber', 'eth_chainId'].includes(parsed.method)
          const cacheKey = isCacheable ? `${upstream}:${parsed.method}:${JSON.stringify(parsed.params ?? [])}` : null

          if (cacheKey) {
            const cached = rpcCache.get(cacheKey)
            const isPinnedCall = parsed?.method === 'eth_call'
              && typeof parsed?.params?.[1] === 'object' && parsed.params[1] !== null
              && typeof parsed.params[1].blockHash === 'string'
            const cacheTtlMs = isPinnedCall ? 600_000 : 8000
            if (cached && now - cached.timestamp < cacheTtlMs) {
              const resJson = { ...cached.json, id: parsed.id ?? null }
              return new Response(JSON.stringify(resJson), {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                  'X-Edge-Cache': 'HIT',
                },
              })
            }
          }

          const rpcRes = await rpcBudget.run(cacheKey, async () => {
            const result = await fetchRpcWithinBudget(upstream, body)
            // Validate against the originating request before sharing or remapping
            // the response to other callers of the same pinned read.
            const replies = Array.isArray(result.body) ? result.body : [result.body]
            if (Array.isArray(result.body) !== isBatch || replies.length !== items.length) throw new Error('RPC response shape mismatch')
            const remaining = items.map(item => item.id ?? null)
            for (const reply of replies) {
              if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Invalid RPC reply')
              const index = remaining.findIndex(id => id === reply.id)
              if (index < 0) throw new Error('RPC response ID mismatch')
              remaining.splice(index, 1)
            }
            return result
          })
          const upstreamBody = !isBatch && rpcRes.body && !Array.isArray(rpcRes.body)
            ? { ...rpcRes.body, id: parsed.id ?? null } : rpcRes.body
          const sanitize = item => {
            if (!item || item.jsonrpc !== '2.0' || (!('result' in item) && !item.error)) throw new Error('Invalid RPC response')
            return item.error
              ? { jsonrpc: '2.0', id: item.id ?? null, error: { code: Number.isInteger(item.error.code) ? item.error.code : -32603, message: 'RPC read failed; provider unavailable or contract read rejected' } }
              : { jsonrpc: '2.0', id: item.id ?? null, result: item.result }
          }
          const resBody = JSON.stringify(Array.isArray(upstreamBody) ? upstreamBody.map(sanitize) : sanitize(upstreamBody))
          const headers = new Headers({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })

          if (rpcRes.status === 200 && cacheKey) {
            try {
              const json = JSON.parse(resBody)
              if (!json.error) {
                rpcCache.set(cacheKey, { json, timestamp: now })
                if (rpcCache.size > 300) {
                  const oldestKey = rpcCache.keys().next().value
                  if (oldestKey) rpcCache.delete(oldestKey)
                }
              }
            } catch {}
          }

          return new Response(resBody, {
            status: rpcRes.status,
            headers,
          })
        } catch {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: 'RPC provider unavailable; retry shortly' },
            }),
            {
              status: 502,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            },
          )
        }
      }
    }

    if (url.pathname === '/rpc') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } })

    if (url.pathname === '/api/dashboard') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      try {
        const snapshot = await storeGet(env, 'dashboard-snapshot-v1')
        if (snapshot) return new Response(snapshot, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' } })
      } catch { /* Clients keep their saved snapshot with its original timestamps. */ }
      return Response.json({ error: 'Saved dashboard unavailable; waiting for scheduled sync' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }

    if (url.pathname === '/api/fuel-activity') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
      return serveActivity(request, env)
    }

    if (url.pathname === '/api/market-history') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      try {
        const points = await readMarketHistory(env)
        const last = points.at(-1)
        return Response.json(
          { updatedAt: last ? new Date(last.t * 1000).toISOString() : null, points },
          { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } },
        )
      } catch {
        return Response.json({ error: 'Market history unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      }
    }

    if (url.pathname === '/api/analytics') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })
      return handleAnalyticsEvent(request, env)
    }

    if (url.pathname === '/api/analytics/summary') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
      return handleAnalyticsSummary(request, env)
    }

    if (url.pathname === '/api/cockpit') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
      return handleCockpitRequest(request, env)
    }

    if (url.pathname === '/api/minters') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
      return handleMintersRequest(request, env.ACTIVITY)
    }

    if (url.pathname === '/api/burns') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
      return handleBurnsRequest(request, env.ACTIVITY)
    }

    if (url.pathname === '/api/flows/daily') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
      return handleFlowsDailyRequest(request, env.ACTIVITY)
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rpc')) return Response.json({ error: 'Not found' }, { status: 404 })
    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMarketSnapshot(env))
    // Burns collector: it was never wired into a runner, so the seeded burns
    // series went stale after the seed. Runs alongside the market snapshot;
    // cheap when caught up (head read + small log scan), all-or-nothing with
    // its own watermark. Never blocks the market snapshot.
    ctx.waitUntil(
      runBurnCollector(env).catch((err) =>
        console.error(JSON.stringify({ msg: 'burn-collector-error', error: err?.message ?? String(err) })),
      ),
    )
    // Minter collector: it was never wired into a runner, so /api/flows/daily
    // sat at status "collecting" forever and minter rows only refreshed from
    // sandbox backfills. Hourly by design (100k-block cap per run, catches up
    // over successive runs, all-or-nothing with its own watermark) — gated
    // here because this trigger fires every five minutes. Never blocks the
    // market snapshot; failures back off 15 minutes via last_attempt_ts.
    ctx.waitUntil(runMinterCollectorHourly(env))
    // Dashboard snapshot: rebuild the homepage snapshot (pairs, contracts,
    // holders, recent activity, protocol) on this 5-minute tick so every
    // section of the site stays as fresh as the free tier allows. Previously
    // built by the GitHub publisher on a ~3h cadence (gaps up to 7h). Merges
    // over the previous snapshot, retaining prior sections when a source
    // fails; writes D1-only (no KV mirror) to protect the KV write cap.
    // Never throws and never blocks the market snapshot.
    ctx.waitUntil(runDashboardSnapshot(env))
    // Force a GitHub publisher run when the activity pipeline has gone quiet.
    // This never throws and never blocks the market snapshot above. The check
    // result is logged (Workers observability) and persisted to KV so a silent
    // watchdog stays diagnosable — see `watchdog-last-check`.
    ctx.waitUntil((async () => {
      let result
      try {
        result = await checkPipelineFreshness(env)
      } catch (err) {
        console.error(JSON.stringify({ msg: 'watchdog-error', error: err?.message ?? String(err) }))
        return
      }
      const entry = { msg: 'watchdog-check', at: new Date().toISOString(), ...result }
      console.log(JSON.stringify(entry))
      try {
        // Write-bounded: at */5 this tick fires 288x/day against the 1,000
        // KV writes/day free cap. The check result only changes when the
        // pipeline state changes, so persist on state change only — the
        // console log above keeps every tick diagnosable via Workers Logs.
        const prevRaw = await env.ACTIVITY?.get?.('watchdog-last-check')
        let changed = true
        try {
          const prev = JSON.parse(prevRaw ?? 'null')
          changed =
            !prev ||
            prev.checked !== result.checked ||
            prev.stale !== result.stale ||
            prev.dispatched !== result.dispatched ||
            prev.reason !== result.reason
        } catch {
          changed = true
        }
        if (changed) await env.ACTIVITY?.put?.('watchdog-last-check', JSON.stringify(entry))
      } catch {
        // Diagnostics are best-effort; the check result is already logged.
      }
    })())
  },

}
