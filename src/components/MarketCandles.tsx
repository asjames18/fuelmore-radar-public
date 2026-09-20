import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { CANDLE_BUCKETS, toCandles, type CandleBucket, type MarketCandle } from '../lib/marketHistory'
import { DEXSCREENER, PAIRS } from '../lib/contracts'
import type { HistoryPoint } from '../lib/types'

const TOKEN_COLORS = { FUEL: '#36ff6a', MORE: '#63b3ff' } as const
export type CandleToken = keyof typeof TOKEN_COLORS

type LiveChart = { chart: IChartApi; series: ISeriesApi<'Candlestick'>; observer: ResizeObserver }

function toSeriesData(candles: MarketCandle[]) {
  return candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp }))
}

function CandlePane({ token, history, bucket }: { token: CandleToken; history: HistoryPoint[]; bucket: CandleBucket }) {
  const liveRef = useRef<LiveChart | null>(null)
  const [failed, setFailed] = useState(false)
  const candles = useMemo(
    () => toCandles(history, token === 'FUEL' ? 'fuelPrice' : 'morePrice', CANDLE_BUCKETS[bucket]),
    [history, token, bucket],
  )
  const candlesRef = useRef(candles)
  useEffect(() => { candlesRef.current = candles }, [candles])

  const detach = useCallback(() => {
    const live = liveRef.current
    if (live) {
      live.observer.disconnect()
      live.chart.remove()
      liveRef.current = null
    }
  }, [])

  // Callback ref: (re)creates the chart when the container mounts or the token changes.
  const attach = useCallback((container: HTMLDivElement | null) => {
    detach()
    if (!container) return
    try {
      const chart = createChart(container, {
        width: container.clientWidth > 0 ? container.clientWidth : 320,
        height: 300,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#70847a', fontFamily: 'var(--mono)' },
        grid: { vertLines: { color: '#12241a' }, horzLines: { color: '#12241a' } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1d3a28' },
        rightPriceScale: { borderColor: '#1d3a28' },
      })
      const series = chart.addSeries(CandlestickSeries, {
        upColor: TOKEN_COLORS[token],
        downColor: '#ff5d5d',
        wickUpColor: TOKEN_COLORS[token],
        wickDownColor: '#ff5d5d',
        borderVisible: false,
        priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 },
      })
      const observer = new ResizeObserver(() => {
        if (container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth })
      })
      observer.observe(container)
      liveRef.current = { chart, series, observer }
      series.setData(toSeriesData(candlesRef.current))
      chart.timeScale().fitContent()
    } catch {
      // Canvas unavailable (older browsers, test environments): show the fallback.
      setFailed(true)
    }
  }, [detach, token])

  useEffect(() => {
    const live = liveRef.current
    if (!live) return
    live.series.setData(toSeriesData(candles))
    live.chart.timeScale().fitContent()
  }, [candles])

  useEffect(() => detach, [detach])

  const pairAddress = PAIRS[token === 'FUEL' ? 'fuel' : 'more']
  return (
    <div className="candle-pane">
      <div className="candle-heading">
        <strong style={{ color: TOKEN_COLORS[token] }}>{token} / USD</strong>
        <a href={`${DEXSCREENER}/${pairAddress}`} target="_blank" rel="noreferrer">Open chart ↗</a>
      </div>
      {failed ? (
        <div className="chart-empty chart-empty-static"><span>Chart unavailable in this browser</span><small>Use Open chart for the Dexscreener view.</small></div>
      ) : (
        <>
          {candles.length === 0 && (
            <div className="chart-empty chart-empty-static"><span>Collecting market history</span><small>Candles appear as Radar snapshots accumulate.</small></div>
          )}
          <div ref={attach} className="candle-chart" role="img" aria-label={`${token} USD candlestick chart built from Radar snapshots`} />
        </>
      )}
    </div>
  )
}

export function MarketCandles({ history, tokens }: { history: HistoryPoint[]; tokens: readonly CandleToken[] }) {
  const [bucket, setBucket] = useState<CandleBucket>('1H')
  return (
    <>
      <div className="chart-toolbar">
        <div className="segmented" aria-label="Candle interval">
          {(Object.keys(CANDLE_BUCKETS) as CandleBucket[]).map((option) => (
            <button key={option} aria-pressed={bucket === option} className={bucket === option ? 'active' : ''} onClick={() => setBucket(option)}>
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className={`candle-grid ${tokens.length === 1 ? 'single' : ''}`}>
        {tokens.map((token) => (
          <CandlePane key={token} token={token} history={history} bucket={bucket} />
        ))}
      </div>
    </>
  )
}
