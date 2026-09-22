/**
 * Read-only sell sizing helpers.
 * USD notionals use Dexscreener price/liquidity — a third-party mirror of on-chain
 * pool reserves — not an executable Uniswap quote.
 */

export type LiquidityBand = 'comfortable' | 'noticeable' | 'heavy' | 'extreme' | 'unknown'

export type SellInsight = {
  fuelAmount: bigint
  priceUsd: number | null
  notionalUsd: number | null
  liquidityUsd: number | null
  shareOfLiquidity: number | null
  band: LiquidityBand
  detail: string
}

export function liquidityBand(share: number | null): LiquidityBand {
  if (share == null || !Number.isFinite(share)) return 'unknown'
  if (share < 0.005) return 'comfortable'
  if (share < 0.02) return 'noticeable'
  if (share < 0.05) return 'heavy'
  return 'extreme'
}

export function bandLabel(band: LiquidityBand) {
  if (band === 'comfortable') return 'Small vs pool'
  if (band === 'noticeable') return 'Noticeable clip'
  if (band === 'heavy') return 'Heavy vs liquidity'
  if (band === 'extreme') return 'Very large vs pool'
  return 'Liquidity unknown'
}

/** Suggested max share of pool liquidity for a single clip (illustrative, not advice). */
export const SAFE_SELL_SHARE = 0.005 // 0.5%
export const CAUTION_SELL_SHARE = 0.02 // 2%

export type SafeSellGuide = {
  safeFuel: bigint | null
  cautionFuel: bigint | null
  safeUsd: number | null
  cautionUsd: number | null
  selectedShare: number | null
  recommendation: 'under-safe' | 'under-caution' | 'over-caution' | 'unknown'
  detail: string
}

export function buildSafeSellGuide(args: {
  selectedFuel: bigint
  priceUsd: number | null
  liquidityUsd: number | null
}): SafeSellGuide {
  const { selectedFuel, priceUsd, liquidityUsd } = args
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0 || liquidityUsd == null || liquidityUsd <= 0) {
    return {
      safeFuel: null,
      cautionFuel: null,
      safeUsd: null,
      cautionUsd: null,
      selectedShare: null,
      recommendation: 'unknown',
      detail: 'Need Dexscreener FUEL price and pool liquidity (on-chain-derived snapshots) to size a safer clip %.',
    }
  }
  const safeUsd = liquidityUsd * SAFE_SELL_SHARE
  const cautionUsd = liquidityUsd * CAUTION_SELL_SHARE
  const safeFuel = BigInt(Math.max(0, Math.floor((safeUsd / priceUsd) * 1e18)))
  const cautionFuel = BigInt(Math.max(0, Math.floor((cautionUsd / priceUsd) * 1e18)))
  const selectedUsd = (Number(selectedFuel) / 1e18) * priceUsd
  const selectedShare = selectedUsd / liquidityUsd
  const recommendation = selectedShare <= SAFE_SELL_SHARE
    ? 'under-safe'
    : selectedShare <= CAUTION_SELL_SHARE
      ? 'under-caution'
      : 'over-caution'
  const detail = recommendation === 'under-safe'
    ? `Selected clip is ~${(selectedShare * 100).toFixed(2)}% of pool — inside the illustrative 0.5% “smaller clip” band.`
    : recommendation === 'under-caution'
      ? `Selected clip is ~${(selectedShare * 100).toFixed(2)}% of pool — past 0.5%, still under 2%. Expect more slippage.`
      : `Selected clip is ~${(selectedShare * 100).toFixed(2)}% of pool — above the illustrative 2% caution band; splitting usually preserves more effective value.`
  return { safeFuel, cautionFuel, safeUsd, cautionUsd, selectedShare, recommendation, detail }
}

export function fuelToUsd(fuel: bigint | null, priceUsd: number | null) {
  if (fuel == null || priceUsd == null || !Number.isFinite(priceUsd)) return null
  return (Number(fuel) / 1e18) * priceUsd
}

export function buildSellInsight(args: {
  fuelAmount: bigint
  priceUsd: number | null
  liquidityUsd: number | null
}): SellInsight {
  const { fuelAmount, priceUsd, liquidityUsd } = args
  const tokens = Number(fuelAmount) / 1e18
  const notionalUsd = priceUsd != null && Number.isFinite(priceUsd) ? tokens * priceUsd : null
  const shareOfLiquidity = notionalUsd != null && liquidityUsd != null && liquidityUsd > 0
    ? notionalUsd / liquidityUsd
    : null
  const band = liquidityBand(shareOfLiquidity)
  let detail = 'USD uses Dexscreener’s on-chain-derived pool snapshot — third-party, not an executable swap quote.'
  if (fuelAmount <= 0n) detail = 'Nothing selected to model.'
  else if (notionalUsd == null) detail = 'Dexscreener FUEL price unavailable — cannot size USD notional.'
  else if (liquidityUsd == null) detail = `About $${notionalUsd.toFixed(2)} at Dexscreener price; pool liquidity unavailable for impact framing.`
  else if (band === 'comfortable') detail = `About $${notionalUsd.toFixed(2)} ≈ ${(shareOfLiquidity! * 100).toFixed(2)}% of Dexscreener pool liquidity — usually a smaller clip.`
  else if (band === 'noticeable') detail = `About $${notionalUsd.toFixed(2)} ≈ ${(shareOfLiquidity! * 100).toFixed(2)}% of Dexscreener pool liquidity — expect some slippage.`
  else if (band === 'heavy') detail = `About $${notionalUsd.toFixed(2)} ≈ ${(shareOfLiquidity! * 100).toFixed(2)}% of Dexscreener pool liquidity — large vs the pool; effective price can move a lot.`
  else if (band === 'extreme') detail = `About $${notionalUsd.toFixed(2)} ≈ ${(shareOfLiquidity! * 100).toFixed(2)}% of Dexscreener pool liquidity — extreme vs depth; splitting or waiting is usually safer.`

  return { fuelAmount, priceUsd, notionalUsd, liquidityUsd, shareOfLiquidity, band, detail }
}

export function splitSellPieces(total: bigint, pieces: number): bigint[] {
  if (total <= 0n || pieces <= 0) return []
  const n = Math.min(Math.max(1, Math.floor(pieces)), 20)
  const base = total / BigInt(n)
  const rem = total % BigInt(n)
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < rem ? 1n : 0n)).filter(v => v > 0n)
}
