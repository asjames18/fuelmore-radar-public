import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Derive private identifiers locally so the public release tooling need not
// contain the owner's address itself.
const ownerSource = await readFile(new URL('../src/lib/owner.ts', import.meta.url), 'utf8')
const privateMarkers = [
  ...ownerSource.matchAll(/0x[0-9a-fA-F]{40}/g),
].map(match => match[0].toLowerCase())
privateMarkers.push('pinned owner wallet', 'risk war', 'direction signals', 'action bias', 'where the numbers come from')

let checked = 0
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await inspect(path)
    else if (/\.(js|html|json|map)$/.test(entry.name)) {
      const text = (await readFile(path, 'utf8')).toLowerCase()
      if (privateMarkers.some(marker => text.includes(marker))) {
        throw new Error(`Personal content found in public artifact: ${path}`)
      }
      checked++
    }
  }
}
await inspect(fileURLToPath(new URL('../dist-public', import.meta.url)))
if (!checked) throw new Error('No public artifacts found')
console.log(`Public isolation check passed (${checked} artifacts).`)
