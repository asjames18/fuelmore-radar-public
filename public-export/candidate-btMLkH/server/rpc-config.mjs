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
