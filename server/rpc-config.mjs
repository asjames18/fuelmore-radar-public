export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

/** Backend-only configuration. Never import this into browser modules. */
export function resolveRpcUrl(env) {
  if (env.RPC_URL === undefined || env.RPC_URL === '') return PUBLIC_RPC
  try {
    const value = env.RPC_URL.trim()
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error()
    return value
  } catch { throw new Error('Invalid backend RPC configuration') }
}

export const collectorFailureMessage = () => 'Activity collection failed; check provider configuration or retry'

/**
 * The burns collector reads through the MANAGED endpoint (RPC_URL), like
 * every other collector. The public-RPC experiment (2026-09-24, commit
 * 9f456a5) proved out for the sandbox backfill — the sandbox scanned 1.7M
 * blocks in 50k ranges fine — but the WORKER's egress to the public RPC is
 * rate-limited: every tick got HTTP 429, including the post-backfill tiny
 * scan at 2026-09-24 09:34Z (meta:burn-collector reason=scan-failed), so the
 * watermark never advanced from worker-side. Steady-state ticks scan
 * [watermark, head] — a few hundred blocks — which fits the managed
 * endpoint's limits (the KV-era collector ran exactly this way).
 * Override with BURN_RPC_URL if a different endpoint is ever needed.
 */
export function resolveBurnRpcUrl(env) {
  const value = env.BURN_RPC_URL
  if (value === undefined || value === '') return resolveRpcUrl(env)
  try {
    const trimmed = value.trim()
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error()
    return trimmed
  } catch { throw new Error('Invalid burn-collector RPC configuration') }
}

/**
 * eth_getLogs range size for the burns collector: 10 blocks, matching the
 * managed endpoint's free-tier cap. The existing batch/pacing machinery
 * (BURN_LOG_BATCH_CALLS/BURN_BATCH_PACING_MS/BURN_RPC_CONCURRENCY in
 * burn-collect.mjs) is live again for exactly this shape. Override with
 * BURN_LOG_RANGE when the endpoint tolerates larger ranges.
 */
export function resolveBurnLogRange(env) {
  const value = env.BURN_LOG_RANGE
  if (value === undefined || value === '') return 10n
  if (!/^\d+$/.test(value) || BigInt(value) < 1n || BigInt(value) > 50000n) throw new Error('Invalid burn-collector log range')
  return BigInt(value)
}

export function resolveLogRange(env) {
  const value=env.RPC_LOG_RANGE
  if(value===undefined || value==='') return env.RPC_URL?.trim()?10n:50000n
  if(!/^\d+$/.test(value) || BigInt(value)<1n || BigInt(value)>50000n) throw new Error('Invalid collector log range')
  return BigInt(value)
}

/** Private operator diagnostics: only fixed categories and numeric status codes. */
export function collectorDiagnostic(error) {
 let current=error,category='unknown',httpStatus,rpcCode
 for(let depth=0;current && depth<8;depth++,current=current.cause) {
  if(Number.isInteger(current.status) && current.status>=400 && current.status<=599)httpStatus=current.status
  if(Number.isInteger(current.code) && current.code<0 && current.code>=-32768)rpcCode=current.code
  if(['TimeoutError','AbortError','TimeoutRpcError'].includes(current.name))category='timeout'
  if(typeof current.message==='string' && current.message.startsWith('Chain changed during'))category='chain_changed'
 }
 if(httpStatus===429 || rpcCode===-32005)category='rate_limit'
 else if(category==='unknown' && rpcCode!==undefined)category='rpc'
 else if(category==='unknown' && httpStatus!==undefined)category='http'
 return {category,...(httpStatus===undefined?{}:{httpStatus}),...(rpcCode===undefined?{}:{rpcCode})}
}
