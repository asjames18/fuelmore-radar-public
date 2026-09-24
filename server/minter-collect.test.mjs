// Tests for the FUEL minter analytics collector (server/minter-collect.mjs).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  toMinHex,
  decodeInt256,
  decodeSwap,
  swapSide,
  execPriceWethPerFuel,
  decodeTransfer,
  decodeMinterEvent,
  etDate,
  scanRange,
  discoverTransferTopics,
  runMinterCollector,
  MAX_RUN_BLOCKS,
  FUEL_FIRST_BLOCK,
  aggregateRange,
  collectRange,
  serializeState,
  dayToStored,
  fetchWethUsd,
  minterKey,
  dayKey,
  contentSignature,
  selectChangedEntries,
  createChainReader,
  FUEL_TOKEN,
  FUEL_WETH_POOL,
  BATCH_MINTER,
  POOL_SWAP_TOPIC,
  MINTER_EVENT_TOPIC,
  STANDARD_TRANSFER_TOPIC,
  ZERO_ADDRESS,
} from './minter-collect.mjs'

const E18 = 10n ** 18n
const pad = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
const w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')
const negW = (n) => '0x' + ((2n ** 256n) - BigInt(n)).toString(16).padStart(64, '0')

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const MINT_A = '0xcccccccccccccccccccccccccccccccccccccccc'
const MINT_B = '0xdddddddddddddddddddddddddddddddddddddddd'
const ROUTER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const POOL = '0xffffffffffffffffffffffffffffffffffffffff'

function swapLog({ sender, recipient, amount1, block, logIndex = 0, tx = '0xtx1', sqrt = (2n ** 96n) * 18n }) {
  // sqrtPriceX96 = 2^96 * 18 -> price ~ (1/18)^2 WETH/FUEL
  return {
    blockNumber: toMinHex(block),
    logIndex,
    transactionHash: tx,
    topics: [POOL_SWAP_TOPIC, pad(sender), pad(recipient)],
    data: w(0).slice(2) + (amount1 < 0n ? negW(-amount1).slice(2) : w(amount1).slice(2)) + w(sqrt).slice(2),
  }
}

function transferLog({ from, to, amount, block, logIndex = 0, tx = '0xtx1', topic = STANDARD_TRANSFER_TOPIC }) {
  return {
    blockNumber: toMinHex(block),
    logIndex,
    transactionHash: tx,
    topics: [topic, pad(from), pad(to)],
    data: w(amount).slice(2),
  }
}

function minterLog({ wallet, start = 0n, size = 50n, block, logIndex = 0, tx = '0xtx1' }) {
  return {
    blockNumber: toMinHex(block),
    logIndex,
    transactionHash: tx,
    topics: [MINTER_EVENT_TOPIC, pad(wallet)],
    data: w(start).slice(2) + w(size).slice(2),
  }
}

function stubChain({ tokenLogs = [], poolLogs = [], minterLogs = [], txs = {}, kinds = {}, wethUsd = null, head = 1000n }) {
  const byAddr = new Map()
  const push = (logs, addr) => byAddr.set(addr.toLowerCase(), [...(byAddr.get(addr.toLowerCase()) ?? []), ...logs])
  push(tokenLogs, FUEL_TOKEN)
  push(poolLogs, FUEL_WETH_POOL)
  push(minterLogs, BATCH_MINTER)
  return {
    async headBlock() {
      return head
    },
    async logs({ address, fromBlock, toBlock }) {
      void fromBlock
      void toBlock
      return byAddr.get(String(address).toLowerCase()) ?? []
    },
    async logsBatched({ address, fromBlock, toBlock, rangeBlocks = 10n, batchCalls = 40, pacingMs = 0 }) {
      void fromBlock
      void toBlock
      void rangeBlocks
      void batchCalls
      void pacingMs
      return byAddr.get(String(address).toLowerCase()) ?? []
    },
    async blockTimestamps(blockNumbers) {
      const map = new Map()
      for (const b of blockNumbers) map.set(String(b), 1_700_000_000 + Number(BigInt(b) % 1000n))
      return map
    },
    async transactions(hashes) {
      const map = new Map()
      for (const h of hashes) {
        const t = txs[h]
        if (!t) throw new Error('tx missing ' + h)
        map.set(h, t)
      }
      return map
    },
    async codeKind(addresses) {
      const map = new Map()
      for (const a of addresses) map.set(a.toLowerCase(), kinds[a.toLowerCase()] ?? 'eoa')
      return map
    },
    async wethUsd() {
      return wethUsd
    },
  }
}

describe('pure decoders', () => {
  it('toMinHex never emits leading-zero padding', () => {
    assert.equal(toMinHex(0x4202135), '0x4202135')
    assert.equal(toMinHex(0n), '0x0')
    assert.equal(toMinHex(255n), '0xff')
  })

  it('decodeInt256 handles negatives', () => {
    assert.equal(decodeInt256(w(5)), 5n)
    assert.equal(decodeInt256(negW(5)), -5n)
  })

  it('decodeSwap reads the V3 layout and sell/buy side', () => {
    const sell = swapLog({ sender: ALICE, recipient: POOL, amount1: 1000n * E18, block: 100n })
    const d = decodeSwap(sell)
    assert.equal(d.sender, ALICE)
    assert.equal(d.recipient, POOL)
    assert.equal(d.amount1, 1000n * E18)
    assert.equal(swapSide(d.amount1), 'sell')
    const buy = swapLog({ sender: ALICE, recipient: POOL, amount1: -(1000n * E18), block: 100n })
    assert.equal(swapSide(decodeSwap(buy).amount1), 'buy')
    assert.equal(swapSide(0n), null)
    assert.equal(decodeSwap({ topics: [] }), null)
  })

  it('execPriceWethPerFuel is sane for the observed range', () => {
    const px = execPriceWethPerFuel((2n ** 96n) * 18n)
    assert.ok(px > 0.002 && px < 0.004, `price ${px}`)
  })

  it('decodeTransfer reads from/to/amount', () => {
    const t = decodeTransfer(transferLog({ from: ZERO_ADDRESS, to: MINT_A, amount: 42n * E18, block: 1n }))
    assert.equal(t.from, ZERO_ADDRESS)
    assert.equal(t.to, MINT_A)
    assert.equal(t.amountWei, 42n * E18)
    assert.equal(decodeTransfer({ topics: ['0x0'] }), null)
  })

  it('decodeMinterEvent reads wallet, batch start and size', () => {
    const e = decodeMinterEvent(minterLog({ wallet: ALICE, start: 50n, size: 50n, block: 1n }))
    assert.equal(e.wallet, ALICE)
    assert.equal(e.batchStart, 50n)
    assert.equal(e.batchSize, 50n)
    assert.equal(e.batchTotal, 100n)
  })

  it('etDate buckets by America/New_York', () => {
    // 2026-09-22 03:00 UTC = 2026-09-21 23:00 EDT
    const ts = Date.UTC(2026, 8, 22, 3, 0, 0) / 1000
    assert.equal(etDate(ts), '2026-09-21')
    const ts2 = Date.UTC(2026, 8, 22, 5, 0, 0) / 1000
    assert.equal(etDate(ts2), '2026-09-22')
  })
})

describe('scanRange', () => {
  it('resolves router-mediated swaps to tx.from and touches the right keyspace', async () => {
    const chain = stubChain({
      poolLogs: [swapLog({ sender: ROUTER, recipient: POOL, amount1: 10n * E18, block: 100n, tx: '0xswap1' })],
      txs: { '0xswap1': { from: ALICE, valueWei: 0n } },
      kinds: { [ROUTER]: 'contract', [ALICE]: 'eoa' },
    })
    const s = await scanRange(chain, 90n, 110n, { transferTopics: [STANDARD_TRANSFER_TOPIC], lookback: false })
    assert.equal(s.swaps.length, 1)
    assert.equal(s.swaps[0].wallet, ALICE)
    assert.equal(s.swaps[0].swap.side, 'sell')
    assert.ok(s.touched.wallets.has(ALICE))
    assert.equal(s.touched.dates.size, 1)
  })

  it('empty range returns empty scan', async () => {
    const chain = stubChain({})
    const s = await scanRange(chain, 200n, 100n)
    assert.equal(s.swaps.length, 0)
    assert.equal(s.transfers.length, 0)
  })
})

describe('scanRange batched transport', () => {
  it('scans via logsBatched with 10-block ranges (provider getLogs range cap)', async () => {
    const calls = []
    const chain = stubChain({})
    chain.logsBatched = async (args) => {
      calls.push(args)
      return []
    }
    chain.logs = async () => {
      throw new Error('scanRange must not use the chunked chain.logs transport')
    }
    await scanRange(chain, 90n, 110n, { transferTopics: [STANDARD_TRANSFER_TOPIC] })
    // Three scans: FUEL transfers, pool swaps, minter events.
    assert.equal(calls.length, 3)
    const addrs = calls.map((c) => String(c.address).toLowerCase()).sort()
    assert.deepEqual(
      addrs,
      [BATCH_MINTER.toLowerCase(), FUEL_TOKEN.toLowerCase(), FUEL_WETH_POOL.toLowerCase()].sort(),
    )
    for (const c of calls) {
      assert.equal(c.rangeBlocks, 10n)
      assert.equal(c.batchCalls, 100)
      assert.equal(c.pacingMs, 2500)
      assert.equal(c.batchConcurrency, 1)
      assert.equal(BigInt(c.toBlock) - BigInt(c.fromBlock), 20n)
    }
  })

  it('discovers transfer topics via the batched transport', async () => {
    let batched = 0
    const chain = stubChain({})
    const orig = chain.logsBatched.bind(chain)
    chain.logsBatched = async (args) => {
      batched++
      return orig(args)
    }
    chain.logs = async () => {
      throw new Error('discoverTransferTopics must not use the chunked chain.logs transport')
    }
    const topics = await discoverTransferTopics(chain, 90n, 110n)
    assert.equal(batched, 1)
    assert.ok(topics.map((t) => t.toLowerCase()).includes(STANDARD_TRANSFER_TOPIC.toLowerCase()))
  })
})

describe('runMinterCollector run cap', () => {
  it('caps each run at MAX_RUN_BLOCKS so the scan fits the subrequest budget', async () => {
    const store = new Map()
    const kv = {
      get: async (k, type) => {
        const v = store.get(k)
        return v == null ? null : type === 'json' ? JSON.parse(v) : v
      },
      put: async (k, v) => {
        store.set(k, String(v))
      },
      list: async () => ({ keys: [], list_complete: true }),
    }
    const head = FUEL_FIRST_BLOCK + 50000n
    const chain = stubChain({ head, wethUsd: null })
    const result = await runMinterCollector({ ACTIVITY: kv }, { chain })
    assert.equal(result.ok, true)
    assert.equal(BigInt(result.toBlock) - BigInt(result.fromBlock), MAX_RUN_BLOCKS)
    const meta = JSON.parse(store.get('meta:minter-collector'))
    assert.equal(meta.last_block, (FUEL_FIRST_BLOCK + MAX_RUN_BLOCKS).toString())
    assert.equal(meta.status, 'ok')
  })
})

function baseScanned(overrides = {}) {
  const s = {
    fromBlock: 90n,
    toBlock: 110n,
    transfers: [],
    swaps: [],
    minterEvents: [],
    kindMap: new Map(),
    minterTxMap: new Map(),
    wethUsd: null,
    wethUsd: null,
    touched: { wallets: new Set(), contracts: new Set(), dates: new Set() },
    ...overrides,
  }
  // Mirror scanRange: every 0x0 recipient is a mint candidate.
  s.mintRecipients = new Set(s.transfers.filter((t) => t.from === ZERO_ADDRESS).map((t) => t.to))
  return s
}

describe('aggregateRange mint attribution', () => {
  it('attributes a mint contract sweep to the first EOA forwarder', () => {
    const kindMap = new Map([
      [MINT_A, 'contract'],
      [ALICE, 'eoa'],
    ])
    const scanned = baseScanned({
      kindMap,
      transfers: [
        { from: ZERO_ADDRESS, to: MINT_A, amountWei: 100n * E18, blockNumber: 100n, logIndex: 0, ts: 1000 },
        { from: MINT_A, to: ALICE, amountWei: 100n * E18, blockNumber: 101n, logIndex: 0, ts: 1001 },
      ],
    })
    const { minters, contracts } = aggregateRange(scanned)
    const alice = minters.get(ALICE)
    assert.equal(alice.claimedWei, 100n * E18)
    assert.equal(alice.firstClaimTs, 1000)
    const c = contracts.get(MINT_A)
    assert.equal(c.operator, ALICE)
    assert.equal(c.attributedWei, 100n * E18)
    assert.equal(c.scanBlock, 110n)
  })

  it('direct 0x0 -> EOA mints attribute to the recipient', () => {
    const scanned = baseScanned({
      kindMap: new Map([[ALICE, 'eoa']]),
      transfers: [{ from: ZERO_ADDRESS, to: ALICE, amountWei: 7n * E18, blockNumber: 100n, logIndex: 0, ts: 1000 }],
    })
    const { minters } = aggregateRange(scanned)
    assert.equal(minters.get(ALICE).claimedWei, 7n * E18)
  })

  it('later mints to an attributed contract accrue to the same operator', () => {
    const kindMap = new Map([
      [MINT_A, 'contract'],
      [ALICE, 'eoa'],
    ])
    const prior = {
      minters: new Map(),
      contracts: new Map([
        [
          MINT_A,
          {
            total_wei: (100n * E18).toString(),
            attributed_wei: (100n * E18).toString(),
            operator: ALICE,
            first_mint_ts: 1000,
            last_mint_ts: 1000,
            scan_block: '110',
          },
        ],
      ]),
      days: new Map(),
    }
    const scanned = baseScanned({
      fromBlock: 111n,
      toBlock: 120n,
      kindMap,
      transfers: [{ from: ZERO_ADDRESS, to: MINT_A, amountWei: 50n * E18, blockNumber: 115n, logIndex: 0, ts: 2000 }],
    })
    const { minters, contracts } = aggregateRange(scanned, prior)
    assert.equal(minters.get(ALICE).claimedWei, 50n * E18) // only the NEW delta
    assert.equal(contracts.get(MINT_A).attributedWei, 150n * E18)
  })

  it('replays below scan_block are skipped (idempotent retry)', () => {
    const kindMap = new Map([
      [MINT_A, 'contract'],
      [ALICE, 'eoa'],
    ])
    const mk = () =>
      baseScanned({
        kindMap,
        transfers: [
          { from: ZERO_ADDRESS, to: MINT_A, amountWei: 100n * E18, blockNumber: 100n, logIndex: 0, ts: 1000 },
          { from: MINT_A, to: ALICE, amountWei: 100n * E18, blockNumber: 101n, logIndex: 0, ts: 1001 },
        ],
      })
    const first = aggregateRange(mk())
    const prior = {
      minters: new Map([[ALICE, serializeState(first.minters, first.contracts, first.days, 110n).minterEntries[0][1]]]),
      contracts: new Map([[MINT_A, serializeState(first.minters, first.contracts, first.days, 110n).contractEntries[0][1]]]),
      days: new Map(),
    }
    const second = aggregateRange(mk(), prior)
    assert.equal(second.minters.get(ALICE).claimedWei, 100n * E18) // not 200
  })

  it('attributes a sweep whose mint landed in an earlier range (prior contract row)', () => {
    const kindMap = new Map([
      [MINT_A, 'contract'],
      [BOB, 'eoa'],
    ])
    const scanned = baseScanned({
      kindMap,
      // No 0x0 receipt in this range: the mint happened earlier.
      transfers: [{ from: MINT_A, to: BOB, amountWei: 100n * E18, blockNumber: 100n, logIndex: 0, ts: 2000 }],
    })
    const prior = {
      minters: new Map(),
      contracts: new Map([
        [
          MINT_A,
          {
            total_wei: (100n * E18).toString(),
            attributed_wei: '0',
            operator: null,
            first_mint_ts: 1000,
            last_mint_ts: 1000,
            scan_block: '90',
          },
        ],
      ]),
      days: new Map(),
    }
    const { minters, contracts } = aggregateRange(scanned, prior)
    assert.equal(contracts.get(MINT_A).operator, BOB)
    assert.equal(minters.get(BOB).claimedWei, 100n * E18)
  })
})

describe('aggregateRange swaps', () => {
  function swapScanned() {
    return baseScanned({
      kindMap: new Map([
        [MINT_A, 'contract'],
        [ALICE, 'eoa'],
      ]),
      transfers: [
        { from: ZERO_ADDRESS, to: MINT_A, amountWei: 100n * E18, blockNumber: 95n, logIndex: 0, ts: 900 },
        { from: MINT_A, to: ALICE, amountWei: 100n * E18, blockNumber: 96n, logIndex: 0, ts: 901 },
      ],
      swaps: [
        { swap: { side: 'sell', fuelWei: 60n * E18, sqrtPriceX96: (2n ** 96n) * 18n, blockNumber: 100n, ts: 1000 }, wallet: ALICE },
        { swap: { side: 'buy', fuelWei: 10n * E18, sqrtPriceX96: (2n ** 96n) * 18n, blockNumber: 101n, ts: 1001 }, wallet: BOB },
      ],
    })
  }

  it('tallies sold/bought and pct_sold; day buckets are ET-keyed', () => {
    const { minters, days } = aggregateRange(swapScanned())
    const alice = minters.get(ALICE)
    assert.equal(alice.claimedWei, 100n * E18)
    assert.equal(alice.soldWei, 60n * E18)
    assert.equal(alice.firstSaleTs, 1000)
    assert.equal(minters.get(BOB).boughtWei, 10n * E18)
    // BOB never claimed: serializeState must drop him (rule 4).
    const { minterEntries } = serializeState(minters, new Map(), days, 110n)
    const keys = minterEntries.map(([k]) => k)
    assert.ok(!keys.includes(minterKey(BOB)))
    assert.equal(days.size, 1)
    const rec = [...days.values()][0]
    assert.equal(rec.nSells, 1)
    assert.equal(rec.nBuys, 1)
  })

  it('ignores sells that happened before the first claim (rule 4)', () => {
    const scanned = baseScanned({
      kindMap: new Map([
        [MINT_A, 'contract'],
        [ALICE, 'eoa'],
      ]),
      transfers: [
        { from: ZERO_ADDRESS, to: MINT_A, amountWei: 100n * E18, blockNumber: 95n, logIndex: 0, ts: 900 },
        { from: MINT_A, to: ALICE, amountWei: 100n * E18, blockNumber: 96n, logIndex: 0, ts: 901 },
      ],
      swaps: [
        // Dust sell BEFORE the claim: must not count toward sold/first_sale.
        { swap: { side: 'sell', fuelWei: 1n * E18, sqrtPriceX96: (2n ** 96n) * 18n, blockNumber: 97n, ts: 800 }, wallet: ALICE },
        // Real sell AFTER the claim: counts.
        { swap: { side: 'sell', fuelWei: 60n * E18, sqrtPriceX96: (2n ** 96n) * 18n, blockNumber: 100n, ts: 1000 }, wallet: ALICE },
      ],
    })
    const { minters, days } = aggregateRange(scanned)
    const alice = minters.get(ALICE)
    assert.equal(alice.soldWei, 60n * E18)
    assert.equal(alice.firstSaleTs, 1000)
    // Daily buckets still record both swaps (independent of the minter filter).
    const rec = [...days.values()][0]
    assert.equal(rec.nSells, 2)
  })

  it('usd is null when calibration is unavailable', () => {
    const { days } = aggregateRange(swapScanned())
    const rec = [...days.values()][0]
    assert.equal(rec.usdMissing, 2)
    assert.equal(rec.sellVolUsd, 0)
    const stored = serializeState(new Map(), new Map(), days, 110n).dayEntries[0][1]
    assert.equal(stored.sellers[0].usd, null)
  })

  it('usd is computed when wethUsd is known', () => {
    const scanned = swapScanned()
    scanned.wethUsd = 4000
    const { days } = aggregateRange(scanned)
    const rec = [...days.values()][0]
    assert.ok(rec.sellVolUsd > 0)
    assert.equal(rec.usdMissing, 0)
  })
})

describe('aggregateRange re-mint', () => {
  function withSale(overrides = {}) {
    return baseScanned({
      kindMap: new Map(),
      swaps: [{ swap: { side: 'sell', fuelWei: 5n * E18, sqrtPriceX96: (2n ** 96n) * 18n, blockNumber: 100n, ts: 1000 }, wallet: ALICE }],
      minterEvents: [{ wallet: ALICE, batchTotal: 3n, blockNumber: 101n, logIndex: 0, transactionHash: '0xm1', ts: 1100 }],
      minterTxMap: new Map([['0xm1', { from: ALICE, valueWei: 2n * 10n ** 15n }]]),
      transfers: [{ from: ZERO_ADDRESS, to: ALICE, amountWei: 1n * E18, blockNumber: 99n, logIndex: 0, ts: 999 }],
      ...overrides,
    })
  }

  it('counts positions opened after the first sale plus ETH fees', () => {
    const { minters } = aggregateRange(withSale())
    const a = minters.get(ALICE)
    assert.equal(a.mintsOpened, 3n)
    assert.equal(a.remintCount, 3n)
    assert.equal(a.remintEthWei, 2n * 10n ** 15n)
  })

  it('events before the first sale only raise mints_opened', () => {
    const scanned = withSale({
      minterEvents: [{ wallet: ALICE, batchTotal: 2n, blockNumber: 99n, logIndex: 1, transactionHash: '0xm0', ts: 998 }],
      minterTxMap: new Map([['0xm0', { from: ALICE, valueWei: 10n ** 15n }]]),
    })
    const { minters } = aggregateRange(scanned)
    const a = minters.get(ALICE)
    assert.equal(a.mintsOpened, 2n)
    assert.equal(a.remintCount, 0n)
    assert.equal(a.remintEthWei, 0n)
  })

  it('no sale ever -> no re-mint', () => {
    const scanned = withSale({ swaps: [] })
    const { minters } = aggregateRange(scanned)
    assert.equal(minters.get(ALICE).remintCount, 0n)
  })
})

describe('collectRange end-to-end with a stub chain', () => {
  it('attributes a full lifecycle: mint -> sweep -> sell -> remint', async () => {
    const chain = stubChain({
      tokenLogs: [
        transferLog({ from: ZERO_ADDRESS, to: MINT_B, amount: 100n * E18, block: 100n, logIndex: 0, tx: '0xmint' }),
        transferLog({ from: MINT_B, to: ALICE, amount: 100n * E18, block: 101n, logIndex: 0, tx: '0xsweep' }),
      ],
      poolLogs: [swapLog({ sender: ALICE, recipient: POOL, amount1: 40n * E18, block: 102n, tx: '0xsell' })],
      minterLogs: [minterLog({ wallet: ALICE, start: 0n, size: 5n, block: 103n, tx: '0xremint' })],
      txs: { '0xremint': { from: ALICE, valueWei: 10n ** 15n } },
      kinds: { [MINT_B]: 'contract', [ALICE]: 'eoa', [POOL]: 'contract' },
    })
    const state = await collectRange(chain, 90n, 110n, null, {
      transferTopics: [STANDARD_TRANSFER_TOPIC],
      lookback: false,
    })
    const { minterEntries } = serializeState(state.minters, state.contracts, state.days, 110n)
    const aliceEntry = minterEntries.find(([k]) => k === minterKey(ALICE))
    assert.ok(aliceEntry, 'alice row present')
    const row = aliceEntry[1]
    assert.equal(row.claimed, (100n * E18).toString())
    assert.equal(row.sold, (40n * E18).toString())
    assert.equal(row.pct_sold, 40)
    assert.equal(row.mints_opened, '5')
    assert.equal(row.remint_count, '5')
    assert.equal(row.remint_eth_wei, (10n ** 15n).toString())
    assert.equal(row.first_sale_ts != null, true)
    // Day key exists and is ET-formatted.
    const dayEntries = serializeState(state.minters, state.contracts, state.days, 110n).dayEntries
    assert.equal(dayEntries.length, 1)
    assert.match(dayEntries[0][0], /^flows:daily:\d{4}-\d{2}-\d{2}$/)
    assert.equal(dayEntries[0][1].sellers[0].w, ALICE)
    assert.equal(state.stats.swaps, 1)
    assert.equal(state.stats.minterEvents, 1)
  })
})

describe('fetchWethUsd', () => {
  const payload = {
    pairs: [
      // Wrong chain: ignored.
      { chainId: 'ethereum', dexId: 'uniswap', baseToken: { symbol: 'WETH' }, quoteToken: { symbol: 'USDC' }, priceUsd: '3000', liquidity: { usd: 1e9 } },
      // Inverted (USDG base): ignored — priceUsd would be ~$1, not WETH/USD.
      { chainId: 'robinhood', dexId: 'x', baseToken: { symbol: 'USDG' }, quoteToken: { symbol: 'WETH' }, priceUsd: '0.00036', liquidity: { usd: 5e6 } },
      // Non-USD quote: ignored.
      { chainId: 'robinhood', dexId: 'y', baseToken: { symbol: 'WETH' }, quoteToken: { symbol: 'FUEL' }, priceUsd: '100', liquidity: { usd: 5e6 } },
      // Valid but lower liquidity.
      { chainId: 'robinhood', dexId: 'a', baseToken: { symbol: 'WETH' }, quoteToken: { symbol: 'USDG' }, priceUsd: '2743.10', liquidity: { usd: 100000 } },
      // Valid, highest liquidity -> winner.
      { chainId: 'robinhood', dexId: 'b', baseToken: { symbol: 'WETH' }, quoteToken: { symbol: 'USDG' }, priceUsd: '2744.55', liquidity: { usd: 900000 } },
    ],
  }
  const mockFetch = async () => ({ ok: true, status: 200, json: async () => payload })
  const noSleep = async () => {}

  it('picks the highest-liquidity USD-quoted WETH pair on Robinhood chain', async () => {
    const price = await fetchWethUsd({ fetchImpl: mockFetch, sleep: noSleep })
    assert.equal(price, 2744.55)
  })

  it('throws when no usable pair exists', async () => {
    const empty = async () => ({ ok: true, status: 200, json: async () => ({ pairs: [] }) })
    await assert.rejects(() => fetchWethUsd({ fetchImpl: empty, sleep: noSleep }), /no USD-quoted WETH pair/)
  })
})

describe('USD calibration under volatile prices (regression)', () => {
  // sqrt = 2^96 * k  =>  execution price = 1/k^2 WETH/FUEL.
  // k=1070  -> ~8.734e-7 WETH/FUEL (pre-unlock level, ~$0.0024/FUEL)
  // k=18570 -> ~2.899e-9 WETH/FUEL (post-crash level, ~$8e-6/FUEL)
  const SQRT_HIGH = (2n ** 96n) * 1070n
  const SQRT_LOW = (2n ** 96n) * 18570n
  const EXEC_HIGH = 1 / (1070 * 1070)
  const EXEC_LOW = 1 / (18570 * 18570)
  const WETH_USD = 2744

  it('values a pre-crash window at its own execution prices, not a crashed calibration', () => {
    // Regression: the old fuelUsd/exec derivation mixed the *current* (crashed)
    // FUEL price into every historical window, mis-valuing Sept 18-20 swaps by
    // ~300x. With direct WETH/USD, a pre-crash window keeps pre-crash values.
    const scanned = baseScanned({
      wethUsd: WETH_USD,
      swaps: [
        { swap: { side: 'buy', fuelWei: 45463n * E18, sqrtPriceX96: SQRT_HIGH, blockNumber: 100n, ts: 1000 }, wallet: ALICE },
      ],
    })
    const { days } = aggregateRange(scanned)
    const rec = [...days.values()][0]
    const expected = 45463 * EXEC_HIGH * WETH_USD // ≈ $109, not ≈ $0.36
    assert.equal(rec.usdMissing, 0)
    assert.ok(Math.abs(rec.buyVolUsd - expected) / expected < 0.001, `buyVolUsd=${rec.buyVolUsd} expected≈${expected}`)
  })

  it('keeps per-swap execution prices within one volatile window (300x intraday move)', () => {
    // Sept-21-like day: one early high-price buy and one late low-price buy.
    // Each swap must be valued at its own execution price, not smeared.
    const scanned = baseScanned({
      wethUsd: WETH_USD,
      swaps: [
        { swap: { side: 'buy', fuelWei: 45463n * E18, sqrtPriceX96: SQRT_HIGH, blockNumber: 100n, ts: 1000 }, wallet: ALICE },
        { swap: { side: 'buy', fuelWei: 1000000n * E18, sqrtPriceX96: SQRT_LOW, blockNumber: 101n, ts: 1001 }, wallet: BOB },
      ],
    })
    const { days } = aggregateRange(scanned)
    const rec = [...days.values()][0]
    const alice = rec.buyers.get(ALICE)
    const bob = rec.buyers.get(BOB)
    const perAlice = alice.usd / Number(alice.fuelWei / E18)
    const perBob = bob.usd / Number(bob.fuelWei / E18)
    const spread = perAlice / perBob
    assert.ok(spread > 200 && spread < 400, `per-fuel spread=${spread}, expected ~300x`)
  })

  it('ranks the daily leaderboard by FUEL amount, not USD', () => {
    // ALICE moves more FUEL at a low price (lower USD); BOB moves less FUEL
    // at a high price (higher USD). The board must rank ALICE first.
    const scanned = baseScanned({
      wethUsd: WETH_USD,
      swaps: [
        { swap: { side: 'buy', fuelWei: 1000000n * E18, sqrtPriceX96: SQRT_LOW, blockNumber: 100n, ts: 1000 }, wallet: ALICE },
        { swap: { side: 'buy', fuelWei: 45463n * E18, sqrtPriceX96: SQRT_HIGH, blockNumber: 101n, ts: 1001 }, wallet: BOB },
      ],
    })
    const { days } = aggregateRange(scanned)
    const rec = [...days.values()][0]
    // Sanity: BOB's USD really is higher (this is what the old sort keyed on).
    assert.ok(rec.buyers.get(BOB).usd > rec.buyers.get(ALICE).usd)
    const stored = dayToStored(rec)
    assert.equal(stored.buyers[0].w, ALICE)
    assert.equal(stored.buyers[1].w, BOB)
  })
})

describe('write bounding (KV quota)', () => {
  const rowA = (overrides = {}) => ({
    wallet: '0xalice',
    claimed: '1000',
    sold: '500',
    bought: '0',
    pct_sold: 50,
    mints_opened: '10',
    remint_count: '5',
    remint_eth_wei: '100',
    first_claim_ts: 1000,
    first_sale_ts: 1100,
    last_active_ts: 1200,
    updated_block: '999',
    ...overrides,
  })

  it('contentSignature ignores marker fields but not content', () => {
    const a = rowA()
    const b = rowA({ updated_block: '12345' })
    assert.equal(contentSignature(a), contentSignature(b))
    const c = rowA({ sold: '501' })
    assert.notEqual(contentSignature(a), contentSignature(c))
    // Key order does not matter.
    const d = {}
    for (const k of Object.keys(a).reverse()) d[k] = a[k]
    assert.equal(contentSignature(a), contentSignature(d))
  })

  it('selectChangedEntries skips marker-only differences', () => {
    const prior = new Map([['minter:0xalice', rowA()]])
    const entries = [['minter:0xalice', rowA({ updated_block: '2000' })]]
    assert.deepEqual(selectChangedEntries(entries, prior), [])
  })

  it('selectChangedEntries keeps new keys and content changes', () => {
    const prior = new Map([['minter:0xalice', rowA()]])
    const entries = [
      ['minter:0xalice', rowA({ sold: '600' })], // content changed
      ['minter:0xbob', rowA({ wallet: '0xbob' })], // brand new
    ]
    const changed = selectChangedEntries(entries, prior)
    assert.equal(changed.length, 2)
    assert.equal(changed[0][0], 'minter:0xalice')
    assert.equal(changed[1][0], 'minter:0xbob')
  })

  it('a quiet hour writes nothing: identical rows are all skipped', () => {
    // Simulates the steady state: the same stored rows re-serialized with
    // advanced markers must produce zero writes.
    const stored = rowA()
    const prior = new Map([
      ['minter:0xalice', stored],
      ['mintcontract:0xc1', { total_wei: '5', attributed_wei: '5', operator: '0xalice', first_mint_ts: 1, last_mint_ts: 2, scan_block: '999' }],
      ['flows:daily:2026-09-21', { date: '2026-09-21', buyers: [], sellers: [], buy_vol_usd: 0, sell_vol_usd: 0, usd_missing: 0, n_buys: 0, n_sells: 0, last_block: '999' }],
    ])
    const entries = [
      ['minter:0xalice', { ...stored, updated_block: '2000' }],
      ['mintcontract:0xc1', { total_wei: '5', attributed_wei: '5', operator: '0xalice', first_mint_ts: 1, last_mint_ts: 2, scan_block: '2000' }],
      ['flows:daily:2026-09-21', { date: '2026-09-21', buyers: [], sellers: [], buy_vol_usd: 0, sell_vol_usd: 0, usd_missing: 0, n_buys: 0, n_sells: 0, last_block: '2000' }],
    ]
    assert.deepEqual(selectChangedEntries(entries, prior), [])
  })
})

describe('chain reader RPC error diagnosability', () => {
  it('includes the provider response body in non-OK HTTP errors', async () => {
    const failFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'eth_getLogs block range exceeds the provider limit of 10000',
    })
    const chain = createChainReader({ fetchImpl: failFetch })
    await assert.rejects(() => chain.headBlock(), /RPC HTTP 400: eth_getLogs block range exceeds the provider limit/)
  })

  it('still reports the bare status when the body is unreadable', async () => {
    const failFetch = async () => ({ ok: false, status: 400 })
    const chain = createChainReader({ fetchImpl: failFetch })
    await assert.rejects(() => chain.headBlock(), /RPC HTTP 400$/)
  })

  it('halves-and-retries on the free-tier block-range phrasing', async () => {

    // Observed 2026-09-24: the provider rejects >10-block eth_getLogs with
    // "Under the Free tier plan, you can make eth_getLogs requests with up
    // to a 10 block range..." — the chain reader must treat that as a log
    // limit and halve down to 10-block requests instead of hard-failing.
    const seen = []
    const succeeded = []
    const fetchImpl = async (_url, { body }) => {
      const payload = JSON.parse(body)
      const filter = payload.params[0]
      const from = BigInt(filter.fromBlock)
      const to = BigInt(filter.toBlock)
      seen.push({ from, to })
      if (to - from >= 10n) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":' +
            '"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. ' +
            'Upgrade to PAYG for expanded block range."}}',
        }
      }
      succeeded.push({ from, to })
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) }
    }
    const chain = createChainReader({ fetchImpl })
    const logs = await chain.logs({ address: '0xabc', fromBlock: 0n, toBlock: 99n })
    assert.deepEqual(logs, [])
    assert.ok(seen.length > succeeded.length, 'expected halving retries')
    assert.ok(succeeded.length >= 10, 'expected ~10 successful leaf requests')
    for (const r of succeeded) assert.ok(r.to - r.from < 10n, 'successful request exceeded 10 blocks')
  })

  it('logsBatched packs 10-block ranges into one subrequest per batch', async () => {
    const batches = []
    const fetchImpl = async (_url, { body }) => {
      const payload = JSON.parse(body)
      assert.ok(Array.isArray(payload), 'expected a JSON-RPC batch')
      batches.push(payload)
      assert.ok(payload.length <= 40, 'batch exceeds 40 calls')
      const replies = payload.map((call, i) => {
        const filter = call.params[0]
        const from = BigInt(filter.fromBlock)
        const to = BigInt(filter.toBlock)
        assert.ok(to - from < 10n, 'range exceeds 10 blocks')
        return { jsonrpc: '2.0', id: call.id, result: [{ blockNumber: filter.fromBlock }] }
      })
      return { ok: true, json: async () => replies }
    }
    const chain = createChainReader({ fetchImpl })
    // 100 blocks -> 10 ranges of 10 -> a single batch.
    const logs = await chain.logsBatched({ address: '0xabc', fromBlock: 0n, toBlock: 99n })
    assert.equal(batches.length, 1)
    assert.equal(logs.length, 10)
    // 1000 blocks -> 100 ranges -> 3 batches (40/40/20).
    batches.length = 0
    const logs2 = await chain.logsBatched({ address: '0xabc', fromBlock: 0n, toBlock: 999n })
    assert.equal(batches.length, 3)
    assert.deepEqual(batches.map((b) => b.length), [40, 40, 20])
    assert.equal(logs2.length, 100)
  })

  it('logsBatched paces batch dispatches when pacingMs is set', async () => {
    const timedFetch = async (url, opts) => {
      const payload = JSON.parse(opts.body)
      const replies = payload.map((call) => ({ jsonrpc: '2.0', id: call.id, result: [] }))
      return { ok: true, json: async () => replies }
    }
    const chain = createChainReader({ fetchImpl: timedFetch })
    const t0 = Date.now()
    // 1000 blocks -> 100 ranges -> 3 batches; each of the 3 lanes sleeps
    // pacingMs before its batch, so elapsed must cover at least one sleep.
    const logs = await chain.logsBatched({ address: '0xabc', fromBlock: 0n, toBlock: 999n, pacingMs: 120 })
    const elapsed = Date.now() - t0
    assert.equal(logs.length, 0)
    assert.ok(elapsed >= 100, `expected pacing delay, elapsed ${elapsed}ms`)
    // No pacing by default: same scan completes without the sleep.
    const t1 = Date.now()
    await chain.logsBatched({ address: '0xabc', fromBlock: 0n, toBlock: 999n })
    assert.ok(Date.now() - t1 < 100, 'unpaced scan unexpectedly slow')
  })
})

describe('chain reader RPC failover', () => {
  it('tries each URL in order and uses the first that works', async () => {
    const seen = []
    const fetchImpl = async (url, { body }) => {
      seen.push(url)
      const payload = JSON.parse(body)
      if (url === 'https://primary.test/rpc') {
        return { ok: false, status: 429, text: async () => 'rate limited' }
      }
      assert.equal(url, 'https://fallback.test/rpc')
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: '0x10' }) }
    }
    const chain = createChainReader({
      fetchImpl,
      rpcUrl: 'https://primary.test/rpc',
      rpcUrls: ['https://primary.test/rpc', 'https://fallback.test/rpc'],
    })
    assert.equal(await chain.headBlock(), 16n)
    assert.deepEqual(seen, ['https://primary.test/rpc', 'https://fallback.test/rpc'])
  })

  it('throws when every URL fails', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down' })
    const chain = createChainReader({
      fetchImpl,
      rpcUrls: ['https://a.test/rpc', 'https://b.test/rpc'],
    })
    await assert.rejects(() => chain.headBlock(), /RPC HTTP 503/)
  })

  it('fetches transaction receipts by hash', async () => {
    const receipt = { transactionHash: '0xabc', logs: [{ address: '0x1' }] }
    const fetchImpl = async (_url, { body }) => {
      const items = JSON.parse(body)
      return {
        ok: true,
        json: async () => items.map((item) => ({ jsonrpc: '2.0', id: item.id, result: receipt })),
      }
    }
    const chain = createChainReader({ fetchImpl })
    const map = await chain.receipts(['0xabc', '0xabc'])
    assert.equal(map.size, 1)
    assert.deepEqual(map.get('0xabc'), receipt)
  })
})

describe('chain reader JSON-RPC failover', () => {
  it('fails over when the primary returns a throttling JSON-RPC error', async () => {
    const seen = []
    const fetchImpl = async (url, { body }) => {
      seen.push(url)
      const payload = JSON.parse(body)
      if (url === 'https://primary.test/rpc') {
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: payload.id, error: { code: -32005, message: 'limit exceeded' } }),
        }
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: '0x10' }) }
    }
    const chain = createChainReader({
      fetchImpl,
      rpcUrls: ['https://primary.test/rpc', 'https://fallback.test/rpc'],
    })
    assert.equal(await chain.headBlock(), 16n)
    assert.deepEqual(seen, ['https://primary.test/rpc', 'https://fallback.test/rpc'])
  })

  it('does not fail over on method-level JSON-RPC errors', async () => {
    const seen = []
    const fetchImpl = async (url, { body }) => {
      seen.push(url)
      const payload = JSON.parse(body)
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: payload.id, error: { code: -32602, message: 'invalid params' } }),
      }
    }
    const chain = createChainReader({
      fetchImpl,
      rpcUrls: ['https://primary.test/rpc', 'https://fallback.test/rpc'],
    })
    await assert.rejects(() => chain.headBlock(), /RPC -32602: invalid params/)
    assert.deepEqual(seen, ['https://primary.test/rpc'])
  })

  it('never logs provider keys embedded in the URL path', async () => {
    const errors = []
    const original = console.error
    console.error = (...args) => errors.push(args.join(' '))
    try {
      const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'down' })
      const chain = createChainReader({
        fetchImpl,
        rpcUrls: ['https://provider.test/v2/SECRETKEY123', 'https://fb.test/rpc'],
      })
      await assert.rejects(() => chain.headBlock(), /RPC HTTP 500/)
    } finally {
      console.error = original
    }
    assert.ok(errors.length > 0, 'expected transport failure logs')
    assert.ok(errors.some((line) => line.includes('provider.test')), 'expected the primary host in logs')
    for (const line of errors) {
      assert.ok(!line.includes('SECRETKEY123'), `key leaked into logs: ${line}`)
      assert.ok(!line.includes('/v2/'), `URL path leaked into logs: ${line}`)
    }
  })
})
