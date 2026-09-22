import { createServer } from 'vite'
import { storageConfig } from './publish-storage.mjs'

// Same adapters as the UI, executed once by the scheduled publisher.
// Vite loads TypeScript without committing a generated server bundle.
const runtime = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { fetchRadarData } = await runtime.ssrLoadModule('/src/lib/api.ts')
  const { DASHBOARD_KEY, decodeDashboard, encodeDashboard, mergeDashboard } = await runtime.ssrLoadModule('/src/lib/dashboardSnapshot.ts')
  const { url: activityUrl, token } = storageConfig(process.env)
  const url = activityUrl.replace(/[^/]+$/, DASHBOARD_KEY)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok && response.status !== 404) throw new Error('Snapshot storage unavailable')
  const previous = response.ok ? decodeDashboard(await response.text()) : null
  if (response.ok && !previous) throw new Error('Existing snapshot is invalid; publication withheld')
  if (!process.env.RPC_URL) throw new Error('RPC configuration missing')
  const incoming = await fetchRadarData(process.env.RPC_URL, { blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY })
  const next = mergeDashboard(previous, incoming)
  const body = encodeDashboard(next)
  if (!decodeDashboard(body)) throw new Error('Snapshot validation failed')
  const result = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(15000) })
  if (!result.ok || (await result.json()).success !== true) throw new Error('Publication not confirmed')
  console.log(JSON.stringify({ ok:true, updatedAt:next.updatedAt, sources:next.sources.map(s=>({name:s.name,status:s.status,retained:!!s.retained,observedAt:s.checkedAt})) }))
} catch {
  console.error('Dashboard publication failed; existing snapshot retained. Check provider and storage configuration.')
  process.exitCode = 1
} finally { await runtime.close() }
