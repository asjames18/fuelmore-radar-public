import { resolveRpcUrl, resolveLogRange, collectorFailureMessage } from './rpc-config.mjs'
import { scanRanges } from './scan-ranges.mjs'
import { buildMaturity } from './maturity.mjs'
import {
  INDEX_SCHEMA_VERSION,
  emptyIndex,
  parseIndex,
  resumeFromCheckpoint,
  applyScanResult,
} from './checkpoint.mjs'
import { createPublicClient, http, parseAbi, decodeEventLog, formatUnits } from 'viem'

export const TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
export { INDEX_SCHEMA_VERSION, parseIndex }

const eventsAbi = parseAbi([
  'event RankClaimed(address indexed user, uint256 term, uint256 rank)',
  'event MintClaimed(address indexed user, uint256 rewardAmount)',
])

export function aggregateActivity(events, fromTimestamp, throughTimestamp) {
  const buckets = new Map()
  for (let at=fromTimestamp; at<=throughTimestamp; at+=86400) {
    const date=new Date(at*1000).toISOString().slice(0,10)
    buckets.set(date,{date,mints:0,claims:0,minters:new Set(),claimers:new Set(),amount:0n})
  }
  const seen=new Set()
  for (const event of events) {
    if(seen.has(event.id) || event.timestamp<fromTimestamp || event.timestamp>throughTimestamp) continue
    seen.add(event.id)
    const day=buckets.get(new Date(event.timestamp*1000).toISOString().slice(0,10))
    if(!day) continue
    if(event.kind==='mint') { day.mints++; day.minters.add(event.sender.toLowerCase()) }
    else { day.claims++; day.claimers.add(event.sender.toLowerCase()); day.amount+=BigInt(event.amount) }
  }
  return [...buckets.values()].map(d=>({date:d.date,mints:d.mints,claims:d.claims,mintWallets:d.minters.size,claimWallets:d.claimers.size,claimedFuel:formatUnits(d.amount,18)}))
}

// Schemas match the public FUEL application's ABI. Raw events are decoded strictly;
// mint starts must not be confused with ERC-20 Transfer mints at reward claim time.
export async function readLogRange(read, from, to) {
  try { return await read(from, to) }
  catch (error) {
    if (from >= to || !/limit|too many|response size/i.test(error.details ?? error.message ?? '')) throw error
    const mid = (from + to) / 2n
    return [...await readLogRange(read, from, mid), ...await readLogRange(read, mid + 1n, to)]
  }
}

const blockCache = new Map()
let cachedGenesisBlock = null

async function locateGenesisBlock(client, throughBlock, genesisTs, onProgress) {
  if (cachedGenesisBlock != null) return cachedGenesisBlock
  onProgress('Locating FUEL genesis for complete maturity coverage…')
  let low = 0n, high = throughBlock
  while (low < high) {
    const mid = (low + high) / 2n
    const block = await client.getBlock({ blockNumber: mid })
    if (Number(block.timestamp) < genesisTs) low = mid + 1n
    else high = mid
  }
  cachedGenesisBlock = low
  return low
}

async function decodeLogs(client, logs, onProgress, signal) {
  const hashes = new Map(logs.map(log => [log.blockNumber.toString(), log.blockHash]))
  const numbers = [...hashes.keys()]
  const blocks = new Map()
  const eventTransactions = new Set(logs.map(log => log.transactionHash))
  let cursor = 0, done = 0, blockFailure = null
  const resolutions = await Promise.allSettled(Array.from({ length: 6 }, async () => {
    while (cursor < numbers.length && !blockFailure) {
      signal.throwIfAborted()
      const number = numbers[cursor++]
      const hash = hashes.get(number)
      const cached = blockCache.get(hash)
      if (cached) {
        blocks.set(number, cached)
        onProgress(`Resolving sending wallets · ${++done}/${numbers.length} blocks`)
        continue
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          signal.throwIfAborted()
          const raw = await client.getBlock({ blockNumber: BigInt(number), includeTransactions: true })
          const txMap = new Map()
          for (const tx of raw.transactions) {
            if (eventTransactions.has(tx.hash)) txMap.set(tx.hash, tx.from)
          }
          const blockSummary = { hash: raw.hash, timestamp: Number(raw.timestamp), senders: txMap }
          blockCache.set(hash, blockSummary)
          blocks.set(number, blockSummary)
          onProgress(`Resolving sending wallets · ${++done}/${numbers.length} blocks`)
          break
        } catch (error) {
          if (signal.aborted) { blockFailure = error; throw error }
          if (attempt === 3) { blockFailure = error; throw error }
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
        }
      }
    }
  }))
  const rejected = resolutions.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
  if (blockFailure) throw blockFailure
  const activeHashes = new Set(hashes.values())
  for (const hash of blockCache.keys()) if (!activeHashes.has(hash)) blockCache.delete(hash)

  const records = []
  const blockHashes = {}
  for (const log of logs) {
    const block = blocks.get(log.blockNumber.toString())
    if (block.hash !== log.blockHash) throw new Error('Chain changed during scan; retrying on the next refresh')
    const sender = block.senders.get(log.transactionHash)
    if (!sender) throw new Error('Transaction sender unavailable; incomplete report withheld')
    const decoded = decodeEventLog({ abi: eventsAbi, data: log.data, topics: log.topics, strict: true })
    blockHashes[log.blockNumber.toString()] = log.blockHash
    records.push({
      id: `${log.blockHash}:${log.logIndex}`,
      timestamp: block.timestamp,
      sender,
      user: decoded.args.user,
      term: Number(decoded.args.term ?? 0n),
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex,
      kind: decoded.eventName === 'RankClaimed' ? 'mint' : 'claim',
      amount: String(decoded.args.rewardAmount ?? 0n),
    })
  }
  return { records, blockHashes }
}

async function verifyMaturity(client, records, throughBlock, throughTimestamp, genesisTs, endHash, onProgress) {
  try {
    const reconstructed = buildMaturity(records, throughTimestamp)
    onProgress('Checking maturity coverage against contract state…')
    const abi = parseAbi([
      'function activeMinters() view returns (uint256)',
      'function userMints(address) view returns (address user,uint256 term,uint256 maturityTs,uint256 rank,uint256 amplifier,uint256 eaaRate)',
    ])
    const activeCount = await client.readContract({ address: TOKEN, abi, functionName: 'activeMinters', blockNumber: throughBlock })
    if (BigInt(reconstructed.active.length) !== activeCount) throw new Error('Event history does not match active mint count')
    const sampleIndexes = [...new Set([0, Math.floor(reconstructed.active.length / 2), reconstructed.active.length - 1])]
      .filter(index => index >= 0 && index < reconstructed.active.length)
    for (const index of sampleIndexes) {
      const position = reconstructed.active[index]
      const raw = await client.readContract({ address: TOKEN, abi, functionName: 'userMints', args: [position.user], blockNumber: throughBlock })
      if (Number(raw[2]) !== position.maturityTs) throw new Error('Derived maturity does not match contract timestamp')
    }
    const finalBlock = await client.getBlock({ blockNumber: throughBlock })
    if (finalBlock.hash !== endHash) throw new Error('Chain changed during maturity checks; report withheld')
    return {
      status: 'ready',
      days: reconstructed.days,
      activeCount: reconstructed.active.length,
      due: reconstructed.due,
      firstMaturityTs: reconstructed.firstMaturityTs,
      samplesChecked: sampleIndexes.length,
      historyFrom: genesisTs,
    }
  } catch {
    return { status: 'unavailable', error: collectorFailureMessage() }
  }
}

/**
 * Collect FUEL activity. When previousIndex is a valid checkpoint, only new blocks
 * are scanned (unless a reorg forces a partial rewind or full rebuild).
 * Returns { report, index }.
 */
export async function collectActivity(onProgress = () => {}, previousIndex = null, {onCheckpoint = async () => {}, maxRunMs = 50 * 60_000} = {}) {
  const deadline = Date.now() + maxRunMs
  const signal = AbortSignal.timeout(maxRunMs)
  const range = resolveLogRange(process.env)
  const client = createPublicClient({
    transport: http(resolveRpcUrl(process.env), { timeout: 20_000, retryCount: 3, retryDelay: 1000,
      fetchFn:(input,init)=>{
        signal.throwIfAborted()
        return fetch(input,{...init,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])})
      } }),
  })
  if (await client.getChainId() !== 4663) throw new Error('Unexpected RPC network')

  const head = await client.getBlockNumber()
  const throughBlock = head - 64n
  const end = await client.getBlock({ blockNumber: throughBlock })
  const throughTimestamp = Number(end.timestamp)
  const fromTimestamp = Math.floor(throughTimestamp / 86400) * 86400 - 6 * 86400
  const genesisTs = Number(await client.readContract({
    address: TOKEN,
    abi: parseAbi(['function genesisTs() view returns (uint256)']),
    functionName: 'genesisTs',
  }))

  const verifyBlockHash = async (blockNumber) => {
    const block = await client.getBlock({ blockNumber })
    return block.hash
  }

  let index = parseIndex(previousIndex, { token: TOKEN })
  if (!index || index.genesisTs !== genesisTs) {
    const genesisBlock = await locateGenesisBlock(client, throughBlock, genesisTs, onProgress)
    index = emptyIndex({ token: TOKEN, genesisTs, fromBlock: genesisBlock })
  } else {
    cachedGenesisBlock = BigInt(index.fromBlock)
  }

  const resumed = await resumeFromCheckpoint(index, {
    throughBlock,
    throughHash: end.hash,
    verifyBlockHash,
  })
  index = resumed.index
  const scanFrom = resumed.fromBlock

  if (resumed.mode === 'current') {
    onProgress('Checkpoint current · rebuilding daily window…')
  } else {
    const label = resumed.mode === 'incremental' ? 'Incremental FUEL update' : 'Reading FUEL events'
    const span = Number(throughBlock - scanFrom + 1n)
    await scanRanges({from:scanFrom, to:throughBlock, range, deadline,
      // Bound decoding/memory even when the provider accepts large ranges.
      groupSize:range>500n?1:100,
      read:(from,to)=>readLogRange(
        (start,finish)=>client.getLogs({address:TOKEN,events:eventsAbi,fromBlock:start,toBlock:finish,strict:true}),from,to),
      commit:async ({to,logs})=>{
        const decoded=await decodeLogs(client,logs.filter(log=>!log.removed),onProgress,signal)
        const boundary=await client.getBlock({blockNumber:to})
        const check=await client.getBlock({blockNumber:throughBlock})
        if (check.hash!==end.hash || await client.getChainId()!==4663) throw new Error('Chain changed during scan; checkpoint withheld')
        index=applyScanResult(index,{records:decoded.records,blockHashes:decoded.blockHashes,throughBlock:to,throughHash:boundary.hash,throughTimestamp:Number(boundary.timestamp)})
        signal.throwIfAborted()
        await onCheckpoint(index)
        const pct=Math.round(Number(to-scanFrom+1n)/Math.max(1,span)*100)
        onProgress(`${label} · ${pct}% · checkpoint ${to}`)
      },
    })
  }

  const check = await client.getBlock({ blockNumber: throughBlock })
  if (check.hash !== end.hash || await client.getChainId()!==4663) throw new Error('Chain changed during scan; report withheld')
  index = applyScanResult(index, {records:[],blockHashes:{},throughBlock,throughHash:end.hash,throughTimestamp})

  const maturity = await verifyMaturity(
    client,
    index.records,
    throughBlock,
    throughTimestamp,
    genesisTs,
    end.hash,
    onProgress,
  )

  signal.throwIfAborted()
  const report = {
    schemaVersion: 2,
    maturity,
    chainId: 4663,
    token: TOKEN,
    days: aggregateActivity(index.records, fromTimestamp, throughTimestamp),
    fromTimestamp,
    throughTimestamp,
    fromBlock: index.fromBlock,
    throughBlock: String(throughBlock),
    throughHash: end.hash,
    generatedAt: new Date().toISOString(),
    index: {
      mode: resumed.mode,
      recordCount: index.records.length,
      schemaVersion: INDEX_SCHEMA_VERSION,
      resumedFromBlock: scanFrom <= throughBlock ? String(scanFrom) : null,
    },
  }

  return { report, index }
}
