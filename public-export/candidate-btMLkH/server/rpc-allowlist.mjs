/** Read-only JSON-RPC methods the public /rpc proxy may forward. */
export const READ_RPC_METHODS = new Set([
  'eth_blockNumber',
  'eth_chainId',
  'eth_call',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getLogs',
  'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_estimateGas',
  'net_version',
  'web3_clientVersion',
])

export function rpcMethodAllowed(method) {
  return typeof method === 'string' && READ_RPC_METHODS.has(method)
}

/** Returns disallowed method names for a single or batch JSON-RPC body. */
export function findDisallowedRpcMethods(parsed) {
  if (parsed == null) return ['<unparsed>']
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const bad = []
  for (const item of items) {
    const method = item?.method
    if (!rpcMethodAllowed(method)) bad.push(typeof method === 'string' ? method : '<missing>')
  }
  return [...new Set(bad)]
}
