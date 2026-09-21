/** Privacy-respecting usage beacon. Sends event names only — no cookies,
 * no identifiers, no wallet addresses. Honors the browser's Do Not Track flag.
 */

export type AnalyticsEvent =
  | 'view_selected'
  | 'cockpit_open'
  | 'wallet_lookup'
  | 'chart_rendered'
  | 'refresh_clicked'
  | 'donate_clicked'
  | 'contract_copied'

export function track(event: AnalyticsEvent): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return
    const payload = JSON.stringify({ event })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon('/api/analytics', new Blob([payload], { type: 'application/json' }))) return
    }
    // Best-effort fallback: rejections must never surface as unhandled errors.
    if (typeof fetch === 'function') {
      void fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    }
  } catch {
    /* Analytics never breaks the app. */
  }
}
