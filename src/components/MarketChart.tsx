import { useMemo, useState } from 'react'
import { Area, Brush, CartesianGrid, ComposedChart, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatUsd } from '../lib/format'
import { PAIRS, DEXSCREENER } from '../lib/contracts'
import { marketComparison, type ChartRange } from '../lib/marketComparison'
import type { HistoryPoint } from '../lib/types'

type Metric = 'price' | 'liquidity'
type View = 'candles' | 'usd' | 'percent'
const utcTick = (value: number) => new Date(value).toISOString().slice(5,16).replace('T',' ')
const percent = (value: number) => `${value>0?'+':''}${value.toFixed(2)}%`
const colors = {FUEL:'#36ff6a',MORE:'#63b3ff'}
// Parameters from Dexscreener's official "Embed this chart" dialog. Never synthesize OHLC from snapshots.
const candleUrl = (token: 'FUEL'|'MORE') => `${DEXSCREENER}/${PAIRS[token==='FUEL'?'fuel':'more']}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=60`

export function MarketChart({ history }: { history: HistoryPoint[] }) {
  const [symbol, setSymbol] = useState<'Compare' | 'FUEL' | 'MORE'>('Compare')
  const [metric, setMetric] = useState<Metric>('price')
  const [view, setView] = useState<View>('candles')
  const [range, setRange] = useState<ChartRange>('ALL')
  const {points, base} = useMemo(()=>marketComparison(history,range),[history,range])
  const isPrice = metric === 'price'
  const candles = isPrice && view==='candles'
  const normalized = isPrice && view==='percent'
  const dual = isPrice && !normalized && symbol==='Compare'
  const series = symbol === 'Compare' ? ['FUEL','MORE'] as const : [symbol]
  const keyFor = (token: string) => `${token==='FUEL'?'fuel':'more'}${normalized?'Change':isPrice?'Price':'Liquidity'}`
  const enough = points.length>1
  const description = candles ? 'USD candles · market history' : normalized ? 'Price change (%) · shared starting observation · UTC' : isPrice ? (dual?'Actual price · USD · FUEL left · MORE right · independent scales':'Actual price · USD · UTC') : 'Pool liquidity · USD · UTC'
  return <section className="panel chart-panel comparison-chart" aria-labelledby="market-chart-title">
    <div className="panel-heading chart-heading">
      <div><h2 id="market-chart-title">FUEL / MORE comparison</h2><p>{description}</p></div>
      <div className="segmented" aria-label="Chart metric">{(['price','liquidity'] as const).map(m=><button key={m} aria-pressed={metric===m} className={metric===m?'active':''} onClick={()=>setMetric(m)}>{m==='price'?'Price':'Liquidity'}</button>)}</div>
    </div>
    <div className="chart-toolbar">
      <div className="segmented" aria-label="Chart token">{(['Compare','FUEL','MORE'] as const).map(token=><button key={token} aria-pressed={symbol===token} className={symbol===token?'active':''} onClick={()=>setSymbol(token)}>{token==='Compare'?'Both':token}</button>)}</div>
      {isPrice && <div className="segmented" aria-label="Price presentation">{(['candles','usd','percent'] as const).map(v=><button key={v} aria-pressed={view===v} className={view===v?'active':''} onClick={()=>setView(v)}>{v==='candles'?'Candles':v==='usd'?'Compare USD':'Change %'}</button>)}</div>}
      {!candles && <div className="segmented" aria-label="Chart range">{(['1D','7D','30D','ALL'] as const).map(r=><button key={r} aria-pressed={range===r} className={range===r?'active':''} onClick={()=>setRange(r)}>{r}</button>)}</div>}
    </div>
    {candles ? <>
      <div className={`candle-grid ${series.length===1?'single':''}`}>
        {series.map(token=><div className="candle-pane" key={token}>
          <div className="candle-heading"><strong style={{color:colors[token]}}>{token} / USD</strong><a href={`${DEXSCREENER}/${PAIRS[token==='FUEL'?'fuel':'more']}`} target="_blank" rel="noreferrer">Open chart ↗</a></div>
          <iframe title={`${token} USD candlestick chart`} src={candleUrl(token)} referrerPolicy="strict-origin-when-cross-origin"/>
        </div>)}
      </div>
      <p className="chart-note">Market candles by Dexscreener · each token has its own USD scale. Use Compare USD to overlay both tokens. If a chart cannot load, use Open chart.</p>
    </> : <>
      <div className="chart-quotes" aria-label="Latest chart observations">{series.map(token=>{
        const p=points.at(-1); const value=p ? isPrice?(token==='FUEL'?p.fuelPrice:p.morePrice):(token==='FUEL'?p.fuelLiquidity:p.moreLiquidity):null
        return <div key={token}><span style={{color:colors[token]}}>{token}</span><strong>{formatUsd(value??null,!isPrice)}</strong></div>
      })}</div>
      <div className="chart-wrap" role="img" aria-label={`${symbol} ${metric} ${normalized?'percentage':'USD'} comparison chart. Hover or focus a point for its value.`}>
        {!enough && <div className="chart-empty"><span>Building comparison history</span><small>The next successful sync adds another observation.</small></div>}
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart key={`${symbol}-${metric}-${view}-${range}`} data={points} margin={{top:18,right:8,left:0,bottom:0}}>
            <defs>{series.map(token=><linearGradient key={token} id={`fill-${token}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[token]} stopOpacity={0.24}/><stop offset="100%" stopColor={colors[token]} stopOpacity={0.01}/></linearGradient>)}</defs>
            <CartesianGrid stroke="#173321" strokeDasharray="2 4"/>
            <XAxis dataKey="at" type="number" domain={['dataMin','dataMax']} stroke="#70847a" tick={{fontSize:10}} tickFormatter={utcTick} minTickGap={45}/>
            <YAxis yAxisId="left" domain={['auto','auto']} stroke={dual?colors.FUEL:'#70847a'} tick={{fontSize:10}} tickFormatter={value=>normalized?percent(Number(value)):formatUsd(Number(value),!isPrice)} width={76}/>
            {dual && <YAxis yAxisId="right" orientation="right" domain={['auto','auto']} stroke={colors.MORE} tick={{fontSize:10}} tickFormatter={value=>formatUsd(Number(value))} width={76}/>}
            {normalized && <ReferenceLine yAxisId="left" y={0} stroke="#60766b" strokeDasharray="4 4"/>}
            <Tooltip cursor={{stroke:'#93ada0',strokeDasharray:'3 3'}} labelFormatter={value=>`${new Date(Number(value)).toISOString().replace('T',' ').slice(0,19)} UTC`} formatter={(value)=>normalized?percent(Number(value)):formatUsd(Number(value),false)} contentStyle={{background:'#071009',border:'1px solid #245c34',borderRadius:5,fontFamily:'var(--mono)'}}/>
            <Legend iconType="plainline" wrapperStyle={{fontSize:11}}/>
            {series.map(token=><Area yAxisId={dual && token==='MORE'?'right':'left'} key={token} name={token} type="linear" dataKey={keyFor(token)} stroke={colors[token]} fill={`url(#fill-${token})`} strokeWidth={2} dot={points.length<3} activeDot={{r:4}} connectNulls={false} isAnimationActive={false}/>)}
            {points.length>2 && <Brush dataKey="at" height={22} stroke="#37654a" fill="#071009" tickFormatter={utcTick} travellerWidth={10}/>}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-note">Saved market observations · drag the range handles to zoom. {normalized && base ? `0% starts at ${utcTick(base.at)} UTC. ` : ''}History is saved in this browser.</p>
    </>}
  </section>
}
