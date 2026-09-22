// One-shot full-history backfill for FUEL minter analytics.
//
// Aggregates the same attribution logic as the hourly worker
// (server/minter-collect.mjs) over the full token history, writes a review
// JSON snapshot locally, and optionally bulk-loads the KV rows so the hourly
// collector can continue incrementally from the watermark.
//
// Usage:
//   node scripts/backfill-minters.mjs [--from BLOCK] [--to BLOCK]
//     [--chunk BLOCKS] [--checkpoint PATH] [--out PATH]
//     [--verify 0xaddr,0xaddr] [--write-kv] [--rpc URL]
//
// Env for --write-kv: CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID
//
// Read-only chain access; no transactions are ever sent.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import {
  createChainReader,
  collectRange,
  serializeState,
  discoverTransferTopics,
  rowToStored,
  contractToStored,
  dayToStored,
  FUEL_FIRST_BLOCK,
  META_KEY,
  toMinHex,
} from '../server/minter-collect.mjs'

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
const DEFAULT_CHUNK = 200000n
const WINDOW_DEADLINE_MS = 20 * 60 * 1000

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const hasFlag = (name) => process.argv.includes(name)

function fuelStr(weiStr) {
  return (Number(BigInt(weiStr)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 1 })
}

async function kvBulkWrite(entries) {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID } = process.env
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID) {
    throw new Error('--write-kv requires CF_API_TOKEN, CF_ACCOUNT_ID and CF_KV_NAMESPACE_ID env vars')
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/bulk`
  for (let i = 0; i < entries.length; i += 5000) {
    const batch = entries.slice(i, i + 5000).map(([key, value]) => ({ key, value: JSON.stringify(value) }))
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.success === false) {
      throw new Error(`KV bulk write failed at offset ${i}: ${JSON.stringify(body).slice(0, 300)}`)
    }
    console.log(`  wrote ${Math.min(i + 5000, entries.length)}/${entries.length} keys`)
  }
}

async function main() {
  const rpcUrl = arg('--rpc', RPC_URL)
  const checkpointPath = arg('--checkpoint', '.radar-data/minter-backfill-checkpoint.json')
  const outPath = arg('--out', '.radar-data/minter-backfill.json')
  mkdirSync('.radar-data', { recursive: true })

  let checkpoint = null
  if (existsSync(checkpointPath)) {
    try {
      checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
    } catch { /* start fresh */ }
  }

  // Gentle concurrency: the public node rate-limits bursty batch traffic.
  const chain = createChainReader({ fetchImpl: fetch, rpcUrl, concurrency: 3 })
  const head = await chain.headBlock()
  console.log(`head block: ${head} (${toMinHex(head)})`)

  let fromBlock = arg('--from') ? BigInt(arg('--from')) : FUEL_FIRST_BLOCK
  if (checkpoint?.last_block != null) {
    const resumeFrom = BigInt(checkpoint.last_block) + 1n
    if (resumeFrom > fromBlock) {
      fromBlock = resumeFrom
      console.log(`resuming from checkpoint at block ${checkpoint.last_block}`)
    }
  }
  const toBlock = arg('--to') ? BigInt(arg('--to')) : head
  const chunk = arg('--chunk') ? BigInt(arg('--chunk')) : DEFAULT_CHUNK
  if (fromBlock > toBlock) {
    console.log('nothing to do: from > to')
    return
  }
  console.log(`backfill range: ${fromBlock} -> ${toBlock} (chunk ${chunk})`)

  console.log('discovering live transfer topics...')
  const transferTopics = await discoverTransferTopics(chain, head > 20000n ? head - 20000n : 0n, head)
  console.log(`  ${transferTopics.length} topics`)

  // Thread STORED-shape rows through the windows (aggregateRange requires
  // stored shapes in `prior`; working rows use different field names).
  let priorStored = checkpoint?.prior
    ? {
        minters: checkpoint.prior.minters ?? [],
        contracts: checkpoint.prior.contracts ?? [],
        days: checkpoint.prior.days ?? [],
      }
    : null
  let state = null
  let doneTo = fromBlock - 1n
  for (let start = fromBlock; start <= toBlock; ) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock
    const t0 = Date.now()
    const prior = priorStored
      ? {
          minters: new Map(priorStored.minters),
          contracts: new Map(priorStored.contracts),
          days: new Map(priorStored.days),
        }
      : null
    state = await collectRange(chain, start, end, prior, {
      transferTopics,
      deadline: Date.now() + WINDOW_DEADLINE_MS,
    })
    doneTo = end
    // Stored (JSON-safe) row shapes, used for the checkpoint AND the next
    // window's prior so a resume is just aggregateRange.
    priorStored = {
      minters: [...state.minters].map(([a, r]) => [a, rowToStored(a, r, doneTo)]),
      contracts: [...state.contracts].map(([a, c]) => [a, contractToStored(c)]),
      days: [...state.days].map(([d, rec]) => [d, dayToStored(rec)]),
    }
    const { swaps, transfers, minterEvents } = state.stats
    console.log(
      `  [${start}-${end}] ${transfers} transfers, ${swaps} swaps, ${minterEvents} minter events ` +
        `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    )
    writeFileSync(checkpointPath, JSON.stringify({ last_block: doneTo.toString(), prior: priorStored }))
    start = end + 1n
  }

  const { minterEntries, contractEntries, dayEntries } = serializeState(state.minters, state.contracts, state.days, doneTo)
  console.log(`\nrows: ${minterEntries.length} minters, ${contractEntries.length} mint contracts, ${dayEntries.length} days`)

  const sorted = [...minterEntries].sort((a, b) => (BigInt(b[1].claimed) > BigInt(a[1].claimed) ? 1 : -1))
  console.log('\ntop 10 minters by claimed FUEL:')
  for (const [, r] of sorted.slice(0, 10)) {
    console.log(
      `  ${r.wallet} claimed=${fuelStr(r.claimed)} sold=${fuelStr(r.sold)} ` +
        `pct=${r.pct_sold?.toFixed(1)}% bought=${fuelStr(r.bought)} remints=${r.remint_count}`,
    )
  }

  const verify = (arg('--verify', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (verify.length) {
    console.log('\nverification wallets:')
    for (const addr of verify) {
      const found = minterEntries.find(([k]) => k === `minter:${addr}`)
      if (!found) {
        console.log(`  ${addr}: NO MINTER ROW (never claimed)`)
        continue
      }
      const r = found[1]
      console.log(
        `  ${r.wallet}: claimed=${fuelStr(r.claimed)} sold=${fuelStr(r.sold)} pct=${r.pct_sold?.toFixed(2)}% ` +
          `bought=${fuelStr(r.bought)} mints_opened=${r.mints_opened} remint_count=${r.remint_count} ` +
          `remint_eth_wei=${r.remint_eth_wei} first_claim=${r.first_claim_ts ? new Date(r.first_claim_ts * 1000).toISOString() : null} ` +
          `first_sale=${r.first_sale_ts ? new Date(r.first_sale_ts * 1000).toISOString() : null}`,
      )
    }
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    from_block: fromBlock.toString(),
    to_block: doneTo.toString(),
    minter_rows: minterEntries.length,
    mint_contract_rows: contractEntries.length,
    day_rows: dayEntries.length,
    minters: sorted.map(([, r]) => r),
    days: dayEntries.map(([, d]) => d),
  }
  writeFileSync(outPath, JSON.stringify(snapshot))
  console.log(`\nsnapshot written to ${outPath}`)

  if (hasFlag('--write-kv')) {
    console.log('\nbulk-loading KV...')
    await kvBulkWrite([...minterEntries, ...contractEntries, ...dayEntries])
    await kvBulkWrite([
      [
        META_KEY,
        {
          last_block: doneTo.toString(),
          last_run_ts: Math.floor(Date.now() / 1000),
          status: 'ok',
          backfill_done: true,
        },
      ],
    ])
    console.log('KV load complete; watermark advanced with backfill_done=true')
  } else {
    console.log('\ndry run: KV not written (pass --write-kv with CF_* env vars to load)')
  }
}

main().catch((error) => {
  console.error('backfill failed:', error?.message ?? error)
  process.exit(1)
})
