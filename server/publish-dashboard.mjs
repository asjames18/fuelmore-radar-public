import { createServer } from 'vite'
import { d1Get, d1Put } from './d1-publish.mjs'

// Same adapters as the UI, executed once by the scheduled publisher.
// Vite loads TypeScript without committing a generated server bundle.
const runtime = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { fetchRadarData } = await runtime.ssrLoadModule('/src/lib/api.ts')
  const { DASHBOARD_KEY, decodeDashboard, encodeDashboard, mergeDashboard } = await runtime.ssrLoadModule('/src/lib/dashboardSnapshot.ts')
  let previous = null
  try {
    const raw = await d1Get(process.env, DASHBOARD_KEY)
    if (raw) previous = decodeDashboard(raw)
  } catch (err) {
    throw new Error(`Snapshot storage unavailable: ${err.message}`)
  }
  if (previous === undefined) throw new Error('Existing snapshot is invalid; publication withheld')
  if (!process.env.RPC_URL) throw new Error('RPC configuration missing')
  const incoming = await fetchRadarData(process.env.RPC_URL, { blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY })
  const next = mergeDashboard(previous, incoming)
  const body = encodeDashboard(next)
  if (!decodeDashboard(body)) throw new Error('Snapshot validation failed')
  try {
    await d1Put(process.env, DASHBOARD_KEY, body)
  } catch (err) {
    throw new Error(`Publication not confirmed: ${err.message}`)
  }
  console.log(JSON.stringify({ ok:true, updatedAt:next.updatedAt, sources:next.sources.map(s=>({name:s.name,status:s.status,retained:!!s.retained,observedAt:s.checkedAt})) }))
} catch (err) {
  console.error(`Dashboard publication failed: ${err?.message ?? err}`)
  process.exitCode = 1
} finally { await runtime.close() }
