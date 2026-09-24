// FUEL buy-and-burn history collector for the FUEL/MORE Radar (FUEL only).
//
// Hourly worker cron: reads BuyAndBurn events from the FUEL Buy & Burn
// contract and maintains:
//   burns:daily            daily series [{date, fuel, eth, drips}]
//   meta:burn-collector    watermark {last_block, last_run_ts, status}
//
// Conventions follow server/minter-collect.mjs: all-or-nothing per run,
// injectable chain reader for tests, null-never-zero, read-only RPC,
// write-bounded (quiet hours write ~1 key: the meta watermark; the daily
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

import { createChainReader, toMinHex, hexToBigInt } from './minter-collect.mjs'
import { resolveRpcUrl } from './rpc-config.mjs'

export const FUEL_BURNER = '0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2'
// keccak256("BuyAndBurn(uint256,uint256,address)")
export const BUY_AND_BURN_TOPIC =
  '0x1b3ed074dce570943c9d4e66776a060e8ac73af4f6b002482b09e561d90f038c'

export const BURNS_KEY = 'burns:daily'
export const BURN_META_KEY = 'meta:burn-collector'

export const BURN_FIRST_BLOCK = 63115000n
// Per-run block budget: 16,000 blocks = 16 batches x 100 calls x 10 blocks.
// Subrequest math (worker free tier: 50 external subrequests PER INVOCATION,
// shared by the market snapshot and watchdog running in the same tick):
// 16 log batches + head ~= 17, leaving headroom for the market snapshot's
// own fetches in the same tick. 16k blocks/tick outpaces the chain's ~14k
// blocks per 15-minute tick, so the watermark converges over successive
// runs instead of falling behind.
export const BURN_MAX_RUN_BLOCKS = 16000n
// eth_getLogs range size per call. The RPC provider's free tier caps
// eth_getLogs at a 10-block range (observed 2026-09-24: "Under the Free tier
// plan, you can make eth_getLogs requests with up to a 10 block range").
// Calls are packed BURN_LOG_BATCH_CALLS-per-batch so one subrequest covers
// 1000 blocks. Batch pacing (observed 2026-09-24): firing the batches in a
// burst 429-rate-limits the provider; the retry backoff then blows the
// worker's run deadline, so batches are paced at BURN_BATCH_PACING_MS with
// BURN_RPC_CONCURRENCY lanes — the scan stays well inside the deadline.
// Pacing rationale (observed 2026-09-24): the provider rate-limits COMPUTE
// UNITS PER SECOND ("exceeded its compute units per second capacity"), so
// concurrent lanes are out — one lane firing a 100-call batch every 2.5s
// (~40 calls/s, no bursts) stays under the limiter. 16 batches take ~40s +
// latency, comfortably inside BURN_RUN_DEADLINE_MS.
// Subrequest math (worker free tier: 50 external subrequests PER INVOCATION,
// shared by every ctx.waitUntil in the tick — observed 2026-09-24: the
// market snapshot's own fetches failed with "Too many subrequests" when the
// burn scan ran 40 batches beside it): 16 log batches + head ~= 17, leaving
// real headroom for the market snapshot's fetches and the watchdog.
export const BURN_LOG_CHUNK_BLOCKS = 10n
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
  // exact wei accounting lives on-chain. Conversion keeps 6 decimals.
  return Number(wei) / 1e18
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
 * Hourly run: fetch new BuyAndBurn events from the watermark to head,
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
  const rpcUrl = options.rpcUrl ?? resolveRpcUrl(env)
  const chain = options.chain ?? createChainReader({ fetchImpl, rpcUrl, concurrency: BURN_RPC_CONCURRENCY })
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

  // Log scan, packed for both caps: the provider's 10-block eth_getLogs
  // limit (BURN_LOG_CHUNK_BLOCKS) and the worker's 50-subrequest free-tier
  // budget PER INVOCATION (one subrequest per BURN_LOG_BATCH_CALLS calls via
  // logsBatched — shared with the market snapshot's fetches in the same
  // tick, so the scan must stay small enough for both to fit).
  // A single call over the whole run range is rejected by the provider;
  // one call per chunk trips the worker's subrequest limit instead.
  // Batches are paced (BURN_BATCH_PACING_MS): bursty batches 429 the
  // provider and the retry backoff would blow the run deadline.
  let logs
  try {
    logs = await chain.logsBatched({
      address: FUEL_BURNER,
      topics: [BUY_AND_BURN_TOPIC],
      fromBlock,
      toBlock: runTo,
      rangeBlocks: BURN_LOG_CHUNK_BLOCKS,
      batchCalls: BURN_LOG_BATCH_CALLS,
      pacingMs: BURN_BATCH_PACING_MS,
    })
  } catch (error) {
    console.error('burn collector: log scan failed:', error?.message ?? error)
    await recordBurnMetaError(kv, meta.lastBlock, 'scan-failed', error)
    return { ok: false, reason: 'scan-failed' }
  }
  if (Date.now() > deadline) {
    console.error('burn collector: deadline exceeded after log scan')
    await recordBurnMetaError(kv, meta.lastBlock, 'deadline')
    return { ok: false, reason: 'deadline' }
  }

  const drips = []
  for (const log of logs) {
    const drip = decodeBurnLog(log)
    if (drip) drips.push(drip)
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
    keysWritten: merged.changed ? 2 : 1,
    totals: merged.totals,
  }
}

// Re-exported for tests and the seed script.
export { toMinHex }
export const _WEI_PER_TOKEN = WEI_PER_TOKEN
