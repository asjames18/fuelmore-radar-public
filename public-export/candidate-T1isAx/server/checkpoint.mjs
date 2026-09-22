/** Durable FUEL event index helpers. Pure functions — no RPC. */

export const INDEX_SCHEMA_VERSION = 1

export function emptyIndex({ token, genesisTs, fromBlock }) {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chainId: 4663,
    token,
    genesisTs,
    fromBlock: String(fromBlock),
    throughBlock: null,
    throughHash: null,
    throughTimestamp: null,
    blockHashes: {},
    records: [],
  }
}

/** Validate and normalize a persisted index. Returns null when unusable. */
export function parseIndex(raw, { token }) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.schemaVersion !== INDEX_SCHEMA_VERSION) return null
  if (raw.chainId !== 4663) return null
  if (raw.token !== token) return null
  if (!Number.isFinite(raw.genesisTs)) return null
  if (typeof raw.fromBlock !== 'string' || !/^\d+$/.test(raw.fromBlock)) return null
  if (typeof raw.throughBlock !== 'string' || !/^\d+$/.test(raw.throughBlock)) return null
  if (typeof raw.throughHash !== 'string' || !raw.throughHash.startsWith('0x')) return null
  if (!Number.isFinite(raw.throughTimestamp)) return null
  if (!raw.blockHashes || typeof raw.blockHashes !== 'object' || Array.isArray(raw.blockHashes)) return null
  if (!Array.isArray(raw.records)) return null
  for (const record of raw.records) {
    if (!record || typeof record.id !== 'string' || typeof record.kind !== 'string') return null
    if (!Number.isFinite(record.blockNumber) || !Number.isFinite(record.logIndex)) return null
    if (!Number.isFinite(record.timestamp)) return null
  }
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chainId: 4663,
    token: raw.token,
    genesisTs: raw.genesisTs,
    fromBlock: raw.fromBlock,
    throughBlock: raw.throughBlock,
    throughHash: raw.throughHash,
    throughTimestamp: raw.throughTimestamp,
    blockHashes: { ...raw.blockHashes },
    records: raw.records.map(record => ({ ...record })),
  }
}

/**
 * Walk indexed block numbers from tip downward until stored hash matches chain.
 * verify(blockNumber) => Promise<string|null> current hash, or null if unavailable.
 * Returns the highest safe block number as a string, or null when the whole index is invalid.
 */
export async function findCommonAncestor(blockHashes, throughBlock, verify) {
  const tip = BigInt(throughBlock)
  const numbers = [...new Set([
    ...Object.keys(blockHashes).map(value => BigInt(value)),
    tip,
  ])].filter(number => number <= tip).sort((a, b) => (a === b ? 0 : a < b ? 1 : -1))

  for (const number of numbers) {
    const key = number.toString()
    const expected = number === tip && !blockHashes[key] ? null : blockHashes[key]
    const actual = await verify(number)
    if (actual == null) continue
    if (expected == null) {
      // Tip with no events still needs an exact match against the caller's throughHash —
      // handled by the caller before invoking this helper for tip-only checks.
      continue
    }
    if (actual === expected) return key
  }
  return null
}

/** Keep records and hashes at or before `safeBlock` (inclusive). */
export function truncateIndex(index, safeBlock) {
  const limit = BigInt(safeBlock)
  const blockHashes = {}
  for (const [number, hash] of Object.entries(index.blockHashes)) {
    if (BigInt(number) <= limit) blockHashes[number] = hash
  }
  const records = index.records.filter(record => BigInt(record.blockNumber) <= limit)
  return {
    ...index,
    throughBlock: String(safeBlock),
    throughHash: blockHashes[String(safeBlock)] ?? index.throughHash,
    blockHashes,
    records,
  }
}

/**
 * Decide where the next log scan should start.
 * Returns { mode, fromBlock, index } where index may already be truncated for a reorg.
 */
export async function resumeFromCheckpoint(index, { throughBlock, throughHash, verifyBlockHash }) {
  if (!index?.throughBlock) {
    return { mode: 'full', fromBlock: BigInt(index.fromBlock), index }
  }

  const tip = BigInt(index.throughBlock)
  if (tip > throughBlock) {
    // Snapshot tip moved backward (deep reorg past our confirmed window). Rebuild.
    return { mode: 'full', fromBlock: BigInt(index.fromBlock), index: {
      ...index,
      throughBlock: null,
      throughHash: null,
      throughTimestamp: null,
      blockHashes: {},
      records: [],
    } }
  }

  const tipOnChain = await verifyBlockHash(tip)
  if (tipOnChain === index.throughHash) {
    if (tip === throughBlock) {
      return { mode: 'current', fromBlock: tip + 1n, index }
    }
    return { mode: 'incremental', fromBlock: tip + 1n, index }
  }

  // Tip hash mismatch — walk back through known event blocks.
  const hashes = { ...index.blockHashes, [index.throughBlock]: index.throughHash }
  const ancestor = await findCommonAncestor(hashes, index.throughBlock, verifyBlockHash)
  if (ancestor == null) {
    return { mode: 'full', fromBlock: BigInt(index.fromBlock), index: {
      ...index,
      throughBlock: null,
      throughHash: null,
      throughTimestamp: null,
      blockHashes: {},
      records: [],
    } }
  }

  const truncated = truncateIndex({ ...index, blockHashes: hashes }, ancestor)
  truncated.throughHash = hashes[ancestor]
  // throughTimestamp refreshed by caller after reading the ancestor block if needed.
  if (BigInt(ancestor) === throughBlock) {
    return { mode: 'current', fromBlock: BigInt(ancestor) + 1n, index: truncated }
  }
  return { mode: 'incremental', fromBlock: BigInt(ancestor) + 1n, index: truncated }
}

export function mergeRecords(existing, next) {
  const seen = new Set(existing.map(record => record.id))
  const merged = [...existing]
  for (const record of next) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    merged.push(record)
  }
  return merged
}

export function applyScanResult(index, { records, blockHashes, throughBlock, throughHash, throughTimestamp }) {
  const mergedHashes = { ...index.blockHashes, ...blockHashes, [String(throughBlock)]: throughHash }
  return {
    ...index,
    throughBlock: String(throughBlock),
    throughHash,
    throughTimestamp,
    blockHashes: mergedHashes,
    records: mergeRecords(index.records, records),
  }
}
