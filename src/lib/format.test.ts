import { describe, expect, it } from 'vitest'
import { formatChange, formatClaimedFuel, formatEth, formatToken, formatUsd, isSyncPaused, shortAddress } from './format'

describe('dashboard formatters', () => {
  it('keeps small token prices readable', () => {
    expect(formatUsd(0.00003322)).toBe('$0.00003322')
  })

  it('formats direction and compact market values', () => {
    expect(formatChange(12.345)).toBe('+12.35%')
    expect(formatChange(-4.2)).toBe('-4.20%')
    expect(formatUsd(211_960, true)).toBe('$212K')
  })

  it('formats on-chain units and addresses', () => {
    expect(formatToken(992_576n * 10n ** 18n)).toBe('992,576')
    expect(formatEth(12_600_000_000_000_000n)).toBe('0.0126 ETH')
    expect(shortAddress('0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3')).toBe('0xe60C…67A3')
  })

  it('keeps invalid claimed-fuel strings unknown instead of crashing', () => {
    expect(formatClaimedFuel('12.5')).toBe('12.5')
    expect(formatClaimedFuel('not-a-number')).toBe('—')
  })
})

describe('isSyncPaused', () => {
  const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const stale = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  const attempt = new Date().toISOString()

  it('treats a collector error as paused even when the last write looks fresh', () => {
    expect(isSyncPaused({ state: 'error', last_attempt_time: attempt }, fresh)).toBe(true)
  })

  it('does not mislabel a healthy-but-slow collector as paused', () => {
    expect(isSyncPaused({ state: 'ok', last_attempt_time: attempt }, stale)).toBe(true) // stale age still wins
    expect(isSyncPaused({ state: 'ok', last_attempt_time: attempt }, fresh)).toBe(false)
  })

  it('falls back to the age heuristic when the sync state is unknown or absent', () => {
    expect(isSyncPaused({ state: 'unknown', last_attempt_time: null }, stale)).toBe(true)
    expect(isSyncPaused({ state: 'unknown', last_attempt_time: null }, fresh)).toBe(false)
    expect(isSyncPaused(undefined, stale)).toBe(true)
    expect(isSyncPaused(undefined, fresh)).toBe(false)
    expect(isSyncPaused(undefined, null)).toBe(false)
  })
})
