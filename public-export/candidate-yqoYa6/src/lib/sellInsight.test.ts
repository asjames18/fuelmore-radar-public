import { describe, expect, it } from 'vitest'
import { buildSafeSellGuide, buildSellInsight, fuelToUsd, liquidityBand, splitSellPieces } from './sellInsight'

describe('sell insight', () => {
  it('frames a small clip as comfortable vs pool depth', () => {
    const insight = buildSellInsight({
      fuelAmount: 100n * 10n ** 18n,
      priceUsd: 0.01,
      liquidityUsd: 50_000,
    })
    expect(insight.notionalUsd).toBeCloseTo(1, 5)
    expect(insight.band).toBe('comfortable')
    expect(insight.detail).toMatch(/Dexscreener|smaller clip/i)
  })

  it('flags extreme size against thin liquidity', () => {
    expect(liquidityBand(0.08)).toBe('extreme')
    const insight = buildSellInsight({
      fuelAmount: 1_000_000n * 10n ** 18n,
      priceUsd: 0.01,
      liquidityUsd: 20_000,
    })
    expect(insight.band).toBe('extreme')
  })

  it('splits a sell size into pieces without dropping dust remainder', () => {
    const pieces = splitSellPieces(10n, 3)
    expect(pieces).toHaveLength(3)
    expect(pieces.reduce((sum, value) => sum + value, 0n)).toBe(10n)
  })

  it('computes illustrative 0.5% / 2% safer sell bands', () => {
    const guide = buildSafeSellGuide({
      selectedFuel: 100n * 10n ** 18n,
      priceUsd: 0.01,
      liquidityUsd: 100_000,
    })
    expect(guide.safeUsd).toBeCloseTo(500, 5)
    expect(guide.cautionUsd).toBeCloseTo(2_000, 5)
    expect(guide.recommendation).toBe('under-safe')
    expect(fuelToUsd(100n * 10n ** 18n, 0.01)).toBeCloseTo(1, 5)
  })
})
