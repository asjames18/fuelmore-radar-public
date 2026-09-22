/** Server-side cockpit snapshot cache: GET /api/cockpit?address=0x…
 *
 * The Worker performs the same multicall reads the browser client does
 * (Multicall3.aggregate3 over eth_call, pinned to one block), builds the
 * finished CockpitSnapshot, and caches it in a dedicated KV namespace.
 *
 * Data-integrity rules (mirrored from src/lib/cockpit.ts):
 * - failed reads stay unknown: a failed subcall marks that slot incomplete,
 *   NEVER zero/false/"no positions".
 * - block pinning with start AND end hash checks, plus a chain-id recheck.
 * - sampleIncomplete is preserved end to end.
 *
 * Pure .mjs with no npm imports so the Worker bundle and node --test both run it.
 */
import { resolveRpcUrl } from './rpc-config.mjs'

export const COCKPIT_CHAIN_ID = 4663
export const FUEL_TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
export const BATCH_MINTER = '0xEaB771dB3883dC05DbEA1915F7e81910869bbc18'
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
/** KV TTL for a finished snapshot. */
export const COCKPIT_CACHE_TTL_SECONDS = 600
/** Uncached computations allowed per client IP per hour before 429. */
export const COCKPIT_COMPUTE_CAP_PER_HOUR = 20
/** Upper bound on mint slots for a cached snapshot (client falls back to direct reads past this). */
export const COCKPIT_MAX_MINTS = 5000
/** Subcalls per aggregate3 eth_call — stays comfortably under eth_call gas caps. */
export const AGGREGATE3_CHUNK = 150

// ---------------------------------------------------------------------------
// keccak-256 (Ethereum variant) — needed for selectors and EIP-55 checksums.
// ---------------------------------------------------------------------------

const KECCAK_ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
]
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const MASK64 = 0xffffffffffffffffn
const rotl64 = (v, n) => (n === 0 ? v & MASK64 : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64)

function keccakF1600(state) {
  const get = i => state.getBigUint64(i * 8, true)
  const set = (i, v) => state.setBigUint64(i * 8, v & MASK64, true)
  for (let round = 0; round < 24; round++) {
    const c = [0n, 0n, 0n, 0n, 0n]
    const d = [0n, 0n, 0n, 0n, 0n]
    for (let x = 0; x < 5; x++) c[x] = get(x) ^ get(x + 5) ^ get(x + 10) ^ get(x + 15) ^ get(x + 20)
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) set(x + 5 * y, get(x + 5 * y) ^ d[x])
    const b = new Array(25)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(get(x + 5 * y), KECCAK_ROT[x][y])
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) set(x + 5 * y, b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y] & MASK64) & b[(x + 2) % 5 + 5 * y]))
    set(0, get(0) ^ KECCAK_RC[round])
  }
}

/** keccak-256 digest of a Uint8Array. */
export function keccak256Bytes(input) {
  const rate = 136
  const state = new DataView(new ArrayBuffer(200))
  const block = new Uint8Array(rate)
  const blockView = new DataView(block.buffer)
  const absorb = () => {
    for (let i = 0; i < 25; i++) {
      const lane = i * 8 < rate ? blockView.getBigUint64(i * 8, true) : 0n
      state.setBigUint64(i * 8, (state.getBigUint64(i * 8, true) ^ lane) & MASK64, true)
    }
    keccakF1600(state)
  }
  let pos = 0
  for (let i = 0; i < input.length; i++) {
    block[pos++] = input[i]
    if (pos === rate) { absorb(); block.fill(0); pos = 0 }
  }
  block[pos] ^= 0x01
  block[rate - 1] ^= 0x80
  absorb()
  return new Uint8Array(state.buffer.slice(0, 32))
}

export function bytesToHex(bytes) {
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// ---------------------------------------------------------------------------
// Address validation (strict EIP-55)
// ---------------------------------------------------------------------------

/** EIP-55 checksum encoding of a 0x address, or null when malformed. */
export function toChecksumAddress(input) {
  if (typeof input !== 'string') return null
  const m = /^0x([0-9a-fA-F]{40})$/.exec(input.trim())
  if (!m) return null
  const lower = m[1].toLowerCase()
  const hashHex = bytesToHex(keccak256Bytes(new TextEncoder().encode(lower))).slice(2)
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const ch = lower[i]
    out += ch >= 'a' && ch <= 'f' && parseInt(hashHex[i], 16) >= 8 ? ch.toUpperCase() : ch
  }
  return out
}

/** Strict validation: the input must already be EIP-55 checksummed. Returns the address or null. */
export function parseCockpitAddress(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  const checksummed = toChecksumAddress(trimmed)
  return checksummed !== null && trimmed === checksummed ? checksummed : null
}

// ---------------------------------------------------------------------------
// Minimal ABI codec (static types + aggregate3)
// ---------------------------------------------------------------------------

const selectorCache = new Map()
/** 4-byte selector hex (no 0x prefix) for a canonical function signature. */
export function functionSelector(signature) {
  let sel = selectorCache.get(signature)
  if (!sel) {
    sel = bytesToHex(keccak256Bytes(new TextEncoder().encode(signature))).slice(2, 10)
    selectorCache.set(signature, sel)
  }
  return sel
}

const encUint256 = v => BigInt(v).toString(16).padStart(64, '0')
const encAddress = a => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** Encode a call: signature + static args ([type, value] pairs; types: address|uint256|bool). */
export function encodeCall(signature, args) {
  let data = functionSelector(signature)
  for (const [type, value] of args) {
    if (type === 'address') data += encAddress(value)
    else if (type === 'bool') data += (value ? '1' : '0').padStart(64, '0')
    else data += encUint256(value)
  }
  return '0x' + data
}

/**
 * Encode Multicall3.aggregate3((address,bool,bytes)[]).
 * Array-of-dynamic-tuples layout: offset | length | per-element offsets |
 * then each self-contained tuple: target | allowFailure | 0x60 | len | data.
 */
export function encodeAggregate3(calls) {
  const tuples = calls.map(c => {
    const dataHex = String(c.callData).toLowerCase().replace(/^0x/, '')
    const dataLen = dataHex.length / 2
    const padded = dataHex.padEnd(Math.ceil(dataLen / 32) * 64, '0')
    return encAddress(c.target) + encUint256(c.allowFailure ? 1n : 0n) + encUint256(96n)
      + encUint256(BigInt(dataLen)) + padded
  })
  let body = encUint256(32n) + encUint256(BigInt(calls.length))
  let offset = calls.length * 32
  for (const t of tuples) { body += encUint256(BigInt(offset)); offset += t.length / 2 }
  for (const t of tuples) body += t
  return '0x' + functionSelector('aggregate3((address,bool,bytes)[])') + body
}

function readU256Hex(data, byteOffset) {
  return BigInt('0x' + data.slice(2 + byteOffset * 2, 2 + (byteOffset + 32) * 2))
}

/** Decode aggregate3 return data into [{ success, returnData }] or null. */
export function decodeAggregate3(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) return null
  const bytes = (data.length - 2) / 2
  if (!Number.isInteger(bytes) || bytes < 64) return null
  const arrayOffset = Number(readU256Hex(data, 0))
  if (!Number.isSafeInteger(arrayOffset) || arrayOffset + 32 > bytes) return null
  const count = Number(readU256Hex(data, arrayOffset))
  if (!Number.isSafeInteger(count) || count > 10000) return null
  if (arrayOffset + 32 + count * 32 > bytes) return null
  const out = []
  for (let i = 0; i < count; i++) {
    const elemOffset = Number(readU256Hex(data, arrayOffset + 32 + i * 32))
    if (!Number.isSafeInteger(elemOffset)) return null
    // Element offsets are relative to the byte just past the length word.
    const pos = arrayOffset + 32 + elemOffset
    if (pos + 96 > bytes) return null
    const success = readU256Hex(data, pos) !== 0n
    const bytesOffset = Number(readU256Hex(data, pos + 32))
    if (!Number.isSafeInteger(bytesOffset)) return null
    const dataStart = pos + bytesOffset
    if (dataStart + 32 > bytes) return null
    const len = Number(readU256Hex(data, dataStart))
    if (!Number.isSafeInteger(len) || dataStart + 32 + len > bytes) return null
    out.push({ success, returnData: '0x' + data.slice(2 + (dataStart + 32) * 2, 2 + (dataStart + 32 + len) * 2) })
  }
  return out
}

/** Decode `count` static uint256/address words; null on short or malformed data. */
export function decodeWords(data, count) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) return null
  const bytes = (data.length - 2) / 2
  if (!Number.isInteger(bytes) || bytes < count * 32) return null
  const words = []
  for (let i = 0; i < count; i++) words.push(readU256Hex(data, i * 32))
  return words
}

const isAddressWord = data => typeof data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data)
/** Last 20 bytes of a word as a checksummed address. */
export function wordToAddress(data) {
  return toChecksumAddress('0x' + data.slice(-40))
}

/** Mirror of src/lib/wallet.ts decodeMint for word-decoded userMints tuples. */
export function decodeMintWords(words) {
  if (!words || words.length < 6) return null
  if (words[0] === 0n) return null // zero user == no mint
  return { term: words[1], maturityTs: words[2], rank: words[3], amplifier: words[4], eaaRate: words[5] }
}

// ---------------------------------------------------------------------------
// Snapshot math (mirrors src/lib/cockpit.ts summarizeSlots)
// ---------------------------------------------------------------------------

const WITHDRAWAL_WINDOW_DAYS = 7
const MAX_PENALTY_PCT = 99
function lateClaimPenaltyPct(secsLate) {
  if (!Number.isFinite(secsLate) || secsLate < 0) throw new Error('Invalid lateness')
  const daysLate = Math.floor(secsLate / 86400)
  if (daysLate > WITHDRAWAL_WINDOW_DAYS - 1) return MAX_PENALTY_PCT
  return Math.min(Math.floor((2 ** (daysLate + 3)) / WITHDRAWAL_WINDOW_DAYS) - 1, MAX_PENALTY_PCT)
}

function bucketKey(maturityTs, now) {
  if (maturityTs <= now) return 'due'
  const days = (maturityTs - now) / 86400
  if (days <= 7) return 'd7'
  if (days <= 30) return 'd30'
  return 'later'
}

function summarizeSlots(slots, now) {
  const counts = { due: 0, d7: 0, d30: 0, later: 0 }
  const earliest = { due: null, d7: null, d30: null, later: null }
  let maxLatePenaltyPct = 0
  let nextUp = null
  let nextDue = null
  for (const slot of slots) {
    const ts = Number(slot.maturityTs)
    const key = bucketKey(ts, now)
    counts[key]++
    if (earliest[key] == null || ts < earliest[key]) earliest[key] = ts
    if (ts <= now) maxLatePenaltyPct = Math.max(maxLatePenaltyPct, lateClaimPenaltyPct(now - ts))
    if (ts > now && (nextUp === null || ts < nextUp)) nextUp = ts
    if (ts <= now && (nextDue === null || ts < nextDue)) nextDue = ts
  }
  const nextMaturityTs = nextUp ?? nextDue
  return {
    dueOrLate: counts.due,
    upcoming7d: counts.d7,
    upcoming30d: counts.d30,
    later: counts.later,
    nextMaturityTs,
    maxLatePenaltyPct,
    buckets: [
      { key: 'due', label: 'Due / late', count: counts.due, earliestTs: earliest.due },
      { key: 'd7', label: 'Next 7 days', count: counts.d7, earliestTs: earliest.d7 },
      { key: 'd30', label: '8–30 days', count: counts.d30, earliestTs: earliest.d30 },
      { key: 'later', label: 'Later', count: counts.later, earliestTs: earliest.later },
    ],
  }
}

// ---------------------------------------------------------------------------
// Snapshot computation (direct upstream JSON-RPC, no /rpc proxy limits)
// ---------------------------------------------------------------------------

/**
 * Compute the finished cockpit snapshot for a checksummed address.
 * Throws on any integrity violation (network, block, hash mismatch);
 * partial reads surface as sampleIncomplete, never as zeros.
 */
export async function computeCockpitSnapshot({ address, rpcUrl, fetchImpl = fetch, timeoutMs = 30000 }) {
  const checksummed = parseCockpitAddress(address)
  if (!checksummed) throw new Error('Invalid address')
  const signal = AbortSignal.timeout(timeoutMs)

  const post = async items => {
    const body = items.map((item, i) => ({ jsonrpc: '2.0', id: i + 1, method: item.method, params: item.params }))
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw new Error(`Upstream RPC HTTP ${res.status}`)
    const json = await res.json()
    const list = Array.isArray(json) ? json : [json]
    const byId = new Map()
    for (const reply of list) if (reply && typeof reply === 'object') byId.set(reply.id, reply)
    return items.map((_, i) => {
      const reply = byId.get(i + 1)
      if (!reply || reply.error !== undefined || reply.result === undefined) return { ok: false, result: null }
      return { ok: true, result: reply.result }
    })
  }

  const [chainRes] = await post([{ method: 'eth_chainId', params: [] }])
  if (!chainRes.ok) throw new Error('Chain ID read failed')
  if (BigInt(chainRes.result) !== BigInt(COCKPIT_CHAIN_ID)) throw new Error('Unexpected network')

  const [blockRes] = await post([{ method: 'eth_getBlockByNumber', params: ['latest', false] }])
  if (!blockRes.ok || !blockRes.result || typeof blockRes.result.number !== 'string' || typeof blockRes.result.hash !== 'string') {
    throw new Error('Confirmed block unavailable')
  }
  const blockNumber = BigInt(blockRes.result.number)
  const blockHash = blockRes.result.hash
  const blockHex = '0x' + blockNumber.toString(16)
  const now = Number(BigInt(blockRes.result.timestamp))

  const call = (to, data) => ({ method: 'eth_call', params: [{ to, data }, blockHex] })
  const [balRes, mintRes, stakeRes, countRes, rankRes] = await post([
    call(FUEL_TOKEN, encodeCall('balanceOf(address)', [['address', checksummed]])),
    call(FUEL_TOKEN, encodeCall('userMints(address)', [['address', checksummed]])),
    call(FUEL_TOKEN, encodeCall('userStakes(address)', [['address', checksummed]])),
    call(BATCH_MINTER, encodeCall('proxiesOf(address)', [['address', checksummed]])),
    call(FUEL_TOKEN, encodeCall('globalRank()', [])),
  ])

  const readWords = (res, expected) => {
    if (!res.ok || typeof res.result !== 'string') return null
    return decodeWords(res.result, expected)
  }
  const oneWord = res => {
    const words = readWords(res, 1)
    return words ? words[0] : null
  }
  const fuelBalance = oneWord(balRes)
  const globalRank = oneWord(rankRes)
  const mintW = readWords(mintRes, 6)
  const stakeW = readWords(stakeRes, 4)
  const countW = readWords(countRes, 1)
  const batchTotal = countW !== null && countW[0] <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(countW[0]) : null
  let sampleIncomplete = mintW === null || stakeW === null || batchTotal === null

  const directMint = decodeMintWords(mintW)
  const directStake = stakeW && stakeW[2] > 0n
    ? { term: stakeW[0], maturityTs: stakeW[1], amount: stakeW[2], apy: stakeW[3] }
    : null

  const slots = []
  if (directMint) {
    slots.push({ id: 'direct', source: 'direct', index: null, proxy: null, ...directMint })
  }

  if (batchTotal !== null && batchTotal > 0) {
    if (batchTotal > COCKPIT_MAX_MINTS) {
      throw Object.assign(new Error('Too many mint slots for a cached snapshot'), { code: 'COCKPIT_TOO_LARGE' })
    }
    // Pass 1: proxy addresses for every mint index.
    const proxies = new Array(batchTotal).fill(null)
    const proxyCalls = []
    for (let i = 0; i < batchTotal; i++) {
      proxyCalls.push({
        target: BATCH_MINTER,
        allowFailure: true,
        callData: encodeCall('proxyAddress(address,uint256)', [['address', checksummed], ['uint256', BigInt(i)]]),
      })
    }
    for (let start = 0; start < proxyCalls.length; start += AGGREGATE3_CHUNK) {
      const chunk = proxyCalls.slice(start, start + AGGREGATE3_CHUNK)
      const [res] = await post([call(MULTICALL3, encodeAggregate3(chunk))])
      const decoded = res.ok ? decodeAggregate3(res.result) : null
      if (!decoded || decoded.length !== chunk.length) { sampleIncomplete = true; continue }
      decoded.forEach((d, n) => {
        if (!d.success || !isAddressWord(d.returnData)) { sampleIncomplete = true; return }
        proxies[start + n] = wordToAddress(d.returnData)
      })
    }
    // Pass 2: mint state per proxy.
    const targets = []
    proxies.forEach((proxy, index) => { if (proxy) targets.push({ index, proxy }) })
    for (let start = 0; start < targets.length; start += AGGREGATE3_CHUNK) {
      const chunk = targets.slice(start, start + AGGREGATE3_CHUNK)
      const [res] = await post([call(MULTICALL3, encodeAggregate3(chunk.map(t => ({
        target: FUEL_TOKEN,
        allowFailure: true,
        callData: encodeCall('userMints(address)', [['address', t.proxy]]),
      }))))])
      const decoded = res.ok ? decodeAggregate3(res.result) : null
      if (!decoded || decoded.length !== chunk.length) { sampleIncomplete = true; continue }
      decoded.forEach((d, n) => {
        if (!d.success) { sampleIncomplete = true; return }
        const w = decodeWords(d.returnData, 6)
        if (!w) { sampleIncomplete = true; return }
        const mint = decodeMintWords(w)
        if (!mint) return
        slots.push({ id: `batch:${chunk[n].index}`, source: 'batch', index: chunk[n].index, proxy: chunk[n].proxy, ...mint })
      })
    }
  }

  // End pin checks: block hash must be unchanged, chain id rechecked.
  const [endBlockRes, endChainRes] = await post([
    { method: 'eth_getBlockByNumber', params: [blockHex, false] },
    { method: 'eth_chainId', params: [] },
  ])
  if (!endBlockRes.ok || String(endBlockRes.result?.hash).toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error('Snapshot changed; refresh cockpit')
  }
  if (!endChainRes.ok || BigInt(endChainRes.result) !== BigInt(COCKPIT_CHAIN_ID)) throw new Error('Unexpected network')

  slots.sort((a, b) => (a.maturityTs < b.maturityTs ? -1 : a.maturityTs > b.maturityTs ? 1 : (a.index ?? -1) - (b.index ?? -1)))
  const summary = summarizeSlots(slots, now)

  return {
    address: checksummed,
    blockNumber,
    blockHash,
    observedAt: now,
    fuelBalance,
    globalRank,
    directMint,
    directStake,
    batchTotal,
    activeMints: slots.length,
    ...summary,
    sampleIncomplete,
    slots,
    slotsPinnedBlockNumber: blockNumber,
    slotsPinnedBlockHash: blockHash,
    cachedAt: Date.now(),
  }
}

/** JSON-safe snapshot: bigints travel as { $bigint: "<decimal>" } tags (client revives them). */
export function serializeCockpitSnapshot(snapshot) {
  return JSON.stringify(snapshot, (_key, value) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value))
}

/**
 * GET /api/cockpit?address=0x… — validate, serve from KV, or compute + cache.
 * Pure function of (request, env); safe to call without the COCKPIT_CACHE binding.
 */
export async function handleCockpitRequest(request, env) {
  const url = new URL(request.url)
  const address = parseCockpitAddress(url.searchParams.get('address'))
  if (!address) {
    return Response.json({ error: 'Invalid address: expected an EIP-55 checksummed 0x address' }, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }
  const kv = env?.COCKPIT_CACHE
  const cacheKey = `cockpit:v1:${address.toLowerCase()}`
  if (kv) {
    try {
      const cached = await kv.get(cacheKey)
      if (typeof cached === 'string' && cached) {
        return new Response(cached, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=60',
            'X-Cockpit-Cache': 'HIT',
          },
        })
      }
    } catch { /* cache read failures fall through to compute */ }
  }

  // Abuse guard: cap uncached computations per client IP per hour.
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128)
  const budgetKey = `cockpit:budget:v1:${ip}`
  let used = 0
  if (kv) {
    try { used = Number(await kv.get(budgetKey)) || 0 } catch { /* treat as unused */ }
  }
  if (used >= COCKPIT_COMPUTE_CAP_PER_HOUR) {
    return Response.json({ error: 'Cockpit compute limit reached; retry later' }, {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': '3600', 'Cache-Control': 'no-store' },
    })
  }

  let snapshot
  try {
    snapshot = await computeCockpitSnapshot({ address, rpcUrl: resolveRpcUrl(env ?? {}) })
  } catch (error) {
    if (error?.code === 'COCKPIT_TOO_LARGE') {
      return Response.json({ error: 'Too many mint slots for a cached snapshot' }, {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      })
    }
    return Response.json({ error: 'Cockpit snapshot unavailable; retry shortly' }, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    })
  }

  const body = serializeCockpitSnapshot(snapshot)
  if (kv) {
    try {
      await kv.put(cacheKey, body, { expirationTtl: COCKPIT_CACHE_TTL_SECONDS })
      await kv.put(budgetKey, String(used + 1), { expirationTtl: 3600 })
    } catch { /* cache write failures must not fail the request */ }
  }
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
      'X-Cockpit-Cache': 'MISS',
    },
  })
}
