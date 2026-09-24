// Minter analytics collector for the FUEL/MORE Radar (FUEL only for now).
//
// Hourly worker cron: scans FUEL token transfers, FUEL/WETH pool swaps and
// BatchMinter events, attributes mints to operator wallets, and maintains:
//   minter:<0xaddr>          per-wallet claimed/sold/bought + re-mint stats
//   mintcontract:<0xaddr>    INTERNAL bookkeeping for mint-position contracts
//   flows:daily:<YYYY-MM-DD> daily top buyer/seller leaderboards (ET day)
//   meta:minter-collector    watermark {last_block, last_run_ts, status}
//
// Conventions follow server/market-collect.mjs: all-or-nothing per run,
// injectable chain reader for tests, null-never-zero, read-only RPC.
//
// Verified on-chain 2026-09-21 (do NOT replace with textbook values):
// - Pool Swap topic is non-canonical (V3 fork); data layout still matches V3:
//   amount0 (int256), amount1 (int256), sqrtPriceX96 (uint160), ...
//   Sell (trader gives FUEL) = amount1 > 0. Buy = amount1 < 0.
//   topics[1] = sender, topics[2] = recipient (confirmed via whale buy txs).
// - Mints are standard Transfer events with from == 0x0; each mint position
//   is a contract that later sweeps to an operator EOA.
// - The node rejects even-length-padded block hex (use minimal-length hex)
//   and caps eth_getLogs at 10000 logs per query (chunk + halve on limit).

import { fetchJsonWithRetry, EXPECTED_CHAIN_ID, DEX_TOKEN_API } from './price-sources.mjs'
import { resolveRpcUrl } from './rpc-config.mjs'

export const FUEL_TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
export const WETH_TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
export const FUEL_WETH_POOL = '0xff40c99525ffa6b6cf79ecbe370ef7c887d68f69'
export const BATCH_MINTER = '0xEaB771dB3883dC05DbEA1915F7e81910869bbc18'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
// Non-canonical pool Swap topic (V3 fork). Data layout matches V3.
export const POOL_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
// BatchMinter mint-batch event: topics[1] = wallet, data word 0 = start index
// of the batch, data word 1 = batch size (verified 2026-09-21: a wallet's
// first event carried (0, 50), later events (50, 50), (100, 50), ...).
// Total positions opened = max over events of (start + size).
export const MINTER_EVENT_TOPIC = '0xdf2858fe9d6717afb9b08db74f7157c2faf0245e63c5bb41e5216d8aa074fd13'
export const STANDARD_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// Pool-specific transfer sigs observed 2026-09-21; the live set is
// re-discovered from recent token logs on every run (see discoverTransferTopics).
export const SEED_TRANSFER_TOPICS = [
  STANDARD_TRANSFER_TOPIC,
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  '0xe9149e1b5059238baed02fa659dbf4bd932fbcf760a431330df4d934bc942f37',
  '0x0404cc8b77b76fdd0069710e4c83be16b3fc7e965a829210b1e934f0a1d7527c',
  '0xd74752b13281df13701575f3a507e9b1242e0b5fb040143211c481c1fce573a6',
  '0x0cb7d7dfa4d0420d50a5f6c036b9fecc53ceec3468f5519e7afe105598d2beb0',
  '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90',
]
// USD-pegged quote tokens WETH is expected to trade against on Robinhood chain.
const WETH_USD_QUOTE_SYMBOLS = new Set(['USDG', 'USDC', 'USDT', 'DAI'])

/**
 * Direct WETH/USD from Dexscreener: the highest-liquidity USD-quoted WETH pair
 * on Robinhood chain (WETH must be the base token so priceUsd is USD per WETH).
 *
 * This replaced the old FUEL/USD ÷ execution-price derivation, which mixed the
 * *current* FUEL price with each window's *latest* execution price and
 * mis-valued historical backfill windows by orders of magnitude (e.g. Sept
 * 18–20 swaps were priced at the post-crash Sept 22 level). A direct,
 * non-circular WETH/USD keeps every swap valued at its own execution price.
 */
export async function fetchWethUsd({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const response = await fetchJsonWithRetry(`${DEX_TOKEN_API}/${WETH_TOKEN}`, {
    pairKey: 'weth-usd',
    source: 'dexscreener token endpoint',
    label: 'Dexscreener',
    fetchImpl,
    sleep,
  })
  const payload = await response.json()
  const entries = Array.isArray(payload?.pairs) ? payload.pairs : []
  let best = null
  for (const entry of entries) {
    if (entry?.chainId !== EXPECTED_CHAIN_ID) continue
    if (String(entry?.baseToken?.symbol ?? '').toUpperCase() !== 'WETH') continue
    if (!WETH_USD_QUOTE_SYMBOLS.has(String(entry?.quoteToken?.symbol ?? '').toUpperCase())) continue
    const price = Number(entry?.priceUsd)
    if (!Number.isFinite(price) || price <= 0) continue
    const liq = Number(entry?.liquidity?.usd)
    const liqSafe = Number.isFinite(liq) ? liq : 0
    if (best == null || liqSafe > best.liq) best = { price, liq: liqSafe }
  }
  if (best == null) throw new Error('minter collector: no USD-quoted WETH pair found on Dexscreener')
  return best.price
}

// First block carrying FUEL token logs (measured 2026-09-21).
export const FUEL_FIRST_BLOCK = 65779867n
export const LOG_CHUNK_BLOCKS = 100000n
export const RPC_BATCH_SIZE = 100
export const RPC_CONCURRENCY = 6
// Leaderboards store the top 25 per side per day; the API serves the top 10.
export const DAY_TOP_N = 25
// Soft wall-clock budget per run; on exhaustion the run throws and the
// watermark is retained (all-or-nothing).
export const RUN_DEADLINE_MS = 5 * 60 * 1000
// Hard cap on blocks scanned per hourly run: bounds CPU/subrequests on the
// free tier and lets the collector catch up gradually after downtime.
export const MAX_RUN_BLOCKS = 100000n

export const MINTER_KEY_PREFIX = 'minter:'
export const MINT_CONTRACT_KEY_PREFIX = 'mintcontract:'
export const DAY_KEY_PREFIX = 'flows:daily:'
export const META_KEY = 'meta:minter-collector'

export const METHODOLOGY =
  'Minters are wallets that claimed FUEL from mint positions. Each mint position is a contract ' +
  'that receives FUEL from the zero address and sweeps it to an operator EOA; claimed FUEL is ' +
  'attributed to the first externally-owned wallet each mint contract forwards to. Sold/bought are ' +
  'measured from FUEL/WETH pool swaps, with router-mediated swaps resolved to the transaction sender. ' +
  '% sold can exceed 100% when a wallet also bought FUEL. Re-minted counts mint positions the wallet ' +
  'opened after its first sale plus the ETH fees paid for them. USD values are approximate: ' +
  'each swap is valued at its own on-chain execution price times WETH/USD.'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Minimal-length hex for a block number (the node rejects leading-zero padding). */
export function toMinHex(n) {
  return '0x' + BigInt(n).toString(16)
}

export function hexToBigInt(h) {
  return BigInt(h)
}

/** Decode a 32-byte two's-complement word. */
export function decodeInt256(wordHex) {
  const v = BigInt(wordHex)
  return v >= 2n ** 255n ? v - 2n ** 256n : v
}

export function isZeroAddress(addr) {
  return addr.toLowerCase() === ZERO_ADDRESS
}

function topicAddress(topic) {
  return ('0x' + topic.slice(-40)).toLowerCase()
}

/**
 * Decode a pool Swap log. Returns null when the log is malformed.
 * Layout (V3, verified): amount0 int256, amount1 int256, sqrtPriceX96 uint160.
 */
export function decodeSwap(log) {
  try {
    if (!log.topics || log.topics.length < 3) return null
    const data = (log.data || '').startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 192) return null
    const amount0 = decodeInt256('0x' + data.slice(0, 64))
    const amount1 = decodeInt256('0x' + data.slice(64, 128))
    const sqrtPriceX96 = BigInt('0x' + data.slice(128, 192))
    if (sqrtPriceX96 === 0n) return null
    return {
      sender: topicAddress(log.topics[1]),
      recipient: topicAddress(log.topics[2]),
      amount0,
      amount1,
      sqrtPriceX96,
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex ?? 0),
      transactionHash: log.transactionHash,
    }
  } catch {
    return null
  }
}

/** Sell (trader gives FUEL to the pool) = amount1 > 0; buy = amount1 < 0. */
export function swapSide(amount1) {
  if (amount1 > 0n) return 'sell'
  if (amount1 < 0n) return 'buy'
  return null
}

/** WETH per FUEL from sqrtPriceX96. token0 = WETH, token1 = FUEL. */
export function execPriceWethPerFuel(sqrtPriceX96) {
  const ratio = Number(sqrtPriceX96) / 2 ** 96
  return 1 / (ratio * ratio)
}

/**
 * Decode a FUEL transfer log under the standard layout
 * (topics[1] = from, topics[2] = to, data word 0 = amount).
 * Returns null when malformed.
 */
export function decodeTransfer(log) {
  try {
    if (!log.topics || log.topics.length < 3) return null
    const data = (log.data || '').startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 64) return null
    return {
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      amountWei: BigInt('0x' + data.slice(0, 64)),
      topic: (log.topics[0] || '').toLowerCase(),
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex ?? 0),
      transactionHash: log.transactionHash,
    }
  } catch {
    return null
  }
}

/**
 * Decode a BatchMinter mint-batch event: topics[1] = wallet,
 * data word 0 = batch start index, data word 1 = batch size.
 * batchTotal = start + size = the wallet's position count after this event.
 */
export function decodeMinterEvent(log) {
  try {
    if (!log.topics || log.topics.length < 2) return null
    const data = (log.data || '').startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 128) return null
    const batchStart = BigInt('0x' + data.slice(0, 64))
    const batchSize = BigInt('0x' + data.slice(64, 128))
    return {
      wallet: topicAddress(log.topics[1]),
      batchStart,
      batchSize,
      batchTotal: batchStart + batchSize,
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex ?? 0),
      transactionHash: log.transactionHash,
    }
  } catch {
    return null
  }
}

/** Calendar day in America/New_York for a unix timestamp. */
export function etDate(tsSeconds) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(tsSeconds) * 1000))
}

export const minterKey = (addr) => `${MINTER_KEY_PREFIX}${addr.toLowerCase()}`
export const mintContractKey = (addr) => `${MINT_CONTRACT_KEY_PREFIX}${addr.toLowerCase()}`
export const dayKey = (dateStr) => `${DAY_KEY_PREFIX}${dateStr}`

// ---------------------------------------------------------------------------
// Chain reader (raw JSON-RPC; injectable transport for tests)
// ---------------------------------------------------------------------------

function rpcPayload(id, method, params) {
  return { jsonrpc: '2.0', id, method, params }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RPC_MAX_ATTEMPTS = 8

async function rpcHttpError(res) {
  // Include a capped snippet of the response body: providers often explain a
  // 400/413 (range limits, method restrictions, IP-based gating) in the
  // body, and without it the failure is undebuggable from worker logs.
  // Capped so a huge HTML error page can't flood the logs. This also lets
  // isLogLimitError() see provider-described limits ("exceeds block range
  // limit") so getLogsRange() can halve-and-retry them.
  let detail = ''
  try {
    const text = typeof res.text === 'function' ? await res.text() : ''
    if (text) detail = `: ${String(text).slice(0, 300).replace(/\s+/g, ' ').trim()}`
  } catch {
    // Body unreadable — the status code alone is the signal.
  }
  return new Error(`RPC HTTP ${res.status}${detail}`)
}

async function rpcFetch(fetchImpl, url, payload, { timeoutMs = 30000 } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (res.ok) return await res.json()
      lastError = await rpcHttpError(res)
      if (!RETRYABLE_STATUS.has(res.status)) throw lastError
      // Honor the node's Retry-After hint when present.
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 300) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000))
        continue
      }
    } catch (error) {
      lastError = error
      if (!/RPC HTTP (429|502|503|504)/.test(error?.message ?? '') && error?.name !== 'AbortError') {
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
    if (attempt < RPC_MAX_ATTEMPTS) {
      // 429s from this node can persist for a minute+; back off hard.
      const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 120000) + Math.floor(Math.random() * 1000)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw lastError
}

function assertNoRpcError(reply) {
  if (reply && typeof reply === 'object' && reply.error) {
    throw new Error(`RPC ${reply.error.code}: ${reply.error.message}`)
  }
  return reply?.result
}

/** Bounded-concurrency mapper. */
export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    }),
  )
  return results
}

function isLogLimitError(error) {
  return /limit|too many|response size/i.test(error?.message ?? '')
}

export function createChainReader({ fetchImpl = fetch, rpcUrl = PUBLIC_RPC_URL, concurrency = RPC_CONCURRENCY } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('chain reader requires a fetch implementation')

  async function batch(calls) {
    // calls: [[method, params], ...] -> results in order; throws on any item error
    const out = new Array(calls.length)
    const chunks = []
    for (let i = 0; i < calls.length; i += RPC_BATCH_SIZE) chunks.push([i, calls.slice(i, i + RPC_BATCH_SIZE)])
    await mapConcurrent(chunks, concurrency, async ([offset, chunk]) => {
      const payload = chunk.map(([method, params], j) => rpcPayload(offset + j, method, params))
      const replies = await rpcFetch(fetchImpl, rpcUrl, payload)
      const list = Array.isArray(replies) ? replies : [replies]
      if (list.length !== chunk.length) throw new Error('RPC batch shape mismatch')
      for (const reply of list) {
        const globalIndex = typeof reply.id === 'number' ? reply.id : offset
        out[globalIndex] = assertNoRpcError(reply)
      }
    })
    return out
  }

  async function single(method, params) {
    const reply = await rpcFetch(fetchImpl, rpcUrl, rpcPayload(1, method, params))
    return assertNoRpcError(reply)
  }

  async function getLogsRange(address, topics, fromBlock, toBlock) {
    // Halve the range when the node reports its 10000-log cap.
    const tryRange = async (from, to) => {
      try {
        const filter = { address, fromBlock: toMinHex(from), toBlock: toMinHex(to) }
        if (topics) filter.topics = topics
        return await single('eth_getLogs', [filter])
      } catch (error) {
        if (from >= to || !isLogLimitError(error)) throw error
        const mid = (from + to) / 2n
        return [...(await tryRange(from, mid)), ...(await tryRange(mid + 1n, to))]
      }
    }
    return tryRange(fromBlock, toBlock)
  }

  return {
    async headBlock() {
      return BigInt(await single('eth_blockNumber', []))
    },
    /** Chunked log scan over [fromBlock, toBlock]; topics may be null. */
    async logs({ address, topics = null, fromBlock, toBlock }) {
      const ranges = []
      for (let start = fromBlock; start <= toBlock; ) {
        const end = start + LOG_CHUNK_BLOCKS - 1n < toBlock ? start + LOG_CHUNK_BLOCKS - 1n : toBlock
        ranges.push([start, end])
        start = end + 1n
      }
      const parts = await mapConcurrent(ranges, concurrency, ([s, e]) => getLogsRange(address, topics, s, e))
      return parts.flat()
    },
    /** blockNumber bigint[] -> Map<blockNumberString, timestampSeconds> */
    async blockTimestamps(blockNumbers) {
      const uniq = [...new Set(blockNumbers.map(String))]
      const results = await batch(uniq.map((b) => ['eth_getBlockByNumber', [toMinHex(BigInt(b)), false]]))
      const map = new Map()
      for (let i = 0; i < uniq.length; i++) {
        const blk = results[i]
        if (!blk || blk.timestamp == null) throw new Error(`block ${uniq[i]} unavailable`)
        map.set(uniq[i], parseInt(blk.timestamp, 16))
      }
      return map
    },
    /** txHash[] -> Map<hash, {from, valueWei}> */
    async transactions(hashes) {
      const uniq = [...new Set(hashes)]
      const results = await batch(uniq.map((h) => ['eth_getTransactionByHash', [h]]))
      const map = new Map()
      for (let i = 0; i < uniq.length; i++) {
        const tx = results[i]
        if (!tx) throw new Error(`transaction ${uniq[i]} unavailable`)
        map.set(uniq[i], { from: (tx.from || '').toLowerCase(), valueWei: BigInt(tx.value || '0x0') })
      }
      return map
    },
    /** address[] -> Map<address, 'eoa'|'contract'> */
    async codeKind(addresses) {
      const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))]
      const results = await batch(uniq.map((a) => ['eth_getCode', [a, 'latest']]))
      const map = new Map()
      for (let i = 0; i < uniq.length; i++) {
        map.set(uniq[i], results[i] && results[i] !== '0x' ? 'contract' : 'eoa')
      }
      return map
    },
    /** WETH/USD via Dexscreener (highest-liquidity USD-quoted WETH pair). */
    async wethUsd() {
      try {
        return await fetchWethUsd({ fetchImpl, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
      } catch (error) {
        console.error(`minter collector: WETH/USD source failed (${error?.message ?? error})`)
        return null
      }
    },
    _batch: batch,
    _single: single,
  }
}

export const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

/** Re-discover the live FUEL transfer topic set from recent token logs. */
export async function discoverTransferTopics(chain, fromBlock, toBlock) {
  const logs = await chain.logs({ address: FUEL_TOKEN, fromBlock, toBlock })
  const found = new Set(logs.map((l) => (l.topics?.[0] || '').toLowerCase()).filter(Boolean))
  return [...new Set([...SEED_TRANSFER_TOPICS.map((s) => s.toLowerCase()), ...found])]
}

// ---------------------------------------------------------------------------
// Scan: read + decode one block range (no aggregation, no KV writes)
// ---------------------------------------------------------------------------

/**
 * Scan [fromBlock, toBlock] and return decoded events plus the touched
 * keyspace. Throws on any chain failure (all-or-nothing: callers must not
 * write anything when this throws).
 */
export async function scanRange(chain, fromBlock, toBlock, options = {}) {
  fromBlock = BigInt(fromBlock)
  toBlock = BigInt(toBlock)
  const empty = {
    fromBlock,
    toBlock,
    transfers: [],
    swaps: [],
    minterEvents: [],
    kindMap: new Map(),
    swapTxMap: new Map(),
    minterTxMap: new Map(),
    wethUsd: null,
    touched: { wallets: new Set(), contracts: new Set(), dates: new Set() },
  }
  if (toBlock < fromBlock) return empty
  const deadline = options.deadline ?? Date.now() + RUN_DEADLINE_MS
  const checkDeadline = () => {
    if (Date.now() >= deadline) throw new Error('minter collector: run budget exhausted; watermark retained')
  }

  const transferTopics =
    options.transferTopics ??
    (await discoverTransferTopics(chain, fromBlock > 20000n ? toBlock - 20000n : fromBlock, toBlock))
  checkDeadline()
  const [tokenLogs, poolLogs, minterLogs] = await Promise.all([
    chain.logs({ address: FUEL_TOKEN, topics: [transferTopics], fromBlock, toBlock }),
    chain.logs({ address: FUEL_WETH_POOL, topics: [POOL_SWAP_TOPIC], fromBlock, toBlock }),
    chain.logs({ address: BATCH_MINTER, fromBlock, toBlock }),
  ])
  checkDeadline()

  const blockNums = new Set()
  for (const l of [...tokenLogs, ...poolLogs, ...minterLogs]) blockNums.add(BigInt(l.blockNumber).toString())
  const tsMap = await chain.blockTimestamps([...blockNums].map(BigInt))
  const tsOf = (blockNumber) => tsMap.get(BigInt(blockNumber).toString())
  checkDeadline()

  const transfers = []
  for (const l of tokenLogs) {
    const t = decodeTransfer(l)
    if (t && t.amountWei > 0n) transfers.push({ ...t, ts: tsOf(t.blockNumber) })
  }
  const swaps = []
  for (const l of poolLogs) {
    const s = decodeSwap(l)
    const side = s && swapSide(s.amount1)
    if (s && side) swaps.push({ ...s, side, fuelWei: s.amount1 < 0n ? -s.amount1 : s.amount1, ts: tsOf(s.blockNumber) })
  }
  const minterEvents = []
  for (const l of minterLogs) {
    const e = decodeMinterEvent(l)
    if (e) minterEvents.push({ ...e, ts: tsOf(e.blockNumber) })
  }

  // Contract-ness lookups. Mint recipients are checked first; then ALL
  // transfer sources (a mint contract may have received its 0x0 mint in an
  // earlier range and only sweep now) and swap senders (rule 2).
  const mintRecipients = new Set()
  const allFroms = new Set()
  for (const t of transfers) {
    allFroms.add(t.from)
    if (isZeroAddress(t.from)) mintRecipients.add(t.to)
  }
  const kindMap = await chain.codeKind([...mintRecipients])
  const isContractAddr = (a) => kindMap.get(a) === 'contract'
  // Contracts seen receiving a 0x0 mint in THIS range are definitely mint contracts.
  const freshMintContracts = new Set([...mintRecipients].filter(isContractAddr))
  const kindMap2 = await chain.codeKind([...allFroms, ...swaps.map((s) => s.sender)])
  for (const [k, v] of kindMap2) kindMap.set(k, v)
  // Every contract that sends FUEL is a mint-contract candidate; the
  // aggregator confirms it against prior mintcontract rows (aggregateRange).
  const contractForwarders = new Set([...allFroms].filter((a) => !isZeroAddress(a) && kindMap.get(a) === 'contract'))
  checkDeadline()

  // Swap attribution (rule 2): router-mediated swaps resolve to tx.from.
  const contractSenders = swaps.filter((s) => kindMap.get(s.sender) === 'contract')
  const swapTxMap = contractSenders.length
    ? await chain.transactions(contractSenders.map((s) => s.transactionHash))
    : new Map()
  const swapWallets = []
  for (const s of swaps) {
    let wallet
    if (kindMap.get(s.sender) === 'contract') {
      const tx = swapTxMap.get(s.transactionHash)
      if (!tx) throw new Error(`minter collector: transaction ${s.transactionHash} unavailable`)
      wallet = tx.from
    } else {
      wallet = s.sender
    }
    swapWallets.push({ swap: s, wallet })
  }
  checkDeadline()

  // USD calibration: direct WETH/USD (never derived from FUEL/USD — the old
  // fuelUsd ÷ latest-execution-price derivation mixed the *current* FUEL price
  // with each window's *latest* execution price, so historical backfill windows
  // were mis-valued by orders of magnitude). Per-swap USD = FUEL amount × that
  // swap's execution price × WETH/USD, so intraday price moves are captured
  // per swap instead of smeared across the window.
  const wethUsd = await chain.wethUsd().catch((error) => {
    console.error(`minter collector: WETH/USD unavailable (${error?.message ?? error}); USD will be null`)
    return null
  })

  const minterTxHashes = [...new Set(minterEvents.map((e) => e.transactionHash))]
  const minterTxMap = minterTxHashes.length ? await chain.transactions(minterTxHashes) : new Map()

  const touched = { wallets: new Set(), contracts: new Set(), dates: new Set() }
  for (const { wallet } of swapWallets) touched.wallets.add(wallet)
  for (const t of transfers) {
    if (isZeroAddress(t.from)) {
      if (freshMintContracts.has(t.to)) touched.contracts.add(t.to)
      else touched.wallets.add(t.to)
    } else if (contractForwarders.has(t.from)) {
      // Candidate mint contract (confirmed against prior rows in aggregateRange).
      touched.contracts.add(t.from)
      touched.wallets.add(t.to)
    }
  }
  for (const e of minterEvents) touched.wallets.add(e.wallet)
  for (const { swap } of swapWallets) touched.dates.add(etDate(swap.ts))

  return {
    fromBlock,
    toBlock,
    transfers,
    swaps: swapWallets,
    minterEvents,
    kindMap,
    mintRecipients,
    minterTxMap,
    wethUsd,
    touched,
  }
}

// ---------------------------------------------------------------------------
// Aggregate: merge scanned events into prior state (pure)
// ---------------------------------------------------------------------------

function emptyMinterRow() {
  return {
    claimedWei: 0n,
    soldWei: 0n,
    boughtWei: 0n,
    mintsOpened: 0n,
    remintCount: 0n,
    remintEthWei: 0n,
    firstClaimTs: null,
    firstSaleTs: null,
    lastActiveTs: null,
    updatedBlock: -1n,
  }
}

function emptyDayRec(date) {
  return {
    date,
    buyers: new Map(), // wallet -> {fuelWei, usd}
    sellers: new Map(),
    buyVolUsd: 0,
    sellVolUsd: 0,
    usdMissing: 0,
    nBuys: 0,
    nSells: 0,
    lastBlock: -1n,
  }
}

function rowFromStored(stored) {
  const row = emptyMinterRow()
  if (!stored || typeof stored !== 'object') return row
  try {
    row.claimedWei = BigInt(stored.claimed ?? 0)
    row.soldWei = BigInt(stored.sold ?? 0)
    row.boughtWei = BigInt(stored.bought ?? 0)
    row.mintsOpened = BigInt(stored.mints_opened ?? 0)
    row.remintCount = BigInt(stored.remint_count ?? 0)
    row.remintEthWei = BigInt(stored.remint_eth_wei ?? 0)
  } catch {
    return emptyMinterRow()
  }
  row.firstClaimTs = stored.first_claim_ts ?? null
  row.firstSaleTs = stored.first_sale_ts ?? null
  row.lastActiveTs = stored.last_active_ts ?? null
  row.updatedBlock = stored.updated_block != null ? BigInt(stored.updated_block) : -1n
  return row
}

export function rowToStored(addr, row, updatedBlock) {
  const pct = row.claimedWei > 0n ? Number((row.soldWei * 10000n) / row.claimedWei) / 100 : null
  return {
    wallet: addr,
    claimed: row.claimedWei.toString(),
    sold: row.soldWei.toString(),
    bought: row.boughtWei.toString(),
    // % sold can exceed 100% when the wallet also bought FUEL; shown raw, labeled.
    pct_sold: pct,
    mints_opened: row.mintsOpened.toString(),
    remint_count: row.remintCount.toString(),
    remint_eth_wei: row.remintEthWei.toString(),
    first_claim_ts: row.firstClaimTs,
    first_sale_ts: row.firstSaleTs,
    last_active_ts: row.lastActiveTs,
    updated_block: updatedBlock.toString(),
  }
}

function emptyContractState() {
  return { totalWei: 0n, attributedWei: 0n, operator: null, firstMintTs: null, lastMintTs: null, scanBlock: -1n }
}

function contractFromStored(stored) {
  if (!stored || typeof stored !== 'object') return emptyContractState()
  try {
    return {
      totalWei: BigInt(stored.total_wei ?? 0),
      attributedWei: BigInt(stored.attributed_wei ?? 0),
      operator: stored.operator ?? null,
      firstMintTs: stored.first_mint_ts ?? null,
      lastMintTs: stored.last_mint_ts ?? null,
      scanBlock: stored.scan_block != null ? BigInt(stored.scan_block) : -1n,
    }
  } catch {
    return emptyContractState()
  }
}

export function contractToStored(c) {
  return {
    total_wei: c.totalWei.toString(),
    attributed_wei: c.attributedWei.toString(),
    operator: c.operator,
    first_mint_ts: c.firstMintTs,
    last_mint_ts: c.lastMintTs,
    scan_block: c.scanBlock.toString(),
  }
}

function dayFromStored(stored) {
  const rec = emptyDayRec(stored?.date)
  if (!stored || typeof stored !== 'object') return rec
  for (const side of ['buyers', 'sellers']) {
    const list = Array.isArray(stored[side]) ? stored[side] : []
    for (const entry of list) {
      if (!entry || typeof entry.w !== 'string') continue
      try {
        rec[side].set(entry.w.toLowerCase(), {
          fuelWei: BigInt(entry.fuel ?? 0),
          usd: typeof entry.usd === 'number' ? entry.usd : null,
        })
      } catch { /* skip malformed entries */ }
    }
  }
  rec.buyVolUsd = typeof stored.buy_vol_usd === 'number' ? stored.buy_vol_usd : 0
  rec.sellVolUsd = typeof stored.sell_vol_usd === 'number' ? stored.sell_vol_usd : 0
  rec.usdMissing = Number.isInteger(stored.usd_missing) ? stored.usd_missing : 0
  rec.nBuys = Number.isInteger(stored.n_buys) ? stored.n_buys : 0
  rec.nSells = Number.isInteger(stored.n_sells) ? stored.n_sells : 0
  rec.lastBlock = stored.last_block != null ? BigInt(stored.last_block) : -1n
  return rec
}

export function dayToStored(rec) {
  // Rank by FUEL amount — the thing being measured — with USD as the tiebreak.
  // (Sorting by USD let volatile intraday prices reorder the board.)
  const top = (map) =>
    [...map.entries()]
      .sort((a, b) =>
        (b[1].fuelWei > a[1].fuelWei ? 1 : b[1].fuelWei < a[1].fuelWei ? -1 : 0) ||
        (b[1].usd ?? -1) - (a[1].usd ?? -1),
      )
      .slice(0, DAY_TOP_N)
      .map(([w, v]) => ({ w, fuel: v.fuelWei.toString(), usd: v.usd }))
  return {
    date: rec.date,
    buyers: top(rec.buyers),
    sellers: top(rec.sellers),
    buy_vol_usd: rec.buyVolUsd,
    sell_vol_usd: rec.sellVolUsd,
    usd_missing: rec.usdMissing,
    n_buys: rec.nBuys,
    n_sells: rec.nSells,
    last_block: rec.lastBlock.toString(),
  }
}

/**
 * Merge scanned events into prior state.
 * prior: {minters, contracts, days} as Maps of addr/date -> STORED rows
 * (the JSON shapes produced by rowToStored/contractToStored/dayToStored;
 * only touched keys need be present). Passing working (BigInt) rows is a
 * programming error: field names differ and values would silently reset.
 * Never mutates prior. Returns merged {minters, contracts, days, stats}.
 */
export function aggregateRange(scanned, prior = null) {
  const { fromBlock, toBlock, transfers, swaps, minterEvents, kindMap, minterTxMap, wethUsd } = scanned

  const minters = new Map()
  for (const [addr, stored] of prior?.minters ?? []) minters.set(addr, rowFromStored(stored))
  const contracts = new Map()
  for (const [addr, stored] of prior?.contracts ?? []) contracts.set(addr, contractFromStored(stored))
  const days = new Map()
  for (const [date, stored] of prior?.days ?? []) days.set(date, dayFromStored(stored))
  // A contract counts as a mint contract when it received a 0x0 mint in this
  // range, or when a prior mintcontract row proves it minted earlier (its
  // sweep can land in a later range than its mint).
  const priorContractAddrs = new Set(contracts.keys())
  const isMintContract = (addr) =>
    kindMap.get(addr) === 'contract' &&
    (scanned.mintRecipients?.has(addr) === true || priorContractAddrs.has(addr))
  const minterRow = (addr) => {
    let row = minters.get(addr)
    if (!row) {
      row = emptyMinterRow()
      minters.set(addr, row)
    }
    return row
  }
  const contractState = (addr) => {
    let c = contracts.get(addr)
    if (!c) {
      c = emptyContractState()
      contracts.set(addr, c)
    }
    return c
  }

  // --- Mint attribution (rule 1) ---
  const receipts = transfers
    .filter((t) => isZeroAddress(t.from))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex))
  for (const r of receipts) {
    if (isMintContract(r.to)) {
      const c = contractState(r.to)
      if (r.blockNumber <= c.scanBlock) continue
      c.totalWei += r.amountWei
      c.firstMintTs = c.firstMintTs == null ? r.ts : Math.min(c.firstMintTs, r.ts)
      c.lastMintTs = c.lastMintTs == null ? r.ts : Math.max(c.lastMintTs, r.ts)
    } else {
      const row = minterRow(r.to)
      if (r.blockNumber <= row.updatedBlock) continue
      row.claimedWei += r.amountWei
      row.firstClaimTs = row.firstClaimTs == null ? r.ts : Math.min(row.firstClaimTs, r.ts)
      if (row.lastActiveTs == null || r.ts > row.lastActiveTs) row.lastActiveTs = r.ts
    }
  }
  const forwards = transfers
    .filter((t) => isMintContract(t.from))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex))
  for (const f of forwards) {
    const c = contractState(f.from)
    if (f.blockNumber <= c.scanBlock) continue
    // First EOA this mint contract forwards FUEL to becomes the operator.
    if (!c.operator && kindMap.get(f.to) === 'eoa') c.operator = f.to
  }
  // Attribute each contract's newly minted FUEL to its operator exactly once.
  for (const c of contracts.values()) {
    if (c.scanBlock < toBlock) c.scanBlock = toBlock
    if (!c.operator) continue
    const delta = c.totalWei - c.attributedWei
    if (delta > 0n) {
      const row = minterRow(c.operator)
      row.claimedWei += delta
      if (c.firstMintTs != null) row.firstClaimTs = row.firstClaimTs == null ? c.firstMintTs : Math.min(row.firstClaimTs, c.firstMintTs)
      if (c.lastMintTs != null && (row.lastActiveTs == null || c.lastMintTs > row.lastActiveTs)) row.lastActiveTs = c.lastMintTs
      c.attributedWei = c.totalWei
    }
  }

  // --- Swap attribution (rule 2, resolved during scan) + daily buckets ---
  for (const { swap: s, wallet } of swaps) {
    const row = minterRow(wallet)
    const exec = execPriceWethPerFuel(s.sqrtPriceX96)
    const usd = wethUsd != null && Number.isFinite(exec) && exec > 0 ? (Number(s.fuelWei) / 1e18) * exec * wethUsd : null
    // Rule 4: a minter's sold/first_sale only counts FUEL sold AFTER their first
    // attributed claim (pre-claim swaps can't be sales of claimed FUEL).
    // Buys are informational and counted regardless. Daily buckets are independent.
    if (s.blockNumber > row.updatedBlock) {
      const afterClaim = row.firstClaimTs != null && s.ts > row.firstClaimTs
      if (s.side === 'sell') {
        if (afterClaim) {
          row.soldWei += s.fuelWei
          row.firstSaleTs = row.firstSaleTs == null ? s.ts : Math.min(row.firstSaleTs, s.ts)
        }
      } else {
        row.boughtWei += s.fuelWei
      }
      if (row.lastActiveTs == null || s.ts > row.lastActiveTs) row.lastActiveTs = s.ts
    }
    // Daily leaderboard bucket (ET day), independent of the wallet row filter.
    const date = etDate(s.ts)
    let rec = days.get(date)
    if (!rec) {
      rec = emptyDayRec(date)
      days.set(date, rec)
    }
    if (s.blockNumber > rec.lastBlock) {
      const side = s.side === 'sell' ? rec.sellers : rec.buyers
      const prev = side.get(wallet) ?? { fuelWei: 0n, usd: null }
      side.set(wallet, {
        fuelWei: prev.fuelWei + s.fuelWei,
        usd: usd == null ? prev.usd : (prev.usd ?? 0) + usd,
      })
      if (usd == null) rec.usdMissing++
      else if (s.side === 'sell') rec.sellVolUsd += usd
      else rec.buyVolUsd += usd
      if (s.side === 'sell') rec.nSells++
      else rec.nBuys++
    }
  }
  for (const rec of days.values()) if (rec.lastBlock < toBlock) rec.lastBlock = toBlock

  // --- Re-mint (rule 3): BatchMinter events after the wallet's first sale ---
  const orderedEvents = [...minterEvents].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex,
  )
  const seenTx = new Set()
  for (const e of orderedEvents) {
    const row = minterRow(e.wallet)
    if (e.blockNumber > row.updatedBlock && e.batchTotal > row.mintsOpened) {
      const delta = e.batchTotal - row.mintsOpened
      row.mintsOpened = e.batchTotal
      if (row.firstSaleTs != null && e.ts > row.firstSaleTs) {
        row.remintCount += delta
        if (!seenTx.has(e.transactionHash)) {
          seenTx.add(e.transactionHash)
          row.remintEthWei += minterTxMap.get(e.transactionHash)?.valueWei ?? 0n
        }
      }
    }
  }

  for (const row of minters.values()) if (row.updatedBlock < toBlock) row.updatedBlock = toBlock

  return {
    minters,
    contracts,
    days,
    stats: { swaps: swaps.length, transfers: transfers.length, minterEvents: minterEvents.length, wethUsd },
  }
}

/** Scan then aggregate with prior state threaded through (used by the backfill). */
export async function collectRange(chain, fromBlock, toBlock, prior = null, options = {}) {
  const scanned = await scanRange(chain, fromBlock, toBlock, options)
  return aggregateRange(scanned, prior)
}

// ---------------------------------------------------------------------------
// KV serialization
// ---------------------------------------------------------------------------

export function serializeState(minters, contracts, days, updatedBlock) {
  const minterEntries = []
  for (const [addr, row] of minters) {
    // Rule 4: wallets that only bought/sold (never claimed) get no minter row.
    if (row.claimedWei <= 0n) continue
    minterEntries.push([minterKey(addr), rowToStored(addr, row, updatedBlock)])
  }
  const contractEntries = []
  for (const [addr, c] of contracts) contractEntries.push([mintContractKey(addr), contractToStored(c)])
  const dayEntries = []
  for (const [date, rec] of days) dayEntries.push([dayKey(date), dayToStored(rec)])
  return { minterEntries, contractEntries, dayEntries }
}

// ---------------------------------------------------------------------------
// Write bounding (free-tier KV quota: 1,000 writes/day/account).
// ---------------------------------------------------------------------------

// Marker fields that advance every run but carry no content: the block each
// row was last scanned through. Excluded from change detection so a quiet
// hour writes ~0 keys (plus the meta watermark) instead of ~1,640.
const CONTENT_MARKER_FIELDS = new Set(['updated_block', 'last_block', 'scan_block'])

/**
 * Deterministic content signature of a stored row, ignoring marker fields.
 * Two runs that produce the same content yield the same signature even
 * though the markers advanced.
 */
export function contentSignature(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(contentSignature).join(',')}]`
  const parts = []
  for (const k of Object.keys(value).sort()) {
    if (CONTENT_MARKER_FIELDS.has(k)) continue
    parts.push(`${JSON.stringify(k)}:${contentSignature(value[k])}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Return only [key, value] pairs whose content differs from priorByKey
 * (a Map of key -> previously stored row), or that have no prior row.
 * Marker-only differences (updated_block/last_block/scan_block) are skipped:
 * the watermark in meta:minter-collector is the cross-run dedup mechanism,
 * so skipping an unchanged row can never lose data — the next run re-scans
 * from the watermark and re-derives the same content if anything changed.
 */
export function selectChangedEntries(entries, priorByKey) {
  const out = []
  for (const [key, value] of entries) {
    const prior = priorByKey.get(key)
    if (prior == null || contentSignature(prior) !== contentSignature(value)) out.push([key, value])
  }
  return out
}

async function listKeys(kv, prefix) {
  const keys = []
  let cursor
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 })
    for (const k of page.keys ?? []) keys.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return keys
}

// ---------------------------------------------------------------------------
// Scheduled entry point (worker cron)
// ---------------------------------------------------------------------------

async function readMeta(kv) {
  try {
    const raw = await kv.get(META_KEY, 'json')
    if (raw && typeof raw === 'object') {
      return {
        lastBlock: raw.last_block != null ? BigInt(raw.last_block) : null,
        backfillDone: raw.backfill_done === true,
      }
    }
  } catch (error) {
    console.error('minter collector: meta read failed:', error?.message ?? error)
    throw error
  }
  return { lastBlock: null, backfillDone: false }
}

/**
 * Hourly run: scan from the watermark to head, load prior state for the
 * touched keyspace, merge, write KV, advance the watermark.
 * All-or-nothing: the watermark advances only after every write succeeds;
 * per-row updated_block/scan_block markers make a retried range idempotent.
 *
 * Write bounding (free-tier KV quota): only keys whose CONTENT changed are
 * PUT — marker-only differences are skipped. A quiet hour writes ~0 data
 * keys + the meta watermark; an active hour writes only touched rows.
 * Contract rows are internal collector bookkeeping (never read by the UI)
 * but must persist: a mint whose sweep lands in a later range is attributed
 * exactly once via the persisted contract state. After the backfill they are
 * static, so they cost ~0 writes/hour.
 */
export async function runMinterCollector(env, options = {}) {
  if (!env?.ACTIVITY || typeof env.ACTIVITY.get !== 'function' || typeof env.ACTIVITY.put !== 'function') {
    console.error('minter collector skipped: ACTIVITY KV binding unavailable')
    return { ok: false, reason: 'kv-unavailable' }
  }
  const kv = env.ACTIVITY
  const fetchImpl = options.fetchImpl ?? fetch
  const rpcUrl = options.rpcUrl ?? resolveRpcUrl(env)
  const chain = options.chain ?? createChainReader({ fetchImpl, rpcUrl })

  let meta
  try {
    meta = await readMeta(kv)
  } catch {
    return { ok: false, reason: 'meta-unreadable' }
  }
  let head
  try {
    head = await chain.headBlock()
  } catch (error) {
    console.error('minter collector: head block unreadable:', error?.message ?? error)
    return { ok: false, reason: 'head-unreadable' }
  }
  const fromBlock = meta.lastBlock == null ? FUEL_FIRST_BLOCK : meta.lastBlock + 1n
  if (fromBlock > head) {
    console.log('minter collector: already at head; nothing to do')
    return { ok: true, fromBlock: fromBlock.toString(), toBlock: head.toString(), empty: true }
  }
  // Bound per-run work for the free tier; catch up over successive hours.
  const runTo = head - fromBlock > MAX_RUN_BLOCKS ? fromBlock + MAX_RUN_BLOCKS : head

  let scanned
  try {
    const probeTo = head
    const probeFrom = head > 20000n ? head - 20000n : 0n
    const transferTopics = await discoverTransferTopics(chain, probeFrom, probeTo)
    scanned = await scanRange(chain, fromBlock, runTo, { transferTopics, deadline: options.deadline })
  } catch (error) {
    console.error('minter collector: range scan failed:', error?.message ?? error)
    return { ok: false, reason: 'scan-failed' }
  }

  // Load prior state for exactly the touched keyspace (bounded: hundreds to
  // low thousands of keys on a busy hour). Reads happen before any write.
  // Minter rows are loaded via a full prefix listing instead of only the
  // touched wallets: change detection needs a baseline for every existing
  // row (a quiet hour must compare all 16 and skip them, not rewrite them).
  // Touched non-minter wallets need no preload — a first-time claimer has
  // no prior row by definition.
  let prior
  try {
    const minterKeys = await listKeys(kv, MINTER_KEY_PREFIX)
    const [minterRows, contractRows, dayRows] = await Promise.all([
      mapConcurrent(
        minterKeys,
        RPC_CONCURRENCY,
        async (key) => [key.slice(MINTER_KEY_PREFIX.length), await kv.get(key, 'json')],
      ),
      mapConcurrent(
        [...scanned.touched.contracts],
        RPC_CONCURRENCY,
        async (addr) => [addr, await kv.get(mintContractKey(addr), 'json')],
      ),
      mapConcurrent(
        [...scanned.touched.dates],
        RPC_CONCURRENCY,
        async (date) => [date, await kv.get(dayKey(date), 'json')],
      ),
    ])
    prior = {
      minters: new Map(minterRows.filter(([, v]) => v != null)),
      contracts: new Map(contractRows.filter(([, v]) => v != null)),
      days: new Map(dayRows.filter(([, v]) => v != null)),
    }
  } catch (error) {
    console.error('minter collector: prior state unreadable:', error?.message ?? error)
    return { ok: false, reason: 'prior-unreadable' }
  }

  const state = aggregateRange(scanned, prior)
  const { minterEntries, contractEntries, dayEntries } = serializeState(
    state.minters,
    state.contracts,
    state.days,
    runTo,
  )
  // Write-bounding: PUT only keys whose content actually changed. The block
  // watermark in meta advances every successful run regardless, so skipping
  // an unchanged row is safe (see selectChangedEntries).
  const priorByKey = new Map()
  for (const [addr, stored] of prior.minters) priorByKey.set(minterKey(addr), stored)
  for (const [addr, stored] of prior.contracts) priorByKey.set(mintContractKey(addr), stored)
  for (const [date, stored] of prior.days) priorByKey.set(dayKey(date), stored)
  const allEntries = [...minterEntries, ...contractEntries, ...dayEntries]
  const changed = selectChangedEntries(allEntries, priorByKey)
  try {
    for (const [key, value] of changed) {
      await kv.put(key, JSON.stringify(value))
    }
    await kv.put(
      META_KEY,
      JSON.stringify({
        last_block: runTo.toString(),
        last_run_ts: Math.floor(Date.now() / 1000),
        status: 'ok',
        backfill_done: meta.backfillDone,
      }),
    )
  } catch (error) {
    console.error('minter collector: KV write failed:', error?.message ?? error)
    return { ok: false, reason: 'storage-failed' }
  }
  console.log(
    `minter collector: ok through block ${runTo} ` +
      `(${state.stats.swaps} swaps, ${state.stats.transfers} transfers, ${state.stats.minterEvents} minter events; ` +
      `${changed.length}/${allEntries.length} keys written, ${allEntries.length - changed.length} unchanged skipped)`,
  )
  return {
    ok: true,
    fromBlock: fromBlock.toString(),
    toBlock: runTo.toString(),
    keysWritten: changed.length,
    keysSkipped: allEntries.length - changed.length,
  }
}
