import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  MarketValidationError,
  SOURCE_ORDER,
  collectMarketSnapshot,
  runMarketSnapshot,
  validateDexPair,
} from './market-collect.mjs'
import {
  TOKENS,
  validateDexPaprikaPool,
  validateGeckoPool,
} from './price-sources.mjs'

const FUEL_PAIR = '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69'
const FUEL_TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
const MORE_PAIR = '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef'
const MORE_TOKEN = '0xc0F1A40512114b25cc1F30b5DF0bb48691405555'

const DEXSCREENER_ONLY = { sources: ['dexscreener'] }

function pairEntry(pairAddress, tokenAddress, overrides = {}) {
  return {
    chainId: 'robinhood',
    pairAddress,
    baseToken: { address: tokenAddress },
    priceUsd: '1.23',
    liquidity: { usd: 456789 },
    ...overrides,
  }
}

function geckoPayload(pairAddress, tokenAddress, overrides = {}) {
  return {
    data: {
      id: `robinhood_${pairAddress}`,
      type: 'pool',
      attributes: {
        address: pairAddress,
        base_token_price_usd: '0.005',
        reserve_in_usd: '5938.277',
        ...(overrides.attributes ?? {}),
      },
      relationships: {
        base_token: { data: { id: `robinhood_${tokenAddress}` } },
        dex: { data: { id: 'uniswap-v3' } },
      },
      ...overrides.data,
    },
  }
}

function dexPaprikaPayload(pairAddress, tokenAddress, overrides = {}) {
  return {
    id: pairAddress,
    dex_name: 'Uniswap V3',
    last_price_usd: 0.006,
    liquidity_usd: 3874.34,
    tokens: [{ id: tokenAddress }, { id: '0x0000000000000000000000000000000000000000' }],
    ...overrides,
  }
}

const fuelPayload = () => ({ pairs: [pairEntry(FUEL_PAIR, FUEL_TOKEN)] })
const morePayload = () => ({ pairs: [pairEntry(MORE_PAIR, MORE_TOKEN, { priceUsd: '4.56', liquidity: { usd: 98765 } })] })
const geckoFuel = () => geckoPayload(FUEL_PAIR, FUEL_TOKEN)
const geckoMore = () => geckoPayload(MORE_PAIR, MORE_TOKEN, { attributes: { base_token_price_usd: '0.007', reserve_in_usd: '1234.5' } })
const paprikaFuel = () => dexPaprikaPayload(FUEL_PAIR, FUEL_TOKEN)
const paprikaMore = () => dexPaprikaPayload(MORE_PAIR, MORE_TOKEN, { last_price_usd: 0.008, liquidity_usd: 2222.2 })

const ok = (payload, status = 200, headers = {}) => () =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const boom = (message = 'network down') => () => { throw new Error(message) }

/** Stub fetch keyed by URL substring; each plan entry is consumed once, in order.
 * A key may contain "|" to require every part to match (e.g. "host|address"). */
function stubFetch(plans) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const key = String(url)
    calls.push(key)
    for (const [substr, queue] of Object.entries(plans)) {
      if (substr.split('|').every((part) => key.includes(part))) {
        const next = queue.shift()
        if (!next) throw new Error(`no plan left for ${substr}`)
        return next(url, init)
      }
    }
    throw new Error(`unexpected URL: ${key}`)
  }
  return { fetch: fetchImpl, calls }
}

function captureConsole() {
  const errors = []
  const logs = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args) => errors.push(args.join(' '))
  console.log = (...args) => logs.push(args.join(' '))
  return { errors, logs, restore: () => { console.error = originalError; console.log = originalLog } }
}

function sleepStub() {
  const delays = []
  const sleep = async (ms) => { delays.push(ms) }
  return { delays, sleep }
}

describe('source registry', () => {
  it('orders sources GeckoTerminal → DexPaprika → Dexscreener', () => {
    assert.deepEqual(SOURCE_ORDER, ['geckoterminal', 'dexpaprika', 'dexscreener'])
  })
  it('keeps canonical token/pool identities', () => {
    assert.equal(TOKENS.fuel.pairAddress, FUEL_PAIR)
    assert.equal(TOKENS.fuel.tokenAddress, FUEL_TOKEN)
    assert.equal(TOKENS.more.pairAddress, MORE_PAIR)
    assert.equal(TOKENS.more.tokenAddress, MORE_TOKEN)
  })
})

describe('validateGeckoPool identity checks', () => {
  it('accepts a valid pool and returns numeric fields', () => {
    const result = validateGeckoPool(geckoPayload(FUEL_PAIR, FUEL_TOKEN), 'fuel', FUEL_PAIR, FUEL_TOKEN)
    assert.equal(result.priceUsd, 0.005)
    assert.equal(result.liquidityUsd, 5938.277)
  })
  it('rejects a missing pool resource', () => {
    for (const payload of [{}, { data: null }, { data: {} }]) {
      assert.throws(() => validateGeckoPool(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN), (error) => {
        assert.ok(error instanceof MarketValidationError)
        assert.equal(error.check, 'geckoterminal.pool-returned')
        return true
      })
    }
  })
  it('rejects a wrong pool address (case-insensitive compare)', () => {
    const wrong = '0x0000000000000000000000000000000000000001'
    assert.throws(
      () => validateGeckoPool(geckoPayload(wrong, FUEL_TOKEN), 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'geckoterminal.address')
        assert.equal(error.expected, FUEL_PAIR)
        assert.equal(error.actual, wrong)
        return true
      },
    )
  })
  it('accepts a checksummed-casing variant of the pool address', () => {
    const upper = geckoPayload(FUEL_PAIR.toLowerCase(), FUEL_TOKEN)
    const result = validateGeckoPool(upper, 'fuel', FUEL_PAIR, FUEL_TOKEN)
    assert.equal(result.priceUsd, 0.005)
  })
  it('rejects a wrong base token relationship id', () => {
    const payload = geckoPayload(FUEL_PAIR, FUEL_TOKEN)
    payload.data.relationships.base_token.data.id = `robinhood_0x0000000000000000000000000000000000000002`
    assert.throws(
      () => validateGeckoPool(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'geckoterminal.base_token.id')
        assert.ok(String(error.expected).toLowerCase().includes(FUEL_TOKEN.toLowerCase()))
        return true
      },
    )
  })
  it('rejects a pool from another network relationship id', () => {
    const payload = geckoPayload(FUEL_PAIR, FUEL_TOKEN)
    payload.data.relationships.base_token.data.id = `ethereum_${FUEL_TOKEN}`
    assert.throws(
      () => validateGeckoPool(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => error.check === 'geckoterminal.base_token.id',
    )
  })
})

describe('validateDexPaprikaPool identity checks', () => {
  it('accepts a valid pool and returns numeric fields', () => {
    const result = validateDexPaprikaPool(dexPaprikaPayload(FUEL_PAIR, FUEL_TOKEN), 'fuel', FUEL_PAIR, FUEL_TOKEN)
    assert.equal(result.priceUsd, 0.006)
    assert.equal(result.liquidityUsd, 3874.34)
  })
  it('rejects a missing or non-object body', () => {
    for (const payload of [null, undefined, [], 'nope']) {
      assert.throws(() => validateDexPaprikaPool(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN), (error) => {
        assert.ok(error instanceof MarketValidationError)
        assert.equal(error.check, 'dexpaprika.pool-returned')
        return true
      })
    }
  })
  it('rejects a wrong pool id', () => {
    const wrong = '0x0000000000000000000000000000000000000001'
    assert.throws(
      () => validateDexPaprikaPool(dexPaprikaPayload(wrong, FUEL_TOKEN), 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'dexpaprika.id')
        assert.equal(error.expected, FUEL_PAIR)
        assert.equal(error.actual, wrong)
        return true
      },
    )
  })
  it('rejects a token list missing the expected base token', () => {
    const payload = dexPaprikaPayload(FUEL_PAIR, FUEL_TOKEN, { tokens: [{ id: '0x0000000000000000000000000000000000000002' }] })
    assert.throws(
      () => validateDexPaprikaPool(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'dexpaprika.tokens')
        assert.ok(String(error.expected).includes(FUEL_TOKEN))
        return true
      },
    )
  })
  it('rejects a missing token list', () => {
    const payload = dexPaprikaPayload(FUEL_PAIR, FUEL_TOKEN)
    delete payload.tokens
    assert.throws(
      () => validateDexPaprikaPool(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => error.check === 'dexpaprika.tokens',
    )
  })
})

describe('validateDexPair identity checks', () => {
  it('rejects a missing or empty pairs array with expected-vs-actual detail', () => {
    for (const payload of [{}, { pairs: [] }, { pairs: 'nope' }]) {
      assert.throws(() => validateDexPair(payload, 'fuel', FUEL_PAIR, FUEL_TOKEN), (error) => {
        assert.ok(error instanceof MarketValidationError)
        assert.equal(error.check, 'pairs-returned')
        assert.equal(error.pairKey, 'fuel')
        assert.ok(String(error.expected).includes(FUEL_PAIR))
        return true
      })
    }
  })
  it('rejects a wrong chainId with expected-vs-actual detail', () => {
    assert.throws(
      () => validateDexPair({ pairs: [pairEntry(FUEL_PAIR, FUEL_TOKEN, { chainId: 'ethereum' })] }, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'chainId')
        assert.equal(error.expected, 'robinhood')
        assert.equal(error.actual, 'ethereum')
        return true
      },
    )
  })
  it('rejects a wrong pairAddress with expected-vs-actual detail', () => {
    const wrong = '0x0000000000000000000000000000000000000001'
    assert.throws(
      () => validateDexPair({ pairs: [pairEntry(wrong, FUEL_TOKEN)] }, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'pairAddress')
        assert.equal(error.expected, FUEL_PAIR)
        assert.equal(error.actual, wrong)
        return true
      },
    )
  })
  it('rejects a wrong baseToken.address with expected-vs-actual detail', () => {
    const wrong = '0x0000000000000000000000000000000000000002'
    assert.throws(
      () => validateDexPair({ pairs: [pairEntry(FUEL_PAIR, wrong)] }, 'fuel', FUEL_PAIR, FUEL_TOKEN),
      (error) => {
        assert.equal(error.check, 'baseToken.address')
        assert.equal(error.expected, FUEL_TOKEN)
        assert.equal(error.actual, wrong)
        return true
      },
    )
  })
  it('accepts a valid payload and returns numeric fields', () => {
    const result = validateDexPair(fuelPayload(), 'fuel', FUEL_PAIR, FUEL_TOKEN)
    assert.equal(result.priceUsd, 1.23)
    assert.equal(result.liquidityUsd, 456789)
  })
})

describe('geckoterminal source behavior', () => {
  it('retries a 429 then succeeds with exponential backoff', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [`geckoterminal|${FUEL_PAIR}`]: [ok({}, 429), ok(geckoFuel())],
        [`geckoterminal|${MORE_PAIR}`]: [ok(geckoMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['geckoterminal'] })
      assert.ok(point)
      assert.deepEqual(delays, [1000])
      assert.equal(point.fuelPrice, 0.005)
      assert.equal(point.fuelLiquidity, 5938.277)
      assert.equal(point.morePrice, 0.007)
    } finally {
      console.restore()
    }
  })
  it('logs which source succeeded per pair', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [`geckoterminal|${FUEL_PAIR}`]: [ok(geckoFuel())],
        [`geckoterminal|${MORE_PAIR}`]: [ok(geckoMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['geckoterminal'] })
      assert.ok(point)
      assert.ok(console.logs.some((m) => m.includes('[fuel]') && m.includes('source geckoterminal succeeded')), console.logs.join(' | '))
      assert.ok(console.logs.some((m) => m.includes('[more]') && m.includes('source geckoterminal succeeded')), console.logs.join(' | '))
    } finally {
      console.restore()
    }
  })
  it('sends the versioned Accept header', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    let acceptHeader = null
    try {
      const { fetch } = stubFetch({
        [`geckoterminal|${FUEL_PAIR}`]: [
          (url, init) => { acceptHeader = init?.headers?.Accept; return ok(geckoFuel())() },
        ],
        [`geckoterminal|${MORE_PAIR}`]: [ok(geckoMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['geckoterminal'] })
      assert.ok(point)
      assert.equal(acceptHeader, 'application/json;version=20230302')
    } finally {
      console.restore()
    }
  })
  it('fails the run when the pool payload is malformed (validation failures are not retried as fetches)', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch, calls } = stubFetch({
        [`geckoterminal|${FUEL_PAIR}`]: [ok({})],
        [`geckoterminal|${MORE_PAIR}`]: [ok({})],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['geckoterminal'] }), null)
      assert.equal(calls.filter((u) => u.includes('geckoterminal')).length, 2)
      assert.ok(console.errors.some((m) => m.includes('geckoterminal.pool-returned')), console.errors.join(' | '))
    } finally {
      console.restore()
    }
  })
})

describe('dexpaprika source behavior', () => {
  it('retries a 500 then succeeds', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [`dexpaprika|${FUEL_PAIR}`]: [ok({}, 500), ok(paprikaFuel())],
        [`dexpaprika|${MORE_PAIR}`]: [ok(paprikaMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['dexpaprika'] })
      assert.ok(point)
      assert.deepEqual(delays, [1000])
      assert.equal(point.fuelPrice, 0.006)
      assert.equal(point.moreLiquidity, 2222.2)
    } finally {
      console.restore()
    }
  })
  it('fails the run when the pool id does not match (identity-mismatch)', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [`dexpaprika|${FUEL_PAIR}`]: [ok(dexPaprikaPayload('0x0000000000000000000000000000000000000001', FUEL_TOKEN))],
        [`dexpaprika|${MORE_PAIR}`]: [ok(paprikaMore())],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['dexpaprika'] }), null)
      assert.ok(console.errors.some((m) => m.includes('dexpaprika.id')), console.errors.join(' | '))
    } finally {
      console.restore()
    }
  })
  it('does not retry a 404 and the run fails (no more sources in scope)', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch, calls } = stubFetch({
        [`dexpaprika|${FUEL_PAIR}`]: [ok({}, 404)],
        [`dexpaprika|${MORE_PAIR}`]: [ok({}, 404)],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['dexpaprika'] }), null)
      assert.equal(calls.filter((u) => u.includes('api.dexpaprika.com')).length, 2)
    } finally {
      console.restore()
    }
  })
})

describe('failover ordering', () => {
  it('falls back to DexPaprika when GeckoTerminal 429s exhaust retries', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch, calls } = stubFetch({
        'api.geckoterminal.com': [ok({}, 429), ok({}, 429), ok({}, 429), ok({}, 429), ok({}, 429), ok({}, 429)],
        [`dexpaprika|${FUEL_PAIR}`]: [ok(paprikaFuel())],
        [`dexpaprika|${MORE_PAIR}`]: [ok(paprikaMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
      assert.ok(point)
      assert.equal(point.fuelPrice, 0.006)
      assert.equal(point.moreLiquidity, 2222.2)
      assert.equal(calls.filter((u) => u.includes('api.geckoterminal.com')).length, 6)
      assert.equal(calls.filter((u) => u.includes('api.dexpaprika.com')).length, 2)
      assert.ok(console.logs.some((m) => m.includes('source dexpaprika succeeded')), console.logs.join(' | '))
      assert.ok(!console.logs.some((m) => m.includes('source geckoterminal succeeded')), console.logs.join(' | '))
    } finally {
      console.restore()
    }
  })
  it('falls back to Dexscreener when GeckoTerminal and DexPaprika both fail', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        'api.geckoterminal.com': [ok({}, 429), ok({}, 429), ok({}, 429), ok({}, 429), ok({}, 429), ok({}, 429)],
        'api.dexpaprika.com': [boom(), boom(), boom(), boom(), boom(), boom()],
        [FUEL_PAIR]: [ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
      assert.ok(point)
      assert.equal(point.fuelPrice, 1.23)
      assert.ok(console.logs.some((m) => m.includes('source dexscreener succeeded')), console.logs.join(' | '))
    } finally {
      console.restore()
    }
  })
  it('uses GeckoTerminal values when the primary succeeds (first valid wins)', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch, calls } = stubFetch({
        [`geckoterminal|${FUEL_PAIR}`]: [ok(geckoFuel())],
        [`geckoterminal|${MORE_PAIR}`]: [ok(geckoMore())],
        'api.dexpaprika.com': [ok(paprikaFuel()), ok(paprikaMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
      assert.ok(point)
      assert.equal(point.fuelPrice, 0.005)
      assert.equal(calls.filter((u) => u.includes('api.dexpaprika.com')).length, 0)
    } finally {
      console.restore()
    }
  })
  it('returns null when every source fails for a pair', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        'api.geckoterminal.com': [ok({}, 503), ok({}, 503), ok({}, 503), ok({}, 503), ok({}, 503), ok({}, 503)],
        'api.dexpaprika.com': [ok({}, 503), ok({}, 503), ok({}, 503), ok({}, 503), ok({}, 503), ok({}, 503)],
        [FUEL_PAIR]: [ok({}, 503), ok({}, 503), ok({}, 503)],
        [FUEL_TOKEN]: [ok({}, 503), ok({}, 503), ok({}, 503)],
        [MORE_PAIR]: [ok({}, 503), ok({}, 503), ok({}, 503)],
        [MORE_TOKEN]: [ok({}, 503), ok({}, 503), ok({}, 503)],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep }), null)
    } finally {
      console.restore()
    }
  })
  it('skips unknown source names instead of crashing', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [`geckoterminal|${FUEL_PAIR}`]: [ok(geckoFuel())],
        [`geckoterminal|${MORE_PAIR}`]: [ok(geckoMore())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep, sources: ['nope', 'geckoterminal'] })
      assert.ok(point)
      assert.ok(console.errors.some((m) => m.includes('unknown price source')), console.errors.join(' | '))
    } finally {
      console.restore()
    }
  })
})

describe('dexscreener source behavior (token endpoint fallback preserved)', () => {
  it('logs validation failure detail then uses the fallback', async () => {
    const console = captureConsole()
    try {
      // Pair endpoint fails validation; token fallback succeeds so the run completes.
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [ok({ pairs: [pairEntry(FUEL_PAIR, FUEL_TOKEN, { chainId: 'ethereum' })] })],
        [FUEL_TOKEN]: [ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, DEXSCREENER_ONLY)
      assert.ok(point)
      const line = console.errors.find((m) => m.includes('validation failed'))
      assert.ok(line, `expected a validation failure log, got: ${console.errors.join(' | ')}`)
      assert.ok(line.includes('[fuel]'), line)
      assert.ok(line.includes('chainId'), line)
      assert.ok(line.includes('robinhood'), line)
      assert.ok(line.includes('ethereum'), line)
      assert.ok(line.includes('HTTP 200'), line)
    } finally {
      console.restore()
    }
  })
})

describe('retry behavior (dexscreener source)', () => {
  it('retries a 429 then succeeds with exponential backoff', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [ok({}, 429), ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep })
      assert.ok(point)
      assert.deepEqual(delays, [1000])
    } finally {
      console.restore()
    }
  })
  it('retries a 500 then succeeds', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [ok({}, 500), ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep })
      assert.ok(point)
      assert.deepEqual(delays, [1000])
    } finally {
      console.restore()
    }
  })
  it('retries a network error with exponential backoff', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [boom('socket hang up'), boom('socket hang up'), ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep })
      assert.ok(point)
      assert.deepEqual(delays, [1000, 2000])
    } finally {
      console.restore()
    }
  })
  it('honors the Retry-After header over the computed backoff', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [ok({}, 429, { 'Retry-After': '3' }), ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep })
      assert.ok(point)
      assert.deepEqual(delays, [3000])
    } finally {
      console.restore()
    }
  })
  it('gives up after 3 pair-endpoint attempts and then uses the fallback', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch, calls } = stubFetch({
        [FUEL_PAIR]: [ok({}, 429), ok({}, 429), ok({}, 429)],
        [FUEL_TOKEN]: [ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep })
      assert.ok(point)
      assert.equal(calls.filter((u) => u.includes(FUEL_PAIR)).length, 3)
      assert.equal(calls.filter((u) => u.includes(FUEL_TOKEN)).length, 1)
    } finally {
      console.restore()
    }
  })
  it('does not retry a 404 and goes straight to the fallback', async () => {
    const console = captureConsole()
    const { fetch, calls } = stubFetch({
      [FUEL_PAIR]: [ok({}, 404)],
      [FUEL_TOKEN]: [ok(fuelPayload())],
      [MORE_PAIR]: [ok(morePayload())],
    })
    try {
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, DEXSCREENER_ONLY)
      assert.ok(point)
      assert.equal(calls.filter((u) => u.includes(FUEL_PAIR)).length, 1)
      assert.equal(calls.filter((u) => u.includes(FUEL_TOKEN)).length, 1)
    } finally {
      console.restore()
    }
  })
})

describe('token endpoint fallback selection', () => {
  it('selects the entry matching chainId robinhood AND the expected pairAddress', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const correct = pairEntry(FUEL_PAIR, FUEL_TOKEN, { priceUsd: '7.77', liquidity: { usd: 111 } })
      const decoys = [
        pairEntry(FUEL_PAIR, FUEL_TOKEN, { chainId: 'ethereum', priceUsd: '9.99' }),
        pairEntry('0x0000000000000000000000000000000000000001', FUEL_TOKEN, { priceUsd: '8.88' }),
      ]
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [boom(), boom(), boom()],
        [FUEL_TOKEN]: [ok({ pairs: [...decoys, correct] })],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep })
      assert.equal(point.fuelPrice, 7.77)
      assert.equal(point.fuelLiquidity, 111)
    } finally {
      console.restore()
    }
  })
  it('fails the run when the fallback finds no matching entry', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [boom(), boom(), boom()],
        [FUEL_TOKEN]: [ok({ pairs: [pairEntry('0x0000000000000000000000000000000000000001', FUEL_TOKEN)] })],
        [MORE_PAIR]: [ok(morePayload())],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep }), null)
      assert.ok(console.errors.some((m) => m.includes('none matching expected pairAddress')), console.errors.join(' | '))
    } finally {
      console.restore()
    }
  })
  it('rejects a fallback entry that matches chainId and pairAddress but not the token', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [boom(), boom(), boom()],
        [FUEL_TOKEN]: [ok({ pairs: [pairEntry(FUEL_PAIR, '0x0000000000000000000000000000000000000002')] })],
        [MORE_PAIR]: [ok(morePayload())],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep }), null)
      assert.ok(console.errors.some((m) => m.includes('baseToken.address')), console.errors.join(' | '))
    } finally {
      console.restore()
    }
  })
})

describe('all-or-nothing semantics', () => {
  it('returns null when one pair fails after retry and fallback', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    try {
      const { fetch, calls } = stubFetch({
        [FUEL_PAIR]: [ok(fuelPayload())],
        [MORE_PAIR]: [ok({}, 503), ok({}, 503), ok({}, 503)],
        [MORE_TOKEN]: [ok({}, 503), ok({}, 503), ok({}, 503)],
      })
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { ...DEXSCREENER_ONLY, sleep }), null)
      assert.equal(calls.filter((u) => u.includes(MORE_PAIR)).length, 3)
      assert.equal(calls.filter((u) => u.includes(MORE_TOKEN)).length, 3)
    } finally {
      console.restore()
    }
  })
  it('never writes partial data: runMarketSnapshot leaves KV untouched on pair failure', async () => {
    const console = captureConsole()
    const { sleep } = sleepStub()
    const writes = []
    const env = {
      ACTIVITY: {
        get: async () => null,
        put: async (...args) => { writes.push(args) },
      },
    }
    try {
      mock.method(globalThis, 'fetch', async (url) => {
        const key = String(url)
        if (!key.includes('dexscreener')) return ok({}, 404)()
        if (key.includes(FUEL_PAIR) || key.includes(FUEL_TOKEN)) return ok(fuelPayload())()
        return ok({}, 500)()
      })
      const result = await runMarketSnapshot(env, { sleep })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'validation-failed')
      assert.equal(writes.length, 0)
      assert.ok(console.errors.some((m) => m.includes('history untouched')), console.errors.join(' | '))
    } finally {
      console.restore()
    }
  })
})

describe('runMarketSnapshot success path', () => {
  it('writes one history point and returns ok', async () => {
    const console = captureConsole()
    const writes = []
    const env = {
      ACTIVITY: {
        get: async () => null,
        put: async (...args) => { writes.push(args) },
      },
    }
    try {
      mock.method(globalThis, 'fetch', async (url) => {
        const key = String(url)
        if (!key.includes('dexscreener')) return ok({}, 404)()
        if (key.includes(FUEL_PAIR)) return ok(fuelPayload())()
        if (key.includes(MORE_PAIR)) return ok(morePayload())()
        return ok({}, 404)()
      })
      const result = await runMarketSnapshot(env)
      assert.equal(result.ok, true)
      assert.equal(writes.length, 1)
      const [kvKey, body] = writes[0]
      assert.equal(kvKey, 'market-history-v1')
      const stored = JSON.parse(body)
      assert.equal(stored.points.length, 1)
      assert.equal(stored.points[0].fuelPrice, 1.23)
      assert.equal(stored.points[0].morePrice, 4.56)
      assert.equal(stored.points[0].moreLiquidity, 98765)
    } finally {
      console.restore()
    }
  })
  it('skips when the KV binding is unavailable', async () => {
    const result = await runMarketSnapshot({})
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'kv-unavailable')
  })
})
