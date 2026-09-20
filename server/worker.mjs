import { resolveRpcUrl } from './rpc-config.mjs'
import { loadReport, activityEnvelope } from './activity-edge.mjs'
import { findDisallowedRpcMethods } from './rpc-allowlist.mjs'

import { createRpcBudget, validateReadBudget, fetchRpcWithinBudget, readLimitedBody } from './rpc-budget.mjs'

import { runMarketSnapshot, readMarketHistory } from './market-collect.mjs'

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
            if (cached && now - cached.timestamp < 8000) {
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
        const snapshot = await env.ACTIVITY?.get('dashboard-snapshot-v1')
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
        if (!env.ACTIVITY || typeof env.ACTIVITY.get !== 'function') throw new Error('KV unavailable')
        const points = await readMarketHistory(env.ACTIVITY)
        const last = points.at(-1)
        return Response.json(
          { updatedAt: last ? new Date(last.t * 1000).toISOString() : null, points },
          { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } },
        )
      } catch {
        return Response.json({ error: 'Market history unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      }
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rpc')) return Response.json({ error: 'Not found' }, { status: 404 })
    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMarketSnapshot(env))
  },

}
