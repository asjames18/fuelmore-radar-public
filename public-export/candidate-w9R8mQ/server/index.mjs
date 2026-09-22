import { collectorFailureMessage } from './rpc-config.mjs'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { collectActivity, TOKEN, parseIndex } from './activity.mjs'

const directory = new URL('../.radar-data/', import.meta.url)
const reportCache = new URL('fuel-activity.json', directory)
const indexCache = new URL('fuel-index.json', directory)

const state = { status: 'loading', progress: 'Starting FUEL history scan…', error: null, report: null }
let checkpoint = null

try {
  const report = JSON.parse(await readFile(reportCache, 'utf8'))
  if (
    report.chainId === 4663 &&
    report.token === TOKEN &&
    Array.isArray(report.days) &&
    Number.isFinite(report.throughTimestamp) &&
    Date.now() / 1000 - report.throughTimestamp < 86400
  ) {
    state.report = report
    state.status = 'ready'
    state.progress = null
  }
} catch { /* No valid report cache on first startup. */ }

try {
  checkpoint = parseIndex(JSON.parse(await readFile(indexCache, 'utf8')), { token: TOKEN })
} catch { /* Full scan until a durable index exists. */ }

let busy = false

async function persist(report, index) {
  await mkdir(directory, { recursive: true })
  const reportTemp = fileURLToPath(reportCache) + '.tmp'
  const indexTemp = fileURLToPath(indexCache) + '.tmp'
  await writeFile(reportTemp, JSON.stringify(report))
  await writeFile(indexTemp, JSON.stringify(index))
  await rename(reportTemp, reportCache)
  await rename(indexTemp, indexCache)
}

async function refresh() {
  if (busy) return
  busy = true
  if (!state.report) state.status = 'loading'
  state.error = null
  try {
    const { report, index } = await collectActivity(progress => { state.progress = progress }, checkpoint, {onCheckpoint: async index => {
      await mkdir(directory, {recursive:true})
      const temporary=fileURLToPath(indexCache)+'.tmp'
      await writeFile(temporary,JSON.stringify(index))
      await rename(temporary,indexCache)
      checkpoint=index
    }})
    state.report = report
    state.status = 'ready'
    state.progress = null
    checkpoint = index
    try {
      await persist(report, index)
    } catch { /* Completed data remains usable if disk persistence is unavailable. */ }
    const mode = report.index?.mode ?? 'full'
    console.log(`FUEL activity ready through block ${report.throughBlock} (${mode}, ${index.records.length} events)`)
  } catch {
    state.status = state.report ? 'ready' : 'error'
    state.error = collectorFailureMessage()
    state.progress = null
    console.error(collectorFailureMessage())
  } finally {
    busy = false
    setTimeout(() => void refresh(), state.status === 'error' ? 30_000 : 10 * 60_000)
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/api/fuel-activity') {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(state))
})

server.listen(4174, '127.0.0.1', () => console.log('FUEL activity API: http://127.0.0.1:4174'))
void refresh()
