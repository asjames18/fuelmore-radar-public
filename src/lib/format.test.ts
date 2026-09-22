import { describe, expect, it } from 'vitest'
import { formatChange, formatClaimedFuel, formatEth, formatToken, formatUsd, isSyncStale, shortAddress } from './format'

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

  it('flags a sync as stale only past the 6-hour threshold', () => {
    const now = Date.now()
    expect(isSyncStale(new Date(now - 60_000).toISOString())).toBe(false)
    expect(isSyncStale(new Date(now - 5 * 3600_000).toISOString())).toBe(false)
    expect(isSyncStale(new Date(now - 6 * 3600_000 - 1_000).toISOString())).toBe(true)
    expect(isSyncStale(new Date(now - 8 * 3600_000).toISOString())).toBe(true)
    expect(isSyncStale(null)).toBe(false)
    expect(isSyncStale(undefined)).toBe(false)
    expect(isSyncStale('not-a-date')).toBe(false)
    // A future timestamp is never stale.
    expect(isSyncStale(new Date(now + 60_000).toISOString())).toBe(false)
  })
})
