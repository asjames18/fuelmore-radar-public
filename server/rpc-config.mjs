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
 * The burns collector needs large eth_getLogs ranges. The managed
 * (Alchemy) endpoint caps eth_getLogs at 10-block ranges AND rate-limits
 * compute units/sec — the collector's steady-state ~14k-block scans
 * 429 on every tick, the watermark holds, and the series rots
 * (observed 2026-09-24). The public Robinhood RPC tolerates 50k-block
 * ranges (verified 2026-09-24: 1.7M blocks scanned in 50k ranges), so the
 * burns collector uses it directly. Every other collector and the
 * frontend /rpc proxy keep using the managed endpoint.
 * Override with BURN_RPC_URL if a different endpoint is ever needed.
 */
export function resolveBurnRpcUrl(env) {
  const value = env.BURN_RPC_URL
  if (value === undefined || value === '') return PUBLIC_RPC
  try {
    const trimmed = value.trim()
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error()
    return trimmed
  } catch { throw new Error('Invalid burn-collector RPC configuration') }
}

/** eth_getLogs range size for the burns collector: 50000 on the public RPC (10 on a managed override, mirroring resolveLogRange). */
export function resolveBurnLogRange(env) {
  const value = env.BURN_LOG_RANGE
  if (value === undefined || value === '') return env.BURN_RPC_URL?.trim() ? 10n : 50000n
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
