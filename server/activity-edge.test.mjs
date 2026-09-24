import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { activityEnvelope, isUsableReport, loadReport, TOKEN, STALE_AFTER_SECONDS } from './activity-edge.mjs'
import { WATCHDOG } from './watchdog.mjs'

function report(block = '100', age = 60) {
  const throughTimestamp = Math.floor(Date.now() / 1000) - age
  const fromTimestamp = Math.floor(throughTimestamp / 86400) * 86400 - 6 * 86400
  return { schemaVersion: 2, chainId: 4663, token: TOKEN, fromBlock: '1', throughBlock: block, fromTimestamp, throughTimestamp,
    generatedAt: new Date().toISOString(), index: { mode: 'incremental', schemaVersion: 1 },
    days: Array.from({ length: 7 }, (_, i) => ({ date: new Date((fromTimestamp + i * 86400) * 1000).toISOString().slice(0,10), mints: 1, claims: 0, mintWallets: 1, claimWallets: 0, claimedFuel: '0' })),
    maturity: { status: 'unavailable', error: 'Not tested' } }
}
function env(kv, asset) {
  const writes = []
  return { writes, ACTIVITY: { get: async () => kv, put: async (...args) => writes.push(args) }, ASSETS: { fetch: async () => Response.json(asset) } }
}
describe('activity publisher report selection', () => {
  it('prefers the newer published asset to stale KV', async () => {
    const result = await loadReport(env(report('100', 5000), report('200')))
    assert.equal(result.source, 'assets'); assert.equal(result.report.throughBlock, '200')
  })
  it('prefers a newer valid publisher snapshot in D1', async () => {
    assert.equal((await loadReport(env(report('300'), report('200', 300)))).source, 'd1')
  })
  it('serves newer D1 corrections at the same block instead of the asset seed',async()=>{
    const asset=report('200');asset.generatedAt=new Date(Date.now()-60000).toISOString()
    const kv=report('200');kv.days[0].mints=2
    const result=await loadReport(env(kv,asset))
    assert.equal(result.source,'d1')
    assert.equal(result.report.days[0].mints,2)
  })
  it('rejects proxy-counting edge reports even when newer', async () => {
    const bad = report('400'); bad.index.mode = 'edge-incremental'
    assert.equal(isUsableReport(bad), false)
    assert.equal((await loadReport(env(bad, report('200')))).source, 'assets')
  })
  it('falls back when KV read fails', async () => {
    const bindings = env(null, report()); bindings.ACTIVITY.get = async () => { throw Error('KV unavailable') }
    assert.equal((await loadReport(bindings)).source, 'assets')
  })
  it('rejects future, malformed, duplicate-day and invalid count reports', () => {
    for (const patch of [{ throughTimestamp: Date.now()/1000 + 3600 }, { chainId: 1 }, { token: '0x1' }, { throughBlock: 'oops' }, { days: [] }]) {
      assert.equal(isUsableReport({ ...report(), ...patch }), false)
    }
    const bad = report(); bad.days[0].mintWallets = 2
    assert.equal(isUsableReport(bad), false)
    const duplicate = report(); duplicate.days[1].date = duplicate.days[0].date
    assert.equal(isUsableReport(duplicate), false)
  })
  it('accepts valid sender-counted data without changing its contents', async () => {
    const asset = report(); const result = await loadReport(env(null, asset))
    assert.deepEqual(result.report, asset)
    assert.equal(activityEnvelope(asset).status, 'ready')
  })
  it('marks old reports stale and missing or corrupt reports unavailable', () => {
    assert.equal(activityEnvelope(report('100', STALE_AFTER_SECONDS + 10)).status, 'stale')
    assert.equal(activityEnvelope(null).status, 'error')
    assert.equal(activityEnvelope({ throughTimestamp: Date.now()/1000 }).report, null)
  })
  it('matches the watchdog force-dispatch cadence so "stale" means overdue, not between runs', () => {
    // The publisher's observed cadence is ~3h and the watchdog forces a run at
    // 240 minutes; a shorter threshold labeled healthy operation "stale" all
    // day and the homepage warning never meant anything.
    assert.equal(STALE_AFTER_SECONDS, WATCHDOG.staleMinutes * 60)
    assert.equal(activityEnvelope(report('100', STALE_AFTER_SECONDS - 10)).status, 'ready')
  })
})
