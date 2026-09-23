#!/usr/bin/env node
// D1-backed snapshot storage for the scheduled publishers.
// Uses the Cloudflare D1 Query API (100K free writes/day vs 1K for KV).
// Table schema (created once per database):
//   CREATE TABLE IF NOT EXISTS snapshots (
//     key TEXT PRIMARY KEY,
//     value TEXT NOT NULL,
//     updated_at INTEGER NOT NULL
//   );

export function d1Config(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID
  const token = env.CLOUDFLARE_API_TOKEN
  if (!/^[a-f0-9]{32}$/i.test(account ?? '')) throw new Error('Invalid Cloudflare account ID')
  if (!/^[a-f0-9-]{36}$/i.test(databaseId ?? '')) throw new Error('Invalid D1 database ID')
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid API token')
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,
    token,
  }
}

async function d1Query(url, token, sql, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`D1 query failed: HTTP ${response.status}`)
  const data = await response.json()
  if (!data.success) throw new Error(`D1 query not confirmed: ${(data.errors || []).map(e => e.message).join('; ')}`)
  return data.result?.[0]
}

/** Read a snapshot value by key. Returns null when missing. */
export async function d1Get(env, key) {
  const { url, token } = d1Config(env)
  const result = await d1Query(url, token, 'SELECT value FROM snapshots WHERE key = ?', [key])
  return result?.results?.[0]?.value ?? null
}

/** Write a snapshot value by key (upsert). */
export async function d1Put(env, key, value) {
  const { url, token } = d1Config(env)
  await d1Query(
    url,
    token,
    `INSERT INTO snapshots(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  )
  return { ok: true, key }
}
