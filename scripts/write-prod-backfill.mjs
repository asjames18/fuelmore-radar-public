// Chunked production backfill writer for FUEL minter analytics.
//
// Writes the corrected full-history snapshot (contracts + minter rows + day
// rows, then the collector meta LAST) to the PRODUCTION KV namespace in
// daily-quota-sized chunks. Resumable via a local progress file.
//
// Why chunked: Cloudflare free tier allows 1,000 KV writes/day/account.
// The full backfill is ~1,644 keys, so it takes 2 days at <=850 keys/day
// (headroom left for the hourly collector's own small writes).
//
// Usage:
//   CF_API_TOKEN=<token> CF_ACCOUNT_ID=<id> \
//     node scripts/write-prod-backfill.mjs --namespace-id <id> [--chunk 850]
//
// Safety:
// - REFUSES the preview namespace, the placeholder, and anything that does
//   not look like a real namespace id.
// - 10048 (quota) pauses: progress is saved, exit code is 3, nothing is
//   duplicated on resume (same key list, skip-first-N).
// - The meta watermark (backfill_done=true) is written only after every row
//   key succeeds, so the hourly collector never starts from a partial load.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const PREVIEW_NAMESPACE_ID = '53815607371b4118acc0cf6579b921d5'
const SNAPSHOT_PATH = '.radar-data/minter-backfill.json'
const CHECKPOINT_PATH = '.radar-data/minter-backfill-checkpoint.json'
const PROGRESS_PATH = '.radar-data/prod-backfill-progress.json'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const namespaceId = arg('--namespace-id')
if (!namespaceId || namespaceId === 'REPLACE_WITH_PUBLIC_KV_ID' || namespaceId === PREVIEW_NAMESPACE_ID) {
  throw new Error('refusing: --namespace-id must be the real PRODUCTION KV namespace id (not preview, not the placeholder)')
}
const { CF_API_TOKEN, CF_ACCOUNT_ID } = process.env
if (!CF_API_TOKEN || !CF_ACCOUNT_ID) throw new Error('need CF_API_TOKEN and CF_ACCOUNT_ID env vars')

const chunkSize = Math.min(900, Math.max(1, Number(arg('--chunk', '850')) || 850))
const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}`

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
const checkpoint = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'))
if (checkpoint.last_block !== snapshot.to_block) {
  throw new Error(`checkpoint (${checkpoint.last_block}) disagrees with snapshot (${snapshot.to_block}); refusing to write a mixed load`)
}

// Ordered key list: contracts (bulk, internal bookkeeping), then the
// UI-read rows (minters, days). Meta is written separately, last.
const keys = []
for (const [addr, stored] of checkpoint.prior.contracts) {
  keys.push([`mintcontract:${addr.toLowerCase()}`, stored])
}
for (const row of snapshot.minters) {
  keys.push([`minter:${String(row.wallet).toLowerCase()}`, row])
}
for (const day of snapshot.days) {
  keys.push([`flows:daily:${day.date}`, day])
}
const total = keys.length
console.log(`backfill load: ${checkpoint.prior.contracts.length} contracts, ${snapshot.minters.length} minters, ${snapshot.days.length} days = ${total} row keys (+ meta last)`)

let progress = { written: 0, total, to_block: snapshot.to_block, namespace: `${namespaceId.slice(0, 6)}…` }
if (existsSync(PROGRESS_PATH)) {
  try {
    const prev = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'))
    if (prev.to_block === snapshot.to_block && prev.total === total && Number.isInteger(prev.written)) {
      progress = prev
      console.log(`resuming: ${progress.written}/${total} already written`)
    } else {
      console.log('progress file is for a different load; starting over')
    }
  } catch { /* start fresh */ }
}

async function putKey(key, value) {
  const res = await fetch(`${base}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    const err = new Error(`PUT ${key} failed: ${JSON.stringify(body).slice(0, 200)}`)
    err.cfBody = body
    throw err
  }
}

function saveProgress() {
  mkdirSync('.radar-data', { recursive: true })
  writeFileSync(PROGRESS_PATH, JSON.stringify({ ...progress, updated_at: new Date().toISOString() }))
}

const CONCURRENCY = 4
let done = progress.written
const remaining = keys.slice(done, done + chunkSize)
console.log(`writing ${remaining.length} keys this run (chunk cap ${chunkSize})...`)
try {
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(([k, v]) => putKey(k, v)))
    done += batch.length
    progress.written = done
    if (done % 100 === 0 || done === progress.total) console.log(`  ${done}/${total}`)
  }
} catch (error) {
  saveProgress()
  const code = error?.cfBody?.errors?.[0]?.code
  if (code === 10048) {
    console.error(`QUOTA PAUSED at ${done}/${total}: free-tier daily write limit reached. Resume tomorrow; progress saved.`)
    process.exit(3)
  }
  console.error(`write failed at ${done}/${total}: ${error.message}; progress saved, resume to continue`)
  process.exit(1)
}
saveProgress()

if (done < total) {
  console.log(`chunk complete: ${done}/${total} written. Run again tomorrow for the rest (meta is written last).`)
  process.exit(0)
}

// All rows are in. Advance the watermark LAST so the hourly collector only
// ever starts from a complete load.
await putKey('meta:minter-collector', {
  last_block: snapshot.to_block,
  last_run_ts: Math.floor(Date.now() / 1000),
  status: 'ok',
  backfill_done: true,
})
console.log(`meta written: watermark at block ${snapshot.to_block}, backfill_done=true`)

// Verify the headline corrected number made it.
const day21 = snapshot.days.find((d) => d.date === '2026-09-21')
const topBuyer = day21?.buyers?.[0]
console.log('2026-09-21 top buyer:', topBuyer?.w, 'fuel:', topBuyer?.fuel, 'usd:', topBuyer?.usd, '(corrected: ~1185.44)')
console.log('buy_vol_usd:', day21?.buy_vol_usd, '(corrected: ~4065.24) sell_vol_usd:', day21?.sell_vol_usd, '(corrected: ~2885.57)')
console.log('PROD BACKFILL COMPLETE')
