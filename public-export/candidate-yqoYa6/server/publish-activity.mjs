#!/usr/bin/env node
/**
 * One-shot FUEL activity publish for production.
 * Loads .radar-data/fuel-index.json when present, runs collectActivity,
 * writes report+index under .radar-data/, and copies the report to
 * public/fuel-activity.json for Cloudflare Workers Assets.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { collectorFailureMessage, collectorDiagnostic } from './rpc-config.mjs'
import { collectActivity, parseIndex, TOKEN } from './activity.mjs'

const root = new URL('../', import.meta.url)
const dataDir = new URL('.radar-data/', root)
const reportPath = new URL('fuel-activity.json', dataDir)
const indexPath = new URL('fuel-index.json', dataDir)
const publicPath = new URL('public/fuel-activity.json', root)

async function main() {
let checkpoint = null
try {
  checkpoint = parseIndex(JSON.parse(await readFile(indexPath, 'utf8')), { token: TOKEN })
  console.log(`Loaded checkpoint through block ${checkpoint.throughBlock} (${checkpoint.records.length} events)`)
} catch {
  console.log('No usable checkpoint — full history scan')
}

await mkdir(dataDir, { recursive: true })
const saveCheckpoint = async index => {
  const temporary = fileURLToPath(indexPath) + '.tmp'
  await writeFile(temporary, JSON.stringify(index))
  await rename(temporary, fileURLToPath(indexPath))
}

const { report, index } = await collectActivity(message => {
  console.log(message)
}, checkpoint, { onCheckpoint: saveCheckpoint })

await mkdir(dataDir, { recursive: true })
const reportTemp = fileURLToPath(reportPath) + '.tmp'
const indexTemp = fileURLToPath(indexPath) + '.tmp'
await writeFile(reportTemp, JSON.stringify(report))
await writeFile(indexTemp, JSON.stringify(index))
await rename(reportTemp, fileURLToPath(reportPath))
await rename(indexTemp, fileURLToPath(indexPath))
await copyFile(reportPath, publicPath)

console.log(
  `Published activity through block ${report.throughBlock} · ${report.generatedAt} · mode=${report.index?.mode ?? 'full'}`,
)

}
main().catch(error => { console.error(collectorFailureMessage()); console.error(JSON.stringify(collectorDiagnostic(error))); process.exitCode = 1 })
