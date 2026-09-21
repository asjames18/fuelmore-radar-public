import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  MarketValidationError,
  collectMarketSnapshot,
  runMarketSnapshot,
  validateDexPair,
} from './market-collect.mjs'

const FUEL_PAIR = '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69'
const FUEL_TOKEN = '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3'
const MORE_PAIR = '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef'
const MORE_TOKEN = '0xc0F1A40512114b25cc1F30b5DF0bb48691405555'

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

const fuelPayload = () => ({ pairs: [pairEntry(FUEL_PAIR, FUEL_TOKEN)] })
const morePayload = () => ({ pairs: [pairEntry(MORE_PAIR, MORE_TOKEN, { priceUsd: '4.56', liquidity: { usd: 98765 } })] })

const ok = (payload, status = 200, headers = {}) => () =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const boom = (message = 'network down') => () => { throw new Error(message) }

/** Stub fetch keyed by URL substring; each plan entry is consumed once, in order. */
function stubFetch(plans) {
  const calls = []
  const fetchImpl = async (url) => {
    const key = String(url)
    calls.push(key)
    for (const [substr, queue] of Object.entries(plans)) {
      if (key.includes(substr)) {
        const next = queue.shift()
        if (!next) throw new Error(`no plan left for ${substr}`)
        return next()
      }
    }
    throw new Error(`unexpected URL: ${key}`)
  }
  return { fetch: fetchImpl, calls }
}

function captureConsole() {
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  return { errors, restore: () => { console.error = original } }
}

function sleepStub() {
  const delays = []
  const sleep = async (ms) => { delays.push(ms) }
  return { delays, sleep }
}

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

describe('validation failure logging', () => {
  afterEach(() => mock.restoreAll())
  it('logs which pair, which check, expected vs actual, and the HTTP status', async () => {
    const console = captureConsole()
    try {
      // Pair endpoint fails validation; token fallback succeeds so the run completes.
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [ok({ pairs: [pairEntry(FUEL_PAIR, FUEL_TOKEN, { chainId: 'ethereum' })] })],
        [FUEL_TOKEN]: [ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000)
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

describe('retry behavior', () => {
  it('retries a 429 then succeeds with exponential backoff', async () => {
    const console = captureConsole()
    const { delays, sleep } = sleepStub()
    try {
      const { fetch } = stubFetch({
        [FUEL_PAIR]: [ok({}, 429), ok(fuelPayload())],
        [MORE_PAIR]: [ok(morePayload())],
      })
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
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
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
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
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
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
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
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
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
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
      const point = await collectMarketSnapshot(fetch, 1_700_000_000)
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
      const point = await collectMarketSnapshot(fetch, 1_700_000_000, { sleep })
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
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep }), null)
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
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep }), null)
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
      assert.equal(await collectMarketSnapshot(fetch, 1_700_000_000, { sleep }), null)
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
