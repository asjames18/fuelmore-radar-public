// One-shot: write corrected daily-flow rows + collector meta to the PREVIEW KV.
//
// Context (2026-09-22): the minter USD calibration bug mispriced pre-crash
// windows by ~300x. The full history was recomputed from scratch into
// .radar-data/minter-backfill.json, but the KV bulk write hit Cloudflare's
// free-tier daily write limit (code 10048), so the corrected rows were never
// stored. Run this after the quota resets (daily, ~00:00 UTC) to finish the job.
//
// It writes only the price-dependent keys: 5 day rows + the collector meta.
// Minter/contract rows carry no USD values and are unaffected by the bug.
//
// Usage:
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... \
//     CF_KV_NAMESPACE_ID=53815607371b4118acc0cf6579b921d5 \
//     node scripts/write-preview-days.mjs
//
// NEVER point CF_KV_NAMESPACE_ID at the production namespace.
import { readFileSync } from 'node:fs'

const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID } = process.env
if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID) {
  throw new Error('need CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID')
}
if (!CF_KV_NAMESPACE_ID.includes('preview') && CF_KV_NAMESPACE_ID !== '53815607371b4118acc0cf6579b921d5') {
  throw new Error('refusing: target does not look like the preview KV namespace')
}

const snap = JSON.parse(readFileSync('.radar-data/minter-backfill.json', 'utf8'))
const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}`

async function putKey(key, value) {
  const res = await fetch(`${base}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    throw new Error(`PUT ${key} failed: ${JSON.stringify(body).slice(0, 200)}`)
  }
  console.log(`  wrote ${key}`)
}

for (const day of snap.days) {
  await putKey(`flows:daily:${day.date}`, day)
}
await putKey('meta:minter-collector', {
  last_block: snap.to_block,
  last_run_ts: Math.floor(Date.now() / 1000),
  status: 'ok',
  backfill_done: true,
})
console.log('done')
