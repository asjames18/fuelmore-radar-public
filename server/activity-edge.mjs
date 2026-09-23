/** Serve complete sender-counted publisher snapshots, never approximate edge counts.
 * The Node publisher owns collection, reorg recovery and maturity validation.
 * KV is an optional copy of a published report, not an independently advanced index.
 */
import { MATURITY_DAY_COUNT } from './maturity.mjs'
import { storeGetJson } from './d1-store.mjs'
export const TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
export const REPORT_KEY = 'fuel-activity-report-v1'
export const STALE_AFTER_SECONDS = 3_600
const DAY = 86_400
const uint = value => Number.isSafeInteger(value) && value >= 0
const blockNumber = value => typeof value === 'string' && /^\d+$/.test(value)

export function isUsableReport(report, maxAgeSeconds = 14 * DAY) {
  if (!report || report.schemaVersion !== 2 || report.chainId !== 4663 || report.token !== TOKEN) return false
  // Old edge reports mix proxy addresses with sender counts and reuse stale maturity.
  if (!['full', 'incremental', 'current'].includes(report.index?.mode)) return false
  if (!blockNumber(report.fromBlock) || !blockNumber(report.throughBlock) || BigInt(report.fromBlock) > BigInt(report.throughBlock)) return false
  if (!uint(report.fromTimestamp) || !uint(report.throughTimestamp)) return false
  const age = Date.now() / 1000 - report.throughTimestamp
  if (age < -60 || age >= maxAgeSeconds) return false
  const from = Math.floor(report.throughTimestamp / DAY) * DAY - 6 * DAY
  if (report.fromTimestamp !== from || !Array.isArray(report.days) || report.days.length !== 7) return false
  if (!Number.isFinite(Date.parse(report.generatedAt))) return false
  for (const [i, day] of report.days.entries()) {
    if (!day || day.date !== new Date((from + i * DAY) * 1000).toISOString().slice(0, 10)) return false
    if (![day.mints, day.claims, day.mintWallets, day.claimWallets].every(uint)) return false
    if (day.mintWallets > day.mints || day.claimWallets > day.claims) return false
    if (typeof day.claimedFuel !== 'string' || !/^\d+(\.\d{1,18})?$/.test(day.claimedFuel)) return false
  }
  const maturity = report.maturity
  if (!maturity || !['ready', 'unavailable'].includes(maturity.status)) return false
  if (maturity.status === 'ready') {
    if (!uint(maturity.activeCount) || !uint(maturity.due) || maturity.due > maturity.activeCount || !Array.isArray(maturity.days)) return false
    if (maturity.firstMaturityTs !== null && maturity.firstMaturityTs !== undefined && !uint(maturity.firstMaturityTs)) return false
    if (maturity.days.length !== MATURITY_DAY_COUNT || !uint(maturity.samplesChecked)) return false
    for (const [i, day] of maturity.days.entries()) {
      if (!day || day.date !== new Date((from + i * DAY) * 1000).toISOString().slice(0,10) || !uint(day.scheduled)) return false
    }
  }
  return true
}

export function activityEnvelope(report, extra = {}) {
  if (!isUsableReport(report)) return { ...extra, status: 'error', progress: null, error: extra.error ?? 'Activity snapshot unavailable', report: null }
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - report.throughTimestamp))
  const stale = ageSeconds > STALE_AFTER_SECONDS
  return { ...extra, status: stale ? 'stale' : 'ready', progress: null,
    error: stale ? `Activity tip is ${ageSeconds}s behind (stale threshold ${STALE_AFTER_SECONDS}s)` : null, report }
}

export async function loadReport(env) {
  // Independently tolerate storage/asset failures and compare coverage, not fetch time.
  const candidates = await Promise.all([
    (async () => { try { return { report: await storeGetJson(env, REPORT_KEY), source: 'd1' } } catch { return null } })(),
    (async () => { try {
      const response = await env.ASSETS?.fetch(new Request('https://assets.local/fuel-activity.json'))
      return response?.ok ? { report: await response.json(), source: 'assets' } : null
    } catch { return null } })(),
  ])
  const valid = candidates.filter(candidate => candidate && isUsableReport(candidate.report))
  valid.sort((a, b) => {
    const left = BigInt(a.report.throughBlock), right = BigInt(b.report.throughBlock)
    if (left !== right) return left > right ? -1 : 1
    const observed=Date.parse(b.report.generatedAt)-Date.parse(a.report.generatedAt)
    if(observed!==0)return observed
    // Direct publisher storage is authoritative when coverage and time agree.
    return a.source === 'kv' ? -1 : 1
  })
  return valid[0] ?? { report: null, source: 'none' }
}
