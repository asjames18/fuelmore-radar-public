// Probe: read production KV burns state (read-only).
// Usage: cf-env-run.py <repo> -- node scripts/burn-backfill-probe.mjs
// (maps CLOUDFLARE_API_TOKEN -> CF_API_TOKEN here)
const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN
if (!token) { console.error('missing token'); process.exit(2) }
const NS = '4ee21ae0827e47a585602c260af73230'

const accts = await (await fetch('https://api.cloudflare.com/client/v4/accounts', {
  headers: { Authorization: `Bearer ${token}` },
})).json()
const acct = accts.result?.[0]?.id
if (!acct) { console.error('no account'); process.exit(2) }
const base = `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${NS}/values`

for (const key of ['meta:burn-collector', 'burns:daily']) {
  const res = await fetch(`${base}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) { console.log(key, '-> 404 (missing)'); continue }
  const raw = await res.text()
  console.log(key, '-> HTTP', res.status, 'bytes:', raw.length)
  if (key === 'meta:burn-collector') console.log('   ', raw.slice(0, 500))
  else {
    try {
      const j = JSON.parse(raw)
      console.log('    days:', j.days?.length, 'totals:', JSON.stringify(j.totals),
        'watermark_block:', j.watermark_block, 'updated_at:', j.updated_at)
      const withIds = j.days?.filter((d) => Array.isArray(d.dripIds) && d.dripIds.length).length
      console.log('    days carrying dripIds:', withIds)
      console.log('    first day:', JSON.stringify(j.days?.[0]), 'last day:', JSON.stringify(j.days?.at(-1)))
    } catch { console.log('    (not JSON)') }
  }
}

// chain head from the public RPC (sandbox path)
const head = await (await fetch('https://rpc.mainnet.chain.robinhood.com', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
})).json()
const headN = BigInt(head.result)
console.log('chain head:', headN.toString(), 'at', new Date().toISOString())
