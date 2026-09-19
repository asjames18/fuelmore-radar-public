import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRadarData } from './lib/api'
import { readHistory, recordHistory } from './lib/history'
import type { HistoryPoint, RadarData } from './lib/types'

export function useRadarData() {
  const [now, setNow] = useState(() => Date.now())
  const [data, setData] = useState<RadarData | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>(() => readHistory())
  const [status, setStatus] = useState<'loading' | 'live' | 'partial' | 'stale' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const hasData = useRef(false)

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    if (!hasData.current) setStatus('loading')
    try {
      const next = await fetchRadarData()
      setData(next)
      hasData.current = true
      setHistory(recordHistory(next.pairs))
      setStatus(next.partial ? 'partial' : 'live')
      setError(next.partial ? 'Some sources are unavailable. Missing values are shown as —; see Data sources for coverage.' : null)
    } catch (cause) {
      setStatus(hasData.current ? 'stale' : 'error')
      setError(cause instanceof Error ? cause.message : 'Unable to load chain data')
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const clock = window.setInterval(() => setNow(Date.now()), 15_000)
    const interval = window.setInterval(() => void refresh(), 30_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
      window.clearInterval(clock)
    }
  }, [refresh])

  const displayedStatus = (status === 'live' || status === 'partial') && data && now - Date.parse(data.updatedAt) > 120_000 ? 'stale' : status
  return { data, history, status: displayedStatus, error, refresh }
}
