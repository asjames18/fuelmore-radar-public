import { useEffect, useMemo, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Flame } from 'lucide-react'
import { fetchBurns, type BurnsResponse } from '../lib/burns'
import { timeAgo } from '../lib/format'

const FUEL_GREEN = '#36ff6a'

const fmtFuel = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

const fmtEth = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(4)} ETH`
}

const fmtInt = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US')

const tickDate = (iso: string) => iso.slice(5).replace('-', '/')

type ChartPoint = {
  date: string
  label: string
  fuel: number
  cumulative: number
  eth: number | null
  drips: number | null
}

function BurnTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="chart-tooltip">
      <strong>{point.date}</strong>
      <span>Burned: {fmtFuel(point.fuel)} FUEL</span>
      <span>Cumulative: {fmtFuel(point.cumulative)} FUEL</span>
      <span>ETH spent: {fmtEth(point.eth)}</span>
      <span>Drips: {fmtInt(point.drips)}</span>
    </div>
  )
}

export function BurnChart() {
  const [data, setData] = useState<BurnsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    fetchBurns()
      .then((result) => {
        if (live) setData(result)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  const points: ChartPoint[] = useMemo(() => {
    if (!data || data.status !== 'ok') return []
    let running = 0
    return data.days.map((day) => {
      const fuel = day.fuel ?? 0
      running += fuel
      return {
        date: day.date,
        label: tickDate(day.date),
        fuel,
        cumulative: running,
        eth: day.eth,
        drips: day.drips,
      }
    })
  }, [data])

  const collecting = !failed && (!data || data.status === 'collecting')
  const freshness =
    data?.through_block != null
      ? `Data through block ${Number(data.through_block).toLocaleString('en-US')}${
          data.through_time ? ` · ${timeAgo(data.through_time)}` : ''
        }`
      : null
  const totals = data?.totals

  return (
    <section className="panel" aria-labelledby="burn-chart-title">
      <div className="panel-heading compact">
        <div>
          <h2 id="burn-chart-title">
            <Flame size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            FUEL buy &amp; burn
          </h2>
          <p>
            Daily FUEL destroyed by the burn engine{freshness ? ` · ${freshness}` : ''}
          </p>
        </div>
      </div>
      {failed ? (
        <p className="activity-message" role="status">
          Burn history could not be loaded. Please retry — this is not a confirmed empty series.
        </p>
      ) : collecting ? (
        <p className="activity-message" role="status">
          Collecting burn history…
        </p>
      ) : (
        <>
          <div className="burn-totals">
            <div>
              <span>Total burned</span>
              <strong>{fmtFuel(totals?.fuel)} FUEL</strong>
            </div>
            <div>
              <span>ETH spent</span>
              <strong>{fmtEth(totals?.eth)}</strong>
            </div>
            <div>
              <span>Burn drips</span>
              <strong>{fmtInt(totals?.drips)}</strong>
            </div>
          </div>
          <div className="burn-chart-wrap">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#8a93a6', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fill: '#8a93a6', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: number) => fmtFuel(value)}
                  width={52}
                />
                <Tooltip content={<BurnTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="fuel" name="Daily burned" fill={FUEL_GREEN} radius={[2, 2, 0, 0]} maxBarSize={28} />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  name="Cumulative"
                  stroke="var(--amber)"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span>
              <span className="dot" style={{ background: FUEL_GREEN }}></span>Daily FUEL burned
            </span>
            <span>
              <span className="dot" style={{ background: 'var(--amber)' }}></span>Cumulative
            </span>
          </div>
        </>
      )}
      {data?.methodology && <p className="activity-note">{data.methodology}</p>}
    </section>
  )
}
