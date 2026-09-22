import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INDEX_SCHEMA_VERSION,
  emptyIndex,
  parseIndex,
  findCommonAncestor,
  truncateIndex,
  resumeFromCheckpoint,
  mergeRecords,
  applyScanResult,
} from './checkpoint.mjs'

const TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'

function sampleIndex(overrides = {}) {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chainId: 4663,
    token: TOKEN,
    genesisTs: 1_000,
    fromBlock: '100',
    throughBlock: '150',
    throughHash: '0xtip',
    throughTimestamp: 2_000,
    blockHashes: { '120': '0xa', '140': '0xb', '150': '0xtip' },
    records: [
      { id: '0xa:0', kind: 'mint', blockNumber: 120, logIndex: 0, timestamp: 1100, sender: '0x1', user: '0x1', term: 7, amount: '0' },
      { id: '0xb:1', kind: 'claim', blockNumber: 140, logIndex: 1, timestamp: 1400, sender: '0x1', user: '0x1', term: 0, amount: '1' },
    ],
    ...overrides,
  }
}

test('parseIndex rejects wrong chain, token, schema, or malformed records', () => {
  assert.equal(parseIndex(null, { token: TOKEN }), null)
  assert.equal(parseIndex(sampleIndex({ chainId: 1 }), { token: TOKEN }), null)
  assert.equal(parseIndex(sampleIndex({ token: '0xdead' }), { token: TOKEN }), null)
  assert.equal(parseIndex(sampleIndex({ schemaVersion: 99 }), { token: TOKEN }), null)
  assert.equal(parseIndex(sampleIndex({ records: [{ id: 'x' }] }), { token: TOKEN }), null)
  assert.equal(parseIndex(sampleIndex(), { token: TOKEN }).throughBlock, '150')
})

test('findCommonAncestor returns the highest matching block', async () => {
  const hashes = { '120': '0xa', '140': '0xb', '150': '0xold' }
  const chain = { 120n: '0xa', 140n: '0xb', 150n: '0xnew' }
  const ancestor = await findCommonAncestor(hashes, '150', async number => chain[number] ?? null)
  assert.equal(ancestor, '140')
})

test('findCommonAncestor returns null when every stored hash diverged', async () => {
  const hashes = { '120': '0xa', '140': '0xb' }
  const ancestor = await findCommonAncestor(hashes, '140', async () => '0xother')
  assert.equal(ancestor, null)
})

test('truncateIndex drops records and hashes above the safe tip', () => {
  const truncated = truncateIndex(sampleIndex(), '120')
  assert.equal(truncated.records.length, 1)
  assert.deepEqual(Object.keys(truncated.blockHashes).sort(), ['120'])
  assert.equal(truncated.throughBlock, '120')
})

test('resumeFromCheckpoint stays incremental when tip hash still matches', async () => {
  const index = sampleIndex()
  const resumed = await resumeFromCheckpoint(index, {
    throughBlock: 160n,
    throughHash: '0xlater',
    verifyBlockHash: async number => number === 150n ? '0xtip' : null,
  })
  assert.equal(resumed.mode, 'incremental')
  assert.equal(resumed.fromBlock, 151n)
  assert.equal(resumed.index.records.length, 2)
})

test('resumeFromCheckpoint reports current when already at tip', async () => {
  const index = sampleIndex()
  const resumed = await resumeFromCheckpoint(index, {
    throughBlock: 150n,
    throughHash: '0xtip',
    verifyBlockHash: async number => number === 150n ? '0xtip' : null,
  })
  assert.equal(resumed.mode, 'current')
  assert.equal(resumed.fromBlock, 151n)
})

test('resumeFromCheckpoint rewinds to common ancestor on reorg', async () => {
  const index = sampleIndex()
  const chain = { 120n: '0xa', 140n: '0xreorg', 150n: '0xreorg-tip' }
  const resumed = await resumeFromCheckpoint(index, {
    throughBlock: 160n,
    throughHash: '0xlater',
    verifyBlockHash: async number => chain[number] ?? null,
  })
  assert.equal(resumed.mode, 'incremental')
  assert.equal(resumed.fromBlock, 121n)
  assert.equal(resumed.index.records.length, 1)
  assert.equal(resumed.index.throughBlock, '120')
  assert.equal(resumed.index.throughHash, '0xa')
})

test('resumeFromCheckpoint rebuilds from genesis when ancestor is unknown', async () => {
  const index = sampleIndex({ blockHashes: { '120': '0xa', '140': '0xb' }, throughHash: '0xtip' })
  const resumed = await resumeFromCheckpoint(index, {
    throughBlock: 160n,
    throughHash: '0xlater',
    verifyBlockHash: async () => '0xother',
  })
  assert.equal(resumed.mode, 'full')
  assert.equal(resumed.fromBlock, 100n)
  assert.equal(resumed.index.records.length, 0)
})

test('mergeRecords and applyScanResult are idempotent for duplicate ids', () => {
  const base = emptyIndex({ token: TOKEN, genesisTs: 1, fromBlock: 100n })
  const first = applyScanResult(base, {
    records: [{ id: '0x1:0', kind: 'mint', blockNumber: 101, logIndex: 0, timestamp: 10, sender: '0x1', user: '0x1', term: 7, amount: '0' }],
    blockHashes: { '101': '0x1' },
    throughBlock: 101n,
    throughHash: '0x1',
    throughTimestamp: 10,
  })
  const second = applyScanResult(first, {
    records: [{ id: '0x1:0', kind: 'mint', blockNumber: 101, logIndex: 0, timestamp: 10, sender: '0x1', user: '0x1', term: 7, amount: '0' }],
    blockHashes: { '101': '0x1' },
    throughBlock: 105n,
    throughHash: '0x5',
    throughTimestamp: 20,
  })
  assert.equal(second.records.length, 1)
  assert.equal(second.throughBlock, '105')
  assert.equal(mergeRecords(second.records, second.records).length, 1)
})
