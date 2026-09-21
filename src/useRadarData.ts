import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRadarData } from './lib/api'
import { readHistory, recordHistory } from './lib/history'
import { decodeDashboard, encodeDashboard, mergeDashboard, DASHBOARD_MAX_AGE } from './lib/dashboardSnapshot'
import { storageKey } from './lib/storage'
import type { HistoryPoint, RadarData } from './lib/types'

function savedDashboard() {
  try { return decodeDashboard(localStorage.getItem(storageKey('dashboard')) ?? '') } catch { return null }
}
export function useRadarData() {
  const [now, setNow] = useState(() => Date.now())
  const [data, setData] = useState<RadarData | null>(savedDashboard)
  const current = useRef(data)
  const [history, setHistory] = useState<HistoryPoint[]>(() => readHistory())
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const busy = useRef(false)

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setRefreshing(true)
    try {
      let incoming: RadarData
      if (['localhost','127.0.0.1'].includes(window.location.hostname)) {
        incoming = mergeDashboard(current.current, await fetchRadarData())
      } else {
        const response = await fetch('/api/dashboard', { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error('Scheduled sync unavailable. Showing saved data where available.')
        const decoded = decodeDashboard(await response.text())
        if (!decoded) throw new Error('Saved snapshot failed validation. Previous data retained.')
        incoming = decoded
      }
      // A lagging KV replica must not move a browser back to an older sync.
      const next = current.current && Date.parse(current.current.updatedAt) > Date.parse(incoming.updatedAt) ? current.current : incoming
      current.current = next
      setData(next)
      try { localStorage.setItem(storageKey('dashboard'), encodeDashboard(next)) } catch { /* Session remains usable. */ }
      const market = next.sources.find(s => s.name === 'Dexscreener markets')
      if (market?.status === 'available' && !market.retained) setHistory(recordHistory(next.pairs, Date.parse(market.checkedAt)))
      setError(null)
      setNow(Date.now())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load saved dashboard')
    } finally {
      busy.current = false
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const clock = window.setInterval(() => setNow(Date.now()), 15_000)
    const interval = window.setInterval(() => void refresh(), 60_000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval); window.clearInterval(clock) }
  }, [refresh])

  const stale = data?.sources.some(s => s.retained || now - Date.parse(s.checkedAt) > DASHBOARD_MAX_AGE)
  const status = !data ? error ? 'error' : 'loading' : stale || error ? 'stale' : data.partial ? 'partial' : 'live'
  return { data, history, status, error: error ?? (data?.partial ? 'Some sources could not refresh. Saved values retain their original observation time; unavailable values remain —.' : null), refresh, refreshing }
}
