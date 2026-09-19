const DAY=86400
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
  for(let at=today-6*DAY;at<=today+30*DAY;at+=DAY) {
    const date=new Date(at*1000).toISOString().slice(0,10)
    bins.set(date,{date,scheduled:0})
  }
  for(const position of lifecycles) {
    if(position.closed && position.maturityTs>throughTimestamp) continue
    const day=bins.get(new Date(position.maturityTs*1000).toISOString().slice(0,10))
    if(day) day.scheduled++
  }
  return {days:[...bins.values()],active:[...active.values()],due:[...active.values()].filter(position=>position.maturityTs<=throughTimestamp).length}
}
