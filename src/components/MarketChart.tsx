import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatUsd } from '../lib/format'
import type { HistoryPoint } from '../lib/types'

type Metric = 'price' | 'liquidity'

export function MarketChart({ history }: { history: HistoryPoint[] }) {
  const [symbol, setSymbol] = useState<'FUEL' | 'MORE'>('FUEL')
  const [metric, setMetric] = useState<Metric>('price')
  const chartData = useMemo(() => history.map((point) => ({
    ...point,
    label: new Date(point.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  })), [history])
  const isPrice = metric === 'price'
  const enoughHistory = chartData.length > 1

  return (
    <section className="panel chart-panel" aria-labelledby="market-chart-title">
      <div className="panel-heading chart-heading">
        <div>
          <h2 id="market-chart-title">Live session</h2>
          <p>Observed snapshots saved in this browser · updates attempted every 30 seconds. Missing readings remain gaps.</p>
          <div className="segmented" aria-label="Chart token">{(['FUEL', 'MORE'] as const).map(token => <button key={token} aria-pressed={symbol === token} onClick={() => setSymbol(token)}>{token}</button>)}</div>
        </div>
        <div className="segmented" aria-label="Chart metric">
          <button className={isPrice ? 'active' : ''} onClick={() => setMetric('price')}>Price</button>
          <button className={!isPrice ? 'active' : ''} onClick={() => setMetric('liquidity')}>Liquidity</button>
        </div>
      </div>
      <div className="chart-wrap">
        {!enoughHistory && <div className="chart-empty"><span>Collecting observations</span><small>Refresh again in 30 seconds to begin the trend line.</small></div>}
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 18, right: 14, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="fuelFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#36ff6a" stopOpacity="0.22"/><stop offset="1" stopColor="#36ff6a" stopOpacity="0"/></linearGradient>
              <linearGradient id="moreFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#adf8c9" stopOpacity="0.16"/><stop offset="1" stopColor="#adf8c9" stopOpacity="0"/></linearGradient>
            </defs>
            <CartesianGrid stroke="#173321" vertical={false} />
            <XAxis dataKey="label" stroke="#70847a" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis domain={['auto', 'auto']} stroke="#70847a" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => isPrice ? formatUsd(Number(value)) : formatUsd(Number(value), true)} width={72} />
            <Tooltip contentStyle={{ background: '#071009', border: '1px solid #245c34', borderRadius: 5, fontFamily: 'var(--mono)' }} formatter={(value) => formatUsd(Number(value), !isPrice)} />
            <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11, color: '#a7bbb0' }} />
            <Area type="linear" name={symbol} dataKey={isPrice ? (symbol === 'FUEL' ? 'fuelPrice' : 'morePrice') : (symbol === 'FUEL' ? 'fuelLiquidity' : 'moreLiquidity')} stroke="#36ff6a" strokeWidth={2} fill="url(#fuelFill)" connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <details className="chart-observations"><summary>Exact observations · {symbol}</summary><div className="planner-table-scroll"><table><caption>{symbol} {metric} observations</caption><thead><tr><th>Time (UTC)</th><th>{isPrice ? 'Price' : 'Liquidity'} (USD)</th></tr></thead><tbody>{chartData.map(point => {
        const value = isPrice ? (symbol === 'FUEL' ? point.fuelPrice : point.morePrice) : (symbol === 'FUEL' ? point.fuelLiquidity : point.moreLiquidity)
        return <tr key={point.at}><td>{new Date(point.at).toISOString()}</td><td>{value === null ? 'Unavailable' : formatUsd(value)}</td></tr>
      })}</tbody></table></div></details>
    </section>
  )
}
