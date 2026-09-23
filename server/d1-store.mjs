// D1-backed snapshot storage for the Worker runtime.
// Reads prefer D1 (100K free writes/day); falls back to the legacy KV
// binding during the migration window so no data is lost in transit.

/** Read a snapshot string by key. Returns null when missing. */
export async function storeGet(env, key) {
  // Prefer D1 when bound.
  try {
    if (env.DB && typeof env.DB.prepare === 'function') {
      const row = await env.DB.prepare('SELECT value FROM snapshots WHERE key = ?').bind(key).first()
      if (row?.value != null) return row.value
    }
  } catch { /* fall through to KV */ }
  // Legacy KV fallback.
  try {
    if (env.ACTIVITY && typeof env.ACTIVITY.get === 'function') {
      return await env.ACTIVITY.get(key)
    }
  } catch { /* ignore */ }
  return null
}

/** Read a snapshot as JSON by key. Returns null when missing or corrupt. */
export async function storeGetJson(env, key) {
  const raw = await storeGet(env, key)
  if (raw == null) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

/** Write a snapshot string by key to D1 (primary) and KV (legacy mirror). */
export async function storePut(env, key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let d1ok = false
  try {
    if (env.DB && typeof env.DB.prepare === 'function') {
      await env.DB.prepare(
        `INSERT INTO snapshots(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(key, text, Date.now()).run()
      d1ok = true
    }
  } catch (err) {
    console.error(`D1 put failed for ${key}:`, err?.message ?? err)
  }
  // Mirror to KV while the migration is in flight; never let a mirror
  // failure break the primary write.
  try {
    if (env.ACTIVITY && typeof env.ACTIVITY.put === 'function') {
      await env.ACTIVITY.put(key, text)
    }
  } catch { /* mirror is best-effort */ }
  if (!d1ok) throw new Error(`D1 unavailable for ${key}`)
  return { ok: true, key }
}
