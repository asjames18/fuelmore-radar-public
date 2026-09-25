// FUEL buy-and-burn history collector for the FUEL/MORE Radar (FUEL only).
//
// Worker cron (every 5 minutes): reads BuyAndBurn events from the FUEL Buy & Burn
// contract and maintains:
//   burns:daily            daily series [{date, fuel, eth, drips}]
//   meta:burn-collector    watermark {last_block, last_run_ts, status}
//
// Conventions follow server/minter-collect.mjs: all-or-nothing per run,
// injectable chain reader for tests, null-never-zero, read-only RPC,
// write-bounded (a quiet tick writes ~1 key: the meta watermark; the daily
// series is PUT only when new drips landed).
//
// Verified on-chain 2026-09-22 (do NOT replace with textbook values):
// - FUEL Buy & Burn: 0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2
//   (Sourcify-verified). Each drip emits BuyAndBurn(ethAmount, tokenBurnt,
//   caller) — all three params INDEXED, so amounts live in topics[1] and
//   topics[2] — plus a TokenBurned(tokenBurnt) event with identical amounts.
//   Count each drip once (via BuyAndBurn).
// - FUEL burns are true supply burns via token.burn() (totalSupply
//   decreases). The MORE burner is a different contract and is NOT tracked
//   here (its "burns" go to the dead address — supply-neutral).
// - First drip observed at block ~63,120,000 (2026-09-14 22:12 UTC).

import { createChainReader, toMinHex, hexToBigInt, FUEL_TOKEN, ZERO_ADDRESS } from './minter-collect.mjs'
import { resolveBurnRpcUrl, resolveBurnLogRange, resolveRpcUrls } from './rpc-config.mjs'

export const FUEL_BURNER = '0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2'
// keccak256("BuyAndBurn(uint256,uint256,address)")
export const BUY_AND_BURN_TOPIC =
  '0x1b3ed074dce570943c9d4e66776a060e8ac73af4f6b002482b09e561d90f038c'

export const BURNS_KEY = 'burns:daily'
export const BURN_META_KEY = 'meta:burn-collector'

/** Official Blockscout explorer REST v2 (indexed logs; free, keyless). */
export const BLOCKSCOUT_API = 'https://robinhoodchain.blockscout.com/api/v2'
/** alchemy_getAssetTransfers page size (hex). Drips average ~17/day. */
export const TRANSFERS_MAX_COUNT = '0x3e8'

export const BURN_FIRST_BLOCK = 63115000n
// Per-run block budget: 16,000 blocks. The indexed transports (transfers API,
// Blockscout) have no range cap, but the shared watermark advance and the
// last-resort log scan both stay inside this budget. At ~96ms/block the chain
// makes ~3.1k blocks per 5-minute tick, so the watermark converges quickly.
// Subrequest math (worker free tier: 50 external subrequests PER INVOCATION,
// shared by the market snapshot and watchdog running in the same tick):
// 16 log batches + head ~= 17, leaving headroom for the market snapshot's
// own fetches in the same tick. 16k blocks/tick outpaces the chain's ~3.1k
// blocks per 5-minute tick, so the watermark converges over successive runs
// instead of falling behind.
export const BURN_MAX_RUN_BLOCKS = 16000n
// The collector reads from the MANAGED endpoint (resolveBurnRpcUrl ->
// resolveRpcUrl), not the public RPC: worker egress to the public RPC is
// rate-limited (HTTP 429 on every tick, including a post-backfill tiny
// scan — observed 2026-09-24 09:34Z), so the watermark never advanced from
// worker-side. The managed endpoint caps eth_getLogs at 10-block ranges
// (resolveBurnLogRange) and rate-limits compute units/sec; steady-state
// ticks scan only [watermark, head] (a few hundred blocks — the KV-era
// collector ran exactly this shape), so the batched/paced scan fits inside
// both the 50-subrequest worker budget and the 4-minute deadline.
// BURN_RPC_URL / BURN_LOG_RANGE env overrides preserved for ops flexibility
// (e.g. a sandbox-style catch-up via a high-range endpoint).
export const BURN_LOG_BATCH_CALLS = 100
export const BURN_BATCH_PACING_MS = 2500
export const BURN_RPC_CONCURRENCY = 1
export const BURN_RUN_DEADLINE_MS = 4 * 60 * 1000

export const BURN_METHODOLOGY =
  'Daily FUEL buy-and-burns read from BuyAndBurn events emitted by the FUEL ' +
  'Buy & Burn contract (0x1f8e…2D4A). FUEL burns are true supply burns via ' +
  'token.burn() — totalSupply decreases. MORE burns are not included: the ' +
  'MORE burner sends tokens to a dead address (supply-neutral). No USD ' +
  'figures are shown: FUEL/USD moved too violently during the September ' +
  '2026 crash to present responsibly.'

const WEI_PER_TOKEN = 10n ** 18n

/**
 * Decode one BuyAndBurn log. All params are indexed: topics[1] = ethAmount
 * (uint256 wei), topics[2] = tokenBurnt (uint256 wei), topics[3] = caller.
 * Returns null for anything that is not a burner drip.
 */
export function decodeBurnLog(log) {
  try {
    if (!log || typeof log !== 'object') return null
    if (String(log.address ?? '').toLowerCase() !== FUEL_BURNER.toLowerCase()) return null
    const topics = Array.isArray(log.topics) ? log.topics : []
    if (topics[0]?.toLowerCase() !== BUY_AND_BURN_TOPIC.toLowerCase()) return null
    if (topics.length < 4) return null
    const ethWei = hexToBigInt(topics[1])
    const fuelWei = hexToBigInt(topics[2])
    if (ethWei < 0n || fuelWei <= 0n) return null
    const blockNumber = hexToBigInt(log.blockNumber)
    const logIndex = log.logIndex != null ? hexToBigInt(log.logIndex).toString() : null
    if (logIndex == null) return null
    return {
      ethWei,
      fuelWei,
      blockNumber,
      txHash: String(log.transactionHash ?? ''),
      dripId: `${blockNumber.toString()}:${logIndex}`,
    }
  } catch {
    return null
  }
}

/** Block timestamp (seconds) -> UTC calendar date 'YYYY-MM-DD'. */
export function utcDate(tsSeconds) {
  const n = Number(tsSeconds)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString().slice(0, 10)
}

/**
 * Full merge: stored series + fresh per-drip detail.
 */
function weiToTokensFloat(wei) {
  // Precision note: values here are display-sized (millions of FUEL);
  // exact wei accounting lives on-chain. Conversion keeps 6 decimals so the
  // JSON payload never carries float-division artifacts like 5031.290000000001.
  return Math.round(Number(wei) / 1e12) / 1e6
}

/**
 * Full merge: stored series + fresh per-drip detail.
 * freshDrips: Map date -> { dripWei: [{ethWei, fuelWei, dripId}] }
 * Returns { days, totals, changed }.
 */
export function mergeBurnSeries(stored, freshByDate) {
  const byDate = new Map()
  for (const d of stored?.days ?? []) {
    // Seeded days carry rounded aggregates without per-drip IDs; keep their
    // stored drip count so a later merge never undercounts them.
    const storedDrips = Number(d.drips)
    const idSet = new Set(Array.isArray(d.dripIds) ? d.dripIds : [])
    byDate.set(d.date, {
      date: d.date,
      fuelWei: BigInt(Math.round(Number(d.fuel) * 1e18)),
      ethWei: BigInt(Math.round(Number(d.eth) * 1e18)),
      dripCount: Number.isFinite(storedDrips) && storedDrips >= 0 ? Math.round(storedDrips) : idSet.size,
      dripIds: idSet,
    })
  }
  let changed = false
  for (const [date, fresh] of freshByDate) {
    let day = byDate.get(date)
    if (!day) {
      day = { date, fuelWei: 0n, ethWei: 0n, dripCount: 0, dripIds: new Set() }
      byDate.set(date, day)
    }
    for (const drip of fresh.dripWei) {
      if (day.dripIds.has(drip.dripId)) continue
      day.dripIds.add(drip.dripId)
      day.fuelWei += drip.fuelWei
      day.ethWei += drip.ethWei
      day.dripCount += 1
      changed = true
    }
  }
  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      date: d.date,
      fuel: weiToTokensFloat(d.fuelWei),
      eth: weiToTokensFloat(d.ethWei),
      drips: d.dripCount,
      dripIds: [...d.dripIds].sort(),
    }))
  let totalFuelWei = 0n
  let totalEthWei = 0n
  let totalDrips = 0
  for (const d of byDate.values()) {
    totalFuelWei += d.fuelWei
    totalEthWei += d.ethWei
    totalDrips += d.dripCount
  }
  return {
    days,
    totals: {
      fuel: weiToTokensFloat(totalFuelWei),
      eth: weiToTokensFloat(totalEthWei),
      drips: totalDrips,
    },
    changed,
  }
}

/**
 * Aggregate decoded drips into day buckets with per-drip wei detail,
 * for the idempotent merge above.
 */
export function aggregateDripsDetail(drips, tsByBlock) {
  const days = new Map()
  for (const drip of drips) {
    const ts = tsByBlock.get(drip.blockNumber.toString())
    const date = ts != null ? utcDate(ts) : null
    if (date == null) continue
    let day = days.get(date)
    if (!day) {
      day = { date, dripWei: [] }
      days.set(date, day)
    }
    day.dripWei.push({ dripId: drip.dripId, fuelWei: drip.fuelWei, ethWei: drip.ethWei })
  }
  return days
}

async function readBurnMeta(kv) {
  try {
    const raw = await kv.get(BURN_META_KEY, 'json')
    if (raw && typeof raw === 'object') {
      return {
        lastBlock: raw.last_block != null ? BigInt(raw.last_block) : null,
      }
    }
  } catch (error) {
    console.error('burn collector: meta read failed:', error?.message ?? error)
    throw error
  }
  return { lastBlock: null }
}

/**
 * Best-effort failure record: the watermark only advances on success, so a
 * failing collector would otherwise be invisible (the meta keeps its old
 * 'seeded'/'ok' status forever). Records the failure reason without moving
 * last_block, so the next tick retries from the same watermark.
 */
async function recordBurnMetaError(kv, lastBlock, reason, error) {
  try {
    const detail =
      error?.message != null && String(error.message).trim() !== ''
        ? String(error.message).slice(0, 200)
        : error != null && typeof error !== 'object'
          ? String(error).slice(0, 200)
          : null
    await kv.put(
      BURN_META_KEY,
      JSON.stringify({
        last_block: lastBlock != null ? lastBlock.toString() : null,
        last_run_ts: Math.floor(Date.now() / 1000),
        status: 'error',
        reason,
        ...(detail ? { error: detail } : {}),
      }),
    )
  } catch {
    // Diagnostics are best-effort; the error is already logged.
  }
}

/**
 * Transport registry for the burns collector. Each transport resolves
 * { drips, tsByBlock } for [fromBlock, toBlock] or throws; runBurnCollector
 * tries them in order and the first success wins. Drip identification is
 * identical in every transport: decodeBurnLog on BuyAndBurn logs.
 */
const TRANSPORTS = {
  transfers: ({ fetchImpl, rpcUrls, chain, fromBlock, toBlock }) =>
    fetchBurnDripsViaTransfers({ fetchImpl, rpcUrls, chain, fromBlock, toBlock }),
  blockscout: async ({ fetchImpl, fromBlock, toBlock }) => {
    const { logs, tsByBlock: ts } = await fetchBurnLogsBlockscout({ fetchImpl, fromBlock, toBlock })
    const drips = []
    for (const log of logs) {
      const drip = decodeBurnLog(log)
      if (drip) drips.push(drip)
    }
    return { drips, tsByBlock: ts }
  },
  scan: async ({ chain, fromBlock, toBlock, rangeBlocks }) => {
    // Last resort: range size comes from resolveBurnLogRange — 10 blocks on
    // the managed endpoint, so a steady-state tick is a small number of
    // paced eth_getLogs batches (BURN_LOG_BATCH_CALLS per batch,
    // BURN_BATCH_PACING_MS apart, BURN_RPC_CONCURRENCY lanes).
    const logs = await chain.logsBatched({
      address: FUEL_BURNER,
      topics: [BUY_AND_BURN_TOPIC],
      fromBlock,
      toBlock,
      rangeBlocks,
      batchCalls: BURN_LOG_BATCH_CALLS,
      pacingMs: BURN_BATCH_PACING_MS,
    })
    const drips = []
    for (const log of logs) {
      const drip = decodeBurnLog(log)
      if (drip) drips.push(drip)
    }
    const ts = drips.length > 0 ? await chain.blockTimestamps(drips.map((d) => d.blockNumber)) : new Map()
    return { drips, tsByBlock: ts }
  },
}

/**
 * Transport 1 (primary): indexed token transfers.
 *
 * alchemy_getAssetTransfers finds FUEL Transfer(burner -> 0x0) events in
 * [fromBlock, toBlock] (indexed: no range caps, ~1 call per page), then
 * eth_getTransactionReceipt pulls the BuyAndBurn event out of each drip tx
 * so drip identification stays EXACTLY the decodeBurnLog path.
 * Verified on-chain 2026-09-24: every BuyAndBurn drip emits a matching
 * FUEL Transfer(burner -> 0x0) of the identical fuel amount.
 *
 * Returns { drips, tsByBlock }. tsByBlock comes from the transfers
 * metadata (blockTimestamp), so no eth_getBlockByNumber calls are needed.
 * A transfer whose tx carries no BuyAndBurn event is skipped with a
 * warning (never invented as a drip). A malformed transfers response
 * throws (treated as unsupported) rather than reading as "zero drips".
 */
export async function fetchBurnDripsViaTransfers({ fetchImpl, rpcUrls, chain, fromBlock, toBlock }) {
  const params = {
    fromBlock: toMinHex(fromBlock),
    toBlock: toMinHex(toBlock),
    contractAddresses: [FUEL_TOKEN],
    fromAddress: FUEL_BURNER,
    toAddress: ZERO_ADDRESS,
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: TRANSFERS_MAX_COUNT,
  }
  const transfers = []
  let pageKey = null
  for (;;) {
    const body = pageKey ? { ...params, pageKey } : params
    const result = await postTransfersPage({ fetchImpl, rpcUrls, body })
    if (!result || !Array.isArray(result.transfers)) {
      throw new Error('transfers transport: malformed response (method likely unsupported)')
    }
    for (const t of result.transfers) {
      if (!t || typeof t.hash !== 'string') continue
      transfers.push(t)
    }
    pageKey = result.pageKey ?? null
    if (!pageKey) break
  }
  const hashes = [...new Set(transfers.map((t) => t.hash))]
  const receipts = hashes.length > 0 ? await chain.receipts(hashes) : new Map()
  const drips = []
  const tsByBlock = new Map()
  for (const t of transfers) {
    const blockNumber = hexToBigInt(t.blockNum)
    const tsSeconds = t?.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : null
    if (tsSeconds != null && Number.isFinite(tsSeconds) && tsSeconds > 0) {
      tsByBlock.set(blockNumber.toString(), tsSeconds)
    }
    const receipt = receipts.get(t.hash)
    if (!receipt || !Array.isArray(receipt.logs)) {
      console.error(`burn collector: transfers transport: no receipt for ${t.hash}; skipping`)
      continue
    }
    let matched = false
    for (const log of receipt.logs) {
      const drip = decodeBurnLog(log)
      if (drip) {
        drips.push(drip)
        matched = true
      }
    }
    if (!matched) {
      console.error(`burn collector: transfers transport: tx ${t.hash} has no BuyAndBurn event; not counted`)
    }
  }
  return { drips, tsByBlock }
}

/**
 * One alchemy_getAssetTransfers page, trying each RPC URL in order. Throws
 * an error with rpcCode === -32601 when the endpoint does not support the
 * method (e.g. RPC_URL overridden to a non-Alchemy node) so the caller
 * abandons this transport instead of retrying it forever.
 */
async function postTransfersPage({ fetchImpl, rpcUrls, body }) {
  let lastError = null
  for (const url of rpcUrls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [body] }),
          signal: controller.signal,
        })
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            await new Promise((r) => setTimeout(r, 1500 * attempt))
            continue
          }
          throw new Error(`transfers HTTP ${res.status}`)
        }
        const reply = await res.json()
        if (reply?.error) {
          const err = new Error(`transfers RPC ${reply.error.code}: ${reply.error.message ?? 'unknown'}`)
          err.rpcCode = reply.error.code
          throw err
        }
        return reply.result
      } catch (error) {
        if (error?.rpcCode === -32601) throw error
        lastError = error
        const nonRetryable = error?.name === 'AbortError' || /transfers HTTP (?!429|5\d\d)/.test(error?.message ?? '')
        if (nonRetryable) break
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      } finally {
        clearTimeout(timer)
      }
    }
  }
  throw lastError ?? new Error('transfers transport: all RPC endpoints failed')
}

/**
 * Transport 2: Blockscout's indexed address-logs endpoint (official
 * explorer, free, keyless), filtered to the BuyAndBurn topic. Pages are
 * newest-first; iteration stops once items fall below fromBlock. Logs are
 * mapped into the shape decodeBurnLog expects, and tsByBlock comes from
 * the explorer's per-log timestamps.
 *
 * Throws on any failure (the explorer Cloudflare-challenges automated IPs:
 * observed HTTP 403 2026-09-24) so the caller falls through to the next
 * transport. Unparseable items are skipped, never counted.
 */
export async function fetchBurnLogsBlockscout({ fetchImpl = fetch, fromBlock, toBlock }) {
  const from = BigInt(fromBlock)
  const to = BigInt(toBlock)
  const logs = []
  const tsByBlock = new Map()
  let page = null
  for (;;) {
    const url =
      `${BLOCKSCOUT_API}/addresses/${FUEL_BURNER}/logs?topic0=${BUY_AND_BURN_TOPIC}` +
      (page ? `&block_number=${page.block_number}&index=${page.index}&items_count=${page.items_count}` : '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    let res
    try {
      res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`blockscout HTTP ${res.status}`)
    const body = await res.json()
    const items = Array.isArray(body?.items) ? body.items : []
    if (items.length === 0) break
    let minBlock = null
    for (const item of items) {
      let blockNumber
      try {
        blockNumber = BigInt(item?.block_number ?? -1)
      } catch {
        continue
      }
      if (blockNumber < 0n) continue
      if (minBlock == null || blockNumber < minBlock) minBlock = blockNumber
      if (blockNumber < from || blockNumber > to) continue
      const topics = Array.isArray(item?.topics) ? item.topics.map((t) => String(t)) : []
      const tsSeconds = item?.timestamp ? Math.floor(Date.parse(item.timestamp) / 1000) : null
      if (tsSeconds != null && Number.isFinite(tsSeconds) && tsSeconds > 0) {
        tsByBlock.set(blockNumber.toString(), tsSeconds)
      }
      logs.push({
        address: FUEL_BURNER,
        topics,
        blockNumber: toMinHex(blockNumber),
        logIndex: toMinHex(BigInt(item?.index ?? 0)),
        transactionHash: String(item?.transaction_hash ?? ''),
      })
    }
    const next = body?.next_page_params
    if (!next || minBlock == null || minBlock < from) break
    page = next
  }
  return { logs, tsByBlock }
}

/**
 * Cron run: fetch new BuyAndBurn events from the watermark to head,
 * merge into the daily series, write KV. All-or-nothing: the watermark
 * advances only after the series write succeeds.
 *
 * Write bounding: the series key is PUT only when new drips landed;
 * a quiet hour writes exactly 1 key (the meta watermark).
 */
export async function runBurnCollector(env, options = {}) {
  if (!env?.ACTIVITY || typeof env.ACTIVITY.get !== 'function' || typeof env.ACTIVITY.put !== 'function') {
    console.error('burn collector skipped: ACTIVITY KV binding unavailable')
    return { ok: false, reason: 'kv-unavailable' }
  }
  const kv = env.ACTIVITY
  const fetchImpl = options.fetchImpl ?? fetch
  const rpcUrl = options.rpcUrl ?? resolveBurnRpcUrl(env)
  const rpcUrls = options.rpcUrls ?? (options.rpcUrl ? [options.rpcUrl] : resolveRpcUrls(env))
  const rangeBlocks = options.rangeBlocks ?? resolveBurnLogRange(env)
  const chain =
    options.chain ??
    createChainReader({ fetchImpl, rpcUrl, rpcUrls, concurrency: BURN_RPC_CONCURRENCY })
  const deadline = options.deadline ?? Date.now() + BURN_RUN_DEADLINE_MS

  let meta
  try {
    meta = await readBurnMeta(kv)
  } catch {
    return { ok: false, reason: 'meta-unreadable' }
  }
  let head
  try {
    head = await chain.headBlock()
  } catch (error) {
    console.error('burn collector: head block unreadable:', error?.message ?? error)
    await recordBurnMetaError(kv, meta.lastBlock, 'head-unreadable', error)
    return { ok: false, reason: 'head-unreadable' }
  }
  const fromBlock = await (async () => {
    if (meta.lastBlock != null) return meta.lastBlock + 1n
    // No meta watermark: if the series was seeded with a watermark, honor
    // it. Seeded days carry rounded aggregates without drip IDs, so a
    // cold-start re-scan of seeded history would double-count it.
    try {
      const seeded = await kv.get(BURNS_KEY, 'json')
      if (seeded?.watermark_block != null) return BigInt(String(seeded.watermark_block)) + 1n
    } catch (error) {
      console.error('burn collector: seed watermark read failed:', error?.message ?? error)
    }
    return BURN_FIRST_BLOCK
  })()
  if (fromBlock > head) {
    console.log('burn collector: already at head; nothing to do')
    return { ok: true, fromBlock: fromBlock.toString(), toBlock: head.toString(), empty: true }
  }
  const runTo = head - fromBlock > BURN_MAX_RUN_BLOCKS ? fromBlock + BURN_MAX_RUN_BLOCKS : head

  // Transport chain: transfers (indexed) -> blockscout (indexed) -> scan
  // (batched eth_getLogs, last resort). First success wins; the watermark
  // only advances after a fully successful transport + write, so a failed
  // tick always retries from the same point. options.transports restricts
  // the chain (used by tests).
  const transportNames = Array.isArray(options.transports) && options.transports.length > 0
    ? options.transports.filter((t) => TRANSPORTS[t])
    : ['transfers', 'blockscout', 'scan']
  let transport = null
  let drips = null
  let tsByBlock = null
  const transportErrors = []
  for (const name of transportNames) {
    try {
      const out = await TRANSPORTS[name]({ fetchImpl, rpcUrls, chain, fromBlock, toBlock: runTo, rangeBlocks })
      transport = name
      drips = out.drips
      tsByBlock = out.tsByBlock
      break
    } catch (error) {
      transportErrors.push(`${name}: ${error?.message ?? error}`.slice(0, 160))
      console.error(`burn collector: ${name} transport failed:`, error?.message ?? error)
    }
  }
  if (transport == null) {
    await recordBurnMetaError(kv, meta.lastBlock, 'all-transports-failed', new Error(transportErrors.join(' | ')))
    return { ok: false, reason: 'all-transports-failed' }
  }
  if (Date.now() > deadline) {
    console.error('burn collector: deadline exceeded after transport read')
    await recordBurnMetaError(kv, meta.lastBlock, 'deadline')
    return { ok: false, reason: 'deadline' }
  }

  let stored = null
  try {
    stored = await kv.get(BURNS_KEY, 'json')
  } catch (error) {
    console.error('burn collector: series read failed:', error?.message ?? error)
    await recordBurnMetaError(kv, meta.lastBlock, 'series-unreadable', error)
    return { ok: false, reason: 'series-unreadable' }
  }

  let merged = { days: stored?.days ?? [], totals: stored?.totals ?? { fuel: 0, eth: 0, drips: 0 }, changed: false }
  if (drips.length > 0) {
    let tsByBlock
    try {
      tsByBlock = await chain.blockTimestamps(drips.map((d) => d.blockNumber))
    } catch (error) {
      console.error('burn collector: block timestamps unreadable:', error?.message ?? error)
      await recordBurnMetaError(kv, meta.lastBlock, 'timestamps-unreadable', error)
      return { ok: false, reason: 'timestamps-unreadable' }
    }
    const freshByDate = aggregateDripsDetail(drips, tsByBlock)
    merged = mergeBurnSeries(stored, freshByDate)
  }

  const nowIso = new Date().toISOString()
  try {
    if (merged.changed) {
      await kv.put(
        BURNS_KEY,
        JSON.stringify({
          version: 1,
          days: merged.days,
          totals: merged.totals,
          watermark_block: runTo.toString(),
          updated_at: nowIso,
        }),
      )
    }
    await kv.put(
      BURN_META_KEY,
      JSON.stringify({
        last_block: runTo.toString(),
        last_run_ts: Math.floor(Date.now() / 1000),
        status: 'ok',
      }),
    )
  } catch (error) {
    console.error('burn collector: KV write failed:', error?.message ?? error)
    return { ok: false, reason: 'storage-failed' }
  }
  console.log(
    `burn collector: ok through block ${runTo} ` +
      `(${drips.length} drips scanned; series ${merged.changed ? 'updated' : 'unchanged'})`,
  )
  return {
    ok: true,
    fromBlock: fromBlock.toString(),
    toBlock: runTo.toString(),
    dripsScanned: drips.length,
    transport,
    keysWritten: merged.changed ? 2 : 1,
    totals: merged.totals,
  }
}

// Re-exported for tests and the seed script.
export { toMinHex }
export const _WEI_PER_TOKEN = WEI_PER_TOKEN
