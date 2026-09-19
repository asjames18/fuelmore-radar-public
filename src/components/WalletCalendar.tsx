import { useEffect, useMemo, useState } from 'react'
import { maturityState, monthCells, mintDueState, dateDueTone, walletCalendar } from '../lib/maturity'
import type { WalletPosition } from '../lib/types'

export function WalletCalendar({ position }: { position: WalletPosition }) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  const entries = useMemo(() => walletCalendar(position), [position])
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 30_000); return () => clearInterval(timer) }, [])
  const incomplete = position.batch.total === null || position.batch.nextOffset !== null || position.batch.items.some(item => !item.available) || !position.reads.mint || !position.reads.stake
  const visible = entries.filter(entry => new Date(entry.maturityTs * 1000).toISOString().startsWith(selected ?? month))
  const upcoming = entries.filter(entry => entry.maturityTs > now).length
  function changeMonth(delta: number) {
    const [year, number] = month.split('-').map(Number)
    setMonth(new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7))
    setSelected(null)
  }
  return <section className="wallet-calendar" aria-labelledby="wallet-calendar-title">
    <h3 id="wallet-calendar-title">FUEL maturity calendar</h3>
    <p>{entries.length} loaded positions · {upcoming} upcoming · {entries.length - upcoming} past their maturity time · UTC dates</p>
    {incomplete && <p role="status" className="calendar-warning">Partial coverage: load remaining batch slots or retry unavailable reads to complete this calendar.</p>}
    <div className="calendar-controls">
      <button onClick={() => changeMonth(-1)} aria-label="Previous calendar month">←</button>
      <strong>{month}</strong>
      <button onClick={() => changeMonth(1)} aria-label="Next calendar month">→</button>
      {entries.length > 0 && <button onClick={() => { setMonth(new Date(entries[0].maturityTs * 1000).toISOString().slice(0, 7)); setSelected(null) }}>First maturity</button>}
      {selected && <button onClick={() => setSelected(null)}>Show whole month</button>}
    </div>
    <div className="calendar-grid">
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span className="weekday" key={day}>{day}</span>)}
      {monthCells(month).map((date, index) => {
        if (!date) return <span key={`blank-${index}`}/>
        const count = entries.filter(entry => new Date(entry.maturityTs * 1000).toISOString().slice(0, 10) === date).length
        return <button key={date} className={selected === date ? 'selected' : ''} aria-pressed={selected === date} aria-label={`${date}, ${count} positions maturing`} onClick={() => setSelected(date)}><span>{Number(date.slice(-2))}</span>{count > 0 && <b>{count}</b>}</button>
      })}
    </div>
    <div className="calendar-agenda" aria-live="polite">
      {visible.length ? visible.map(entry => {
        const due = entry.kind === 'mint' ? mintDueState(entry.maturityTs, now) : { tone: dateDueTone(entry.maturityTs, now), label: dateDueTone(entry.maturityTs, now) === 'upcoming' ? 'Upcoming' : 'Matured' }
        return <div key={entry.id} className={`calendar-agenda-row position-${due.tone}`}><strong>{entry.label}</strong><time>{new Date(entry.maturityTs * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC</time><span>{maturityState(entry.maturityTs, now)}</span><span className={`maturity-badge ${due.tone}`}>{due.label}</span></div>
      }) : <p>No loaded positions mature in {selected ?? month}.{incomplete ? ' Coverage is incomplete.' : ''}</p>}
    </div>
    <p>Dates come from the wallet snapshot at block {position.blockNumber.toString()}. Refresh the lookup to detect claims or new mints. “Past maturity” describes the UTC date. Due / late badges describe the verified mint penalty window and are not a simulated claim amount.</p>
  </section>
}
