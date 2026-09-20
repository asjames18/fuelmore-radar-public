import { useEffect, useMemo, useState } from 'react'
import { fetchMarketHistory, mergeHistories } from './lib/marketHistory'
import type { HistoryPoint } from './lib/types'

/**
 * Shared market history: the Worker's 15-minute snapshots first, falling back
 * to (and merging with) this browser's saved observations while the server
 * history is still ramping up after launch.
 */
export function useMarketHistory(localHistory: HistoryPoint[]) {
  const [serverHistory, setServerHistory] = useState<HistoryPoint[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetchMarketHistory(controller.signal).then(
      (points) => { if (!cancelled) setServerHistory(points) },
      () => { if (!cancelled) setServerHistory([]) },
    )
    return () => { cancelled = true; controller.abort() }
  }, [])

  const history = useMemo(
    () => mergeHistories(serverHistory ?? [], localHistory),
    [serverHistory, localHistory],
  )

  return { history, serverReady: serverHistory !== null, serverPoints: serverHistory?.length ?? 0 }
}
