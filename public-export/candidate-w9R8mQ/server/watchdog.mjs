// Watchdog for the GitHub Actions publisher schedule ("Refresh FUEL activity").
//
// GitHub's scheduler drops most `*/15` triggers (observed ~8-10 runs/day, gaps
// up to 7h), while the Worker's own cron fires reliably every 15 minutes. This
// watchdog checks how old the two pipeline snapshots in KV are and forces a
// workflow run via `workflow_dispatch` only when the pipeline has gone quiet.
// The staleness threshold is set well above GitHub's observed ~3h cadence so
// the watchdog fires a few extra runs per month at most (zero new spend), and
// a cooldown prevents duplicate dispatches while a forced run is in flight.
//
// The dispatch token lives in the `GITHUB_DISPATCH_TOKEN` Worker secret, never
// in config or source. A fine-grained PAT with Actions: Read and write on the
// repo is enough. Without the secret the watchdog logs and does nothing.

export const WATCHDOG = {
  owner: 'asjames18',
  repo: 'fuelmore-radar',
  workflowFile: 'refresh-activity.yml',
  ref: 'main',
  // Force a run only when a snapshot is older than this. GitHub's observed
  // cadence (~3h) means this rarely fires; worst-case staleness is capped
  // instead of growing to 6-7h.
  staleMinutes: 240,
  // Never force runs more often than this, even if snapshots stay stale.
  cooldownMinutes: 60,
  dashboardKey: 'dashboard-snapshot-v1',
  activityKey: 'fuel-activity-report-v1',
  lastDispatchKey: 'watchdog-last-dispatch',
  secretName: 'GITHUB_DISPATCH_TOKEN',
}

function minutesBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / 60_000
}

/** Parse a raw KV snapshot string to an ISO timestamp string, or null. */
function extractTimestamp(raw, pick) {
  if (typeof raw !== 'string' || raw.length > 2_000_000) return null
  try {
    const parsed = JSON.parse(raw)
    const value = pick(parsed)
    if (typeof value !== 'string') return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? value : null
  } catch {
    return null
  }
}

const dashboardTimestamp = raw => extractTimestamp(raw, parsed => parsed?.data?.updatedAt)
const activityTimestamp = raw => extractTimestamp(raw, parsed => parsed?.generatedAt)

async function readAgeMinutes(kv, key, extract, nowMs) {
  try {
    const raw = await kv.get(key)
    const stamp = extract(raw)
    return stamp === null ? Number.POSITIVE_INFINITY : minutesBetween(nowMs, Date.parse(stamp))
  } catch {
    // A KV read failure must not block the check; treat as stale and let the
    // forced run refresh whatever it can.
    return Number.POSITIVE_INFINITY
  }
}

async function dispatchWorkflowRun({ token, fetchImpl, config }) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowFile}/dispatches`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ref: config.ref }),
  })
  return response.status === 204
}

/**
 * Check pipeline snapshot freshness and force a GitHub workflow run when the
 * pipeline has gone quiet. Never throws: any failure yields a checked:false
 * (unavailable) or a no-dispatch result, so the caller's cron work is safe.
 */
export async function checkPipelineFreshness(env, options = {}) {
  const config = options.config ?? WATCHDOG
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const nowMs = now()

  if (!env?.ACTIVITY || typeof env.ACTIVITY.get !== 'function') {
    return { checked: false, stale: false, dispatched: false, ages: { dashboard: null, activity: null }, reason: 'kv-unavailable' }
  }

  const dashboardAge = await readAgeMinutes(env.ACTIVITY, config.dashboardKey, dashboardTimestamp, nowMs)
  const activityAge = await readAgeMinutes(env.ACTIVITY, config.activityKey, activityTimestamp, nowMs)
  const ages = { dashboard: dashboardAge, activity: activityAge }
  const stale = !Number.isFinite(dashboardAge) || dashboardAge > config.staleMinutes || !Number.isFinite(activityAge) || activityAge > config.staleMinutes

  if (!stale) return { checked: true, stale: false, dispatched: false, ages, reason: 'fresh' }

  const token = env[config.secretName]
  if (!token || typeof token !== 'string') {
    return { checked: true, stale: true, dispatched: false, ages, reason: 'token-missing' }
  }

  try {
    const lastRaw = await env.ACTIVITY.get(config.lastDispatchKey)
    if (lastRaw !== null && lastRaw !== undefined) {
      const lastMs = Date.parse(String(lastRaw))
      if (Number.isFinite(lastMs) && minutesBetween(nowMs, lastMs) < config.cooldownMinutes) {
        return { checked: true, stale: true, dispatched: false, ages, reason: 'cooldown' }
      }
    }
  } catch {
    // Best-effort cooldown only; continue to the dispatch attempt.
  }

  let dispatched = false
  try {
    dispatched = await dispatchWorkflowRun({ token, fetchImpl, config })
  } catch {
    dispatched = false
  }
  if (!dispatched) return { checked: true, stale: true, dispatched: false, ages, reason: 'dispatch-failed' }

  try {
    await env.ACTIVITY.put(config.lastDispatchKey, new Date(nowMs).toISOString())
  } catch {
    // The dispatch already happened; a missed cooldown write is harmless.
  }
  return { checked: true, stale: true, dispatched: true, ages, reason: 'dispatched' }
}
