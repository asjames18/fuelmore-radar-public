import { useMemo, useState } from 'react'
import { Brush, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatUsd } from '../lib/format'
import { marketComparison, type ChartRange } from '../lib/marketComparison'
import type { HistoryPoint } from '../lib/types'

type Metric = 'price' | 'liquidity'
const utcTick = (value: number) => new Date(value).toISOString().slice(5,16).replace('T',' ')
const percent = (value: number) => `${value>0?'+':''}${value.toFixed(2)}%`
export function MarketChart({ history }: { history: HistoryPoint[] }) {
  const [symbol, setSymbol] = useState<'Compare' | 'FUEL' | 'MORE'>('Compare')
  const [metric, setMetric] = useState<Metric>('price')
  const [range, setRange] = useState<ChartRange>('ALL')
  const {points, base} = useMemo(()=>marketComparison(history,range),[history,range])
  const isPrice = metric === 'price'
  const comparing = symbol === 'Compare'
  const normalized = comparing && isPrice
  const series = symbol === 'Compare' ? ['FUEL','MORE'] as const : [symbol]
  const keyFor = (token: string) => `${token==='FUEL'?'fuel':'more'}${normalized?'Change':isPrice?'Price':'Liquidity'}`
  const enough = points.filter(p => normalized ? p.fuelChange!==null && p.moreChange!==null : isPrice ? (symbol==='MORE'?p.morePrice:p.fuelPrice)!==null : p.fuelLiquidity!==null || p.moreLiquidity!==null).length>1
  return <section className="panel chart-panel comparison-chart" aria-labelledby="market-chart-title">
    <div className="panel-heading chart-heading">
      <div><h2 id="market-chart-title">FUEL / MORE comparison</h2><p>{normalized ? 'Price change (%) · same starting observation' : isPrice ? `${symbol} price · USD` : 'Pool liquidity · USD'} · UTC</p></div>
      <div className="segmented" aria-label="Chart metric">{(['price','liquidity'] as const).map(m=><button key={m} aria-pressed={metric===m} className={metric===m?'active':''} onClick={()=>setMetric(m)}>{m==='price'?'Price':'Liquidity'}</button>)}</div>
    </div>
    <div className="chart-toolbar">
      <div className="segmented" aria-label="Chart token">{(['Compare','FUEL','MORE'] as const).map(token=><button key={token} aria-pressed={symbol===token} className={symbol===token?'active':''} onClick={()=>setSymbol(token)}>{token}</button>)}</div>
      <div className="segmented" aria-label="Chart range">{(['1D','7D','30D','ALL'] as const).map(r=><button key={r} aria-pressed={range===r} className={range===r?'active':''} onClick={()=>setRange(r)}>{r}</button>)}</div>
    </div>
    <div className="chart-wrap" role="img" aria-label={`${symbol} ${metric} chart. Exact observations are available below.`}>
      {!enough && <div className="chart-empty"><span>Collecting observations</span><small>{normalized && !base?'Waiting for a shared FUEL and MORE price observation.':'The next successful scheduled sync adds another observation.'}</small></div>}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart key={`${symbol}-${metric}-${range}`} data={points} margin={{top:18,right:14,left:0,bottom:0}}>
          <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
          <XAxis dataKey="at" type="number" domain={['dataMin','dataMax']} stroke="#70847a" tick={{fontSize:10}} tickFormatter={utcTick} minTickGap={45}/>
          <YAxis domain={['auto','auto']} stroke="#70847a" tick={{fontSize:10}} tickFormatter={value=>normalized?percent(Number(value)):formatUsd(Number(value),!isPrice)} width={76}/>
          {normalized && <ReferenceLine y={0} stroke="#60766b" strokeDasharray="4 4"/>}
          <Tooltip cursor={{stroke:'#93ada0',strokeDasharray:'3 3'}} labelFormatter={value=>`${new Date(Number(value)).toISOString().replace('T',' ').slice(0,19)} UTC`} formatter={(value)=>normalized?percent(Number(value)):formatUsd(Number(value),false)} contentStyle={{background:'#071009',border:'1px solid #245c34',borderRadius:5,fontFamily:'var(--mono)'}}/>
          <Legend iconType="plainline" wrapperStyle={{fontSize:11}}/>
          {series.map(token=><Line key={token} name={token} type="linear" dataKey={keyFor(token)} stroke={token==='FUEL'?'#36ff6a':'#63b3ff'} strokeWidth={2} dot={points.length<3} activeDot={{r:4}} connectNulls={false} isAnimationActive={false}/>)}
          {points.length>2 && <Brush dataKey="at" height={22} stroke="#37654a" fill="#071009" tickFormatter={utcTick} travellerWidth={10}/>}
        </LineChart>
      </ResponsiveContainer>
    </div>
    <p className="chart-note">Saved observations, not candles. Drag the range handles to zoom. {normalized && base ? `0% starts at ${new Date(base.at).toISOString().replace('T',' ').slice(0,19)} UTC. ` : ''}History is saved in this browser; missing readings remain gaps.</p>
    <details className="chart-observations"><summary>Exact observations · {symbol}</summary><div className="planner-table-scroll"><table><caption>{symbol} {metric} observations</caption><thead><tr><th>Time (UTC)</th>{series.map(token=><th key={token}>{token} {isPrice?'price':'liquidity'} (USD)</th>)}</tr></thead><tbody>{points.map(point=><tr key={point.at}><td>{new Date(point.at).toISOString()}</td>{series.map(token=>{
      const value=isPrice?(token==='FUEL'?point.fuelPrice:point.morePrice):(token==='FUEL'?point.fuelLiquidity:point.moreLiquidity)
      return <td key={token}>{value===null?'Unavailable':formatUsd(value)}</td>
    })}</tr>)}</tbody></table></div></details>
  </section>
}
