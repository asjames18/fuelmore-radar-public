const DAY=86400
// The maturity schedule is the deterministic backbone of the Speculation view:
// past days give context for the timeline, and a full year of future bins lets
// the supply projection chart the entire known unlock schedule. Closed positions
// stay excluded from future bins; historical bins keep their counts.
const PAST_DAYS=6, FUTURE_DAYS=365
export function buildMaturity(records, throughTimestamp) {
  const active=new Map(), lifecycles=[], seen=new Set()
  const ordered=[...records].sort((a,b)=>a.blockNumber-b.blockNumber || a.logIndex-b.logIndex)
  for(const event of ordered) {
    if(seen.has(event.id) || event.timestamp>throughTimestamp) continue
    seen.add(event.id)
    const user=event.user.toLowerCase()
    if(event.kind==='mint') {
      if(!Number.isSafeInteger(event.term) || event.term<=0) throw new Error('Invalid mint term')
      const previous=active.get(user)
      if(previous) previous.closed=true
      const position={user,sender:event.sender,maturityTs:event.timestamp+event.term*DAY,closed:false}
      active.set(user,position)
      lifecycles.push(position)
    } else {
      const previous=active.get(user)
      if(previous) previous.closed=true
      active.delete(user)
    }
  }
  const today=Math.floor(throughTimestamp/DAY)*DAY
  const bins=new Map()
  for(let at=today-PAST_DAYS*DAY;at<=today+FUTURE_DAYS*DAY;at+=DAY) {
    const date=new Date(at*1000).toISOString().slice(0,10)
    bins.set(date,{date,scheduled:0})
  }
  for(const position of lifecycles) {
    if(position.closed && position.maturityTs>throughTimestamp) continue
    const day=bins.get(new Date(position.maturityTs*1000).toISOString().slice(0,10))
    if(day) day.scheduled++
  }
  const activePositions=[...active.values()]
  // Exact earliest maturity across active positions. The countdown targets this
  // timestamp instead of 00:00 UTC on the earliest maturity date, so visitors
  // see the real moment the first rewards unlock. null when no positions active.
  const firstMaturityTs=activePositions.length===0?null:Math.min(...activePositions.map(position=>position.maturityTs))
  return {days:[...bins.values()],active:activePositions,due:activePositions.filter(position=>position.maturityTs<=throughTimestamp).length,firstMaturityTs}
}
