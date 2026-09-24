// One-time sandbox backfill of FUEL buy-and-burn history.
//
// Why: the worker cron cannot catch the burns watermark up on its own — the
// RPC provider caps eth_getLogs at a 10-block range on the free tier while the
// worker free tier allows only 50 subrequests per invocation, so a ~1.7M-block
// backlog is unreachable from inside the worker (observed 2026-09-24). The
// public Robinhood RPC accepts large ranges from the sandbox, so this script
// scans the whole backlog here and writes the merged daily series + advanced
// watermark through the Cloudflare KV REST API. All-or-nothing: the watermark
// (meta:burn-collector) advances only after the series write (burns:daily)
// succeeds, so a failed run leaves the worker retrying from the same block.
//
// Usage:
//   python3 ~/workspace/skills/cloudflare/bin/cf-env-run.py ~/workspace/fuelmore-radar \
//     -- node scripts/burn-backfill.mjs [--dry-run]
//
// Reuses the worker's own decode/merge logic (server/burn-collect.mjs) so the
// series written here is byte-compatible with what the tick collector writes.

import { createChainReader } from '../server/minter-collect.mjs'
import {
  FUEL_BURNER,
  BUY_AND_BURN_TOPIC,
  BURNS_KEY,
  BURN_META_KEY,
  decodeBurnLog,
  aggregateDripsDetail,
  mergeBurnSeries,
} from '../server/burn-collect.mjs'
import { PUBLIC_RPC } from '../server/rpc-config.mjs'

const PROD_NAMESPACE_ID = '4ee21ae0827e47a585602c260af73230' // ACTIVITY binding, production
const RANGE_BLOCKS = 50000n // per eth_getLogs call (directive: 50k-block ranges)
const BATCH_CALLS = 10 // calls per JSON-RPC batch
const PACING_MS = 400 // between batches; public-RPC kindness

const dryRun = process.argv.includes('--dry-run')

const token = process.env.CLOUDFLARE_API_TOKEN
if (!token) {
  console.error('missing CLOUDFLARE_API_TOKEN (run via cf-env-run.py)')
  process.exit(2)
}

const accts = await (
  await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: { Authorization: `Bearer ${token}` },
  })
).json()
const accountId = accts.result?.[0]?.id
if (!accountId) {
  console.error('could not list Cloudflare accounts')
  process.exit(2)
}
const kvBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${PROD_NAMESPACE_ID}/values`

async function kvGet(key) {
  const res = await fetch(`${kvBase}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`KV GET ${key}: HTTP ${res.status}`)
  return res.json()
}

async function kvPut(key, value) {
  const res = await fetch(`${kvBase}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    throw new Error(`KV PUT ${key}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
}

async function withRetries(label, fn, attempts = 3) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      last = error
      console.error(`  ${label}: attempt ${i}/${attempts} failed: ${error.message}`)
      if (i < attempts) await new Promise((r) => setTimeout(r, 5000 * i))
    }
  }
  throw last
}

const meta = await withRetries('read meta', () => kvGet(BURN_META_KEY))
const lastBlock = meta?.last_block != null ? BigInt(meta.last_block) : null
if (lastBlock == null) {
  console.error('refusing: meta:burn-collector has no last_block watermark (cold start is a different procedure)')
  process.exit(2)
}
const stored = await withRetries('read series', () => kvGet(BURNS_KEY))
console.log(`watermark: ${lastBlock} (status: ${meta.status}); stored series: ${stored?.days?.length ?? 0} days`)

const chain = createChainReader({ rpcUrl: PUBLIC_RPC, concurrency: 4 })
const head = await withRetries('chain head', () => chain.headBlock())
const fromBlock = lastBlock + 1n
console.log(`chain head: ${head}; scanning [${fromBlock}, ${head}] = ${head - fromBlock + 1n} blocks`)
if (fromBlock > head) {
  console.log('already at head; nothing to do')
  process.exit(0)
}

const logs = await withRetries('log scan', () =>
  chain.logsBatched({
    address: FUEL_BURNER,
    topics: [BUY_AND_BURN_TOPIC],
    fromBlock,
    toBlock: head,
    rangeBlocks: RANGE_BLOCKS,
    batchCalls: BATCH_CALLS,
    pacingMs: PACING_MS,
  }),
)
console.log(`scan complete: ${logs.length} raw logs`)

const drips = []
for (const log of logs) {
  const drip = decodeBurnLog(log)
  if (drip) drips.push(drip)
}
console.log(`decoded: ${drips.length} BuyAndBurn drips`)

let freshByDate = new Map()
if (drips.length > 0) {
  const tsByBlock = await withRetries('block timestamps', () =>
    chain.blockTimestamps(drips.map((d) => d.blockNumber)),
  )
  freshByDate = aggregateDripsDetail(drips, tsByBlock)
}
console.log(`fresh dates: ${[...freshByDate.keys()].join(', ') || '(none)'}`)

const merged = mergeBurnSeries(stored, freshByDate)
console.log(
  `merged: ${merged.days.length} days, totals fuel=${merged.totals.fuel.toFixed(2)} eth=${merged.totals.eth.toFixed(6)} drips=${merged.totals.drips} (changed=${merged.changed})`,
)
for (const [date, day] of freshByDate) {
  const m = merged.days.find((d) => d.date === date)
  console.log(`  ${date}: +${day.dripWei.length} drips -> day total fuel=${m.fuel.toFixed(2)} drips=${m.drips}`)
}

if (dryRun) {
  console.log('dry run: skipping KV writes')
  process.exit(0)
}

// Series first, watermark second — the tick collector only ever starts from a
// fully written series.
await withRetries('write series', () =>
  kvPut(BURNS_KEY, {
    version: 1,
    days: merged.days,
    totals: merged.totals,
    watermark_block: head.toString(),
    updated_at: new Date().toISOString(),
  }),
)
await withRetries('write watermark', () =>
  kvPut(BURN_META_KEY, {
    last_block: head.toString(),
    last_run_ts: Math.floor(Date.now() / 1000),
    status: 'ok',
  }),
)
console.log(`BURNS BACKFILL COMPLETE: watermark advanced ${lastBlock} -> ${head} (+${head - lastBlock} blocks), 2 KV keys written`)
