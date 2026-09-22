import { useEffect, useState } from 'react'
import type { MaturityReport } from './MaturityTimeline'

/**
 * First-claim countdown for the Overview hub.
 *
 * Counts down to the exact earliest maturity timestamp (`firstMaturityTs`) —
 * the real moment the first FUEL rewards unlock. Falls back to 00:00 UTC on
 * the first date with scheduled maturities when the snapshot predates the
 * exact timestamp field. When matured positions are already waiting
 * (`due > 0`), it flips to a "claims are live" state instead of a timer.
 * Quiet (renders nothing) when the maturity schedule is unavailable, so a
 * feed hiccup never blanks Overview.
 */
function pad(n: number) { return String(n).padStart(2, '0') }

function formatDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatExact(ts: number) {
  return new Date(ts * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC'
}

export function FirstClaimCountdown({ maturity }: { maturity: MaturityReport | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!maturity || maturity.status !== 'ready') return null

  if (maturity.due > 0) {
    return <div className="claim-countdown live" role="status" aria-label="First FUEL rewards are now claimable">
      <div className="claim-countdown-label">First rewards are live</div>
      <div className="claim-countdown-sub">{maturity.due.toLocaleString('en-US')} matured {maturity.due === 1 ? 'position' : 'positions'} ready to claim — look up a wallet in the Cockpit.</div>
    </div>
  }

  const today = new Date(now).toISOString().slice(0, 10)
  const next = maturity.days
    .filter(day => day.scheduled > 0 && day.date >= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0]

  // Prefer the exact earliest maturity timestamp when the snapshot carries it.
  const exact = maturity.firstMaturityTs ?? null
  const target = exact !== null ? exact * 1000 : next ? Date.parse(`${next.date}T00:00:00Z`) : null
  if (target === null) return null
  const diff = target - now
  if (diff <= 0) {
    return <div className="claim-countdown live" role="status" aria-label="First FUEL rewards are unlocking now">
      <div className="claim-countdown-label">Unlocking now</div>
      <div className="claim-countdown-sub">{next ? `First rewards maturing today — ${next.scheduled.toLocaleString('en-US')} ${next.scheduled === 1 ? 'position' : 'positions'} scheduled.` : 'First rewards maturing — check the Cockpit.'}</div>
    </div>
  }

  const totalSeconds = Math.floor(diff / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const digits = `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`
  const exactNote = exact !== null ? `Earliest unlock · ${formatExact(exact)}` : null

  return <div className="claim-countdown" role="timer" aria-label={`First FUEL rewards unlock in ${digits}`}>
    <div className="claim-countdown-label">First rewards unlock in</div>
    <div className="claim-countdown-digits" aria-hidden="true">{digits}</div>
    <div className="claim-countdown-sub">{exactNote ?? `Earliest unlock · ${formatDate(next!.date)}`}{next ? ` · ${next.scheduled.toLocaleString('en-US')} ${next.scheduled === 1 ? 'position' : 'positions'} maturing that day` : ''}</div>
  </div>
}
