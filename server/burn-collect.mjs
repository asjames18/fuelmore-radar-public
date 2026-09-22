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
export const BURN_MAX_RUN_BLOCKS = 100000n
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
    byDate.set(d.date, {
      date: d.date,
      fuelWei: BigInt(Math.round(Number(d.fuel) * 1e18)),
      ethWei: BigInt(Math.round(Number(d.eth) * 1e18)),
      dripIds: new Set(Array.isArray(d.dripIds) ? d.dripIds : []),
    })
  }
  let changed = false
  for (const [date, fresh] of freshByDate) {
    let day = byDate.get(date)
    if (!day) {
      day = { date, fuelWei: 0n, ethWei: 0n, dripIds: new Set() }
      byDate.set(date, day)
    }
    for (const drip of fresh.dripWei) {
      if (day.dripIds.has(drip.dripId)) continue
      day.dripIds.add(drip.dripId)
      day.fuelWei += drip.fuelWei
      day.ethWei += drip.ethWei
      changed = true
    }
  }
  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      date: d.date,
      fuel: weiToTokensFloat(d.fuelWei),
      eth: weiToTokensFloat(d.ethWei),
      drips: d.dripIds.size,
      dripIds: [...d.dripIds].sort(),
    }))
  let totalFuelWei = 0n
  let totalEthWei = 0n
  let totalDrips = 0
  for (const d of byDate.values()) {
    totalFuelWei += d.fuelWei
    totalEthWei += d.ethWei
    totalDrips += d.dripIds.size
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
  const chain = options.chain ?? createChainReader({ fetchImpl, rpcUrl })
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
    return { ok: false, reason: 'head-unreadable' }
  }
  const fromBlock = meta.lastBlock == null ? BURN_FIRST_BLOCK : meta.lastBlock + 1n
  if (fromBlock > head) {
    console.log('burn collector: already at head; nothing to do')
    return { ok: true, fromBlock: fromBlock.toString(), toBlock: head.toString(), empty: true }
  }
  const runTo = head - fromBlock > BURN_MAX_RUN_BLOCKS ? fromBlock + BURN_MAX_RUN_BLOCKS : head

  let logs
  try {
    logs = await chain.logs({
      address: FUEL_BURNER,
      topics: [BUY_AND_BURN_TOPIC],
      fromBlock,
      toBlock: runTo,
    })
  } catch (error) {
    console.error('burn collector: log scan failed:', error?.message ?? error)
    return { ok: false, reason: 'scan-failed' }
  }
  if (Date.now() > deadline) {
    console.error('burn collector: deadline exceeded after log scan')
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
    return { ok: false, reason: 'series-unreadable' }
  }

  let merged = { days: stored?.days ?? [], totals: stored?.totals ?? { fuel: 0, eth: 0, drips: 0 }, changed: false }
  if (drips.length > 0) {
    let tsByBlock
    try {
      tsByBlock = await chain.blockTimestamps(drips.map((d) => d.blockNumber))
    } catch (error) {
      console.error('burn collector: block timestamps unreadable:', error?.message ?? error)
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
