import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findDisallowedRpcMethods, rpcMethodAllowed } from './rpc-allowlist.mjs'

describe('rpc allowlist', () => {
  it('allows read methods used by the dashboard', () => {
    for (const method of ['eth_call', 'eth_blockNumber', 'eth_chainId', 'eth_getBalance', 'eth_getLogs', 'eth_getBlockByNumber']) {
      assert.equal(rpcMethodAllowed(method), true)
    }
  })

  it('rejects write and sign methods', () => {
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign']) {
      assert.equal(rpcMethodAllowed(method), false)
    }
    assert.deepEqual(findDisallowedRpcMethods({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x'] }), ['eth_sendRawTransaction'])
  })

  it('rejects any disallowed method inside a batch', () => {
    const bad = findDisallowedRpcMethods([
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_sendTransaction', params: [{}] },
    ])
    assert.deepEqual(bad, ['eth_sendTransaction'])
  })
})
