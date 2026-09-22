import { getAddress } from 'viem'

/** Personal FUEL cockpit owner — public address only. */
export const OWNER_WALLET = getAddress('0x36ccC887e2c98f710F789a1f9551e24c01aDE6F6')

export type DirectionTone = 'improving' | 'mixed' | 'deteriorating' | 'unknown'

export type DirectionSignal = {
  id: string
  label: string
  tone: DirectionTone
  detail: string
}

export type ActionBias = {
  id: 'mint' | 'buy' | 'sell' | 'wait'
  label: string
  tone: 'favor' | 'caution' | 'avoid' | 'neutral'
  reason: string
}

export type RiskArea = {
  id: string
  label: string
  tone: 'good' | 'warn' | 'risk' | 'unknown'
  detail: string
}

export type MarketDirectionInput = {
  fuelChange24h: number | null
  moreChange24h: number | null
  fuelLiquidityUsd: number | null
  moreLiquidityUsd: number | null
  fuelVolume24h: number | null
  fuelBuys24h: number | null
  fuelSells24h: number | null
  partial: boolean
  fuelTopHolderPct?: number | null
  contractsVerified?: number | null
  contractsTotal?: number | null
}

export type OwnerDirectionInput = {
  activeMints: number | null
  nextMaturityTs: number | null
  dueOrLate: number | null
  liquidFuel: boolean | null
  nowTs: number
}

export function scoreMarketDirection(input: MarketDirectionInput): DirectionSignal[] {
  const signals: DirectionSignal[] = []

  if (input.partial) {
    signals.push({
      id: 'coverage',
      label: 'Data coverage',
      tone: 'unknown',
      detail: 'Some sources are partial or delayed — treat direction as incomplete.',
    })
  }

  const change = input.fuelChange24h
  signals.push({
    id: 'fuel-price',
    label: 'FUEL 24h price',
    tone: change == null ? 'unknown' : change >= 3 ? 'improving' : change <= -3 ? 'deteriorating' : 'mixed',
    detail: change == null ? 'Price change unavailable.' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}% Dexscreener snapshot (not an executable quote).`,
  })

  const liq = input.fuelLiquidityUsd
  signals.push({
    id: 'fuel-liquidity',
    label: 'FUEL pool liquidity',
    tone: liq == null ? 'unknown' : liq >= 50_000 ? 'improving' : liq >= 25_000 ? 'mixed' : 'deteriorating',
    detail: liq == null ? 'Liquidity unavailable.' : `About $${Math.round(liq).toLocaleString()} — thin pools raise slippage on buys/sells.`,
  })

  const vol = input.fuelVolume24h
  const turnover = liq && vol != null && liq > 0 ? vol / liq : null
  signals.push({
    id: 'fuel-turnover',
    label: 'FUEL turnover',
    tone: turnover == null ? 'unknown' : turnover > 5 ? 'deteriorating' : turnover > 2 ? 'mixed' : 'improving',
    detail: turnover == null ? 'Volume/liquidity ratio unavailable.' : `${turnover.toFixed(1)}× liquidity traded in 24h.`,
  })

  const buys = input.fuelBuys24h
  const sells = input.fuelSells24h
  if (buys != null && sells != null && buys + sells > 0) {
    const skew = (buys - sells) / (buys + sells)
    signals.push({
      id: 'flow-skew',
      label: 'Buy vs sell count',
      tone: skew > 0.15 ? 'improving' : skew < -0.15 ? 'deteriorating' : 'mixed',
      detail: `${buys.toLocaleString()} buys / ${sells.toLocaleString()} sells (Dexscreener counts, not verified swaps).`,
    })
  }

  return signals
}

export function scoreOwnerDirection(input: OwnerDirectionInput): DirectionSignal[] {
  const signals: DirectionSignal[] = []
  if (input.activeMints == null) {
    signals.push({ id: 'inventory', label: 'Your mint inventory', tone: 'unknown', detail: 'Batch inventory not loaded yet.' })
    return signals
  }

  signals.push({
    id: 'inventory',
    label: 'Your mint inventory',
    tone: input.activeMints > 0 ? 'mixed' : 'unknown',
    detail: `${input.activeMints.toLocaleString()} active batch mint slot${input.activeMints === 1 ? '' : 's'} loaded.`,
  })

  if ((input.dueOrLate ?? 0) > 0) {
    signals.push({
      id: 'claim-urgency',
      label: 'Claim urgency',
      tone: 'deteriorating',
      detail: `${input.dueOrLate} position${input.dueOrLate === 1 ? '' : 's'} at or past maturity — late claims face escalating penalty (verified Token rules).`,
    })
  } else if (input.nextMaturityTs != null) {
    const days = (input.nextMaturityTs - input.nowTs) / 86_400
    signals.push({
      id: 'next-wave',
      label: 'Next maturity wave',
      tone: days <= 3 ? 'mixed' : days <= 10 ? 'improving' : 'mixed',
      detail: days < 0
        ? 'Next recorded maturity is already due.'
        : `Nearest maturity in about ${days.toFixed(1)} days.`,
    })
  }

  if (input.liquidFuel === false) {
    signals.push({
      id: 'liquid-fuel',
      label: 'Liquid FUEL',
      tone: 'mixed',
      detail: 'No liquid FUEL balance — sells require claiming matured mints first.',
    })
  }

  return signals
}

export function overallTone(signals: DirectionSignal[]): DirectionTone {
  if (signals.length === 0 || signals.every(signal => signal.tone === 'unknown')) return 'unknown'
  const known = signals.filter(signal => signal.tone !== 'unknown')
  const bad = known.filter(signal => signal.tone === 'deteriorating').length
  const good = known.filter(signal => signal.tone === 'improving').length
  if (bad > good) return 'deteriorating'
  if (good > bad) return 'improving'
  return 'mixed'
}

export function buildActionBias(args: {
  market: MarketDirectionInput
  owner: OwnerDirectionInput
  overall: DirectionTone
}): ActionBias[] {
  const { market, owner, overall } = args
  const nearClaim = (owner.dueOrLate ?? 0) > 0 || (owner.nextMaturityTs != null && owner.nextMaturityTs - owner.nowTs <= 3 * 86_400)
  const heavyInventory = (owner.activeMints ?? 0) >= 50
  const thinLiq = market.fuelLiquidityUsd != null && market.fuelLiquidityUsd < 25_000

  return [
    {
      id: 'wait',
      label: 'Wait / manage',
      tone: nearClaim || heavyInventory ? 'favor' : overall === 'deteriorating' ? 'favor' : 'neutral',
      reason: nearClaim
        ? 'Maturity is close or due — prioritize claim timing against the verified late-penalty curve.'
        : heavyInventory
          ? 'Large open mint book — monitoring claim waves usually beats opening more slots.'
          : 'Default when direction is unclear or mixed.',
    },
    {
      id: 'mint',
      label: 'Mint more',
      tone: nearClaim || heavyInventory || thinLiq || overall === 'deteriorating' ? 'avoid' : overall === 'improving' ? 'caution' : 'caution',
      reason: heavyInventory
        ? 'You already run a large batch inventory; each new slot pays a full mint fee.'
        : thinLiq
          ? 'Thin FUEL liquidity raises exit risk after claim.'
          : 'Mint only if term/fee tradeoff still fits your plan — fees are live; reward estimates are modeled, not guaranteed.',
    },
    {
      id: 'buy',
      label: 'Buy FUEL',
      tone: thinLiq ? 'avoid' : overall === 'improving' && (market.fuelChange24h ?? 0) < 0 ? 'caution' : 'caution',
      reason: thinLiq
        ? 'Pool looks thin — size carefully; Dexscreener is not an executable quote.'
        : 'Market snapshots can support a thesis, but buys are still third-party prices with slippage.',
    },
    {
      id: 'sell',
      label: 'Sell FUEL',
      tone: owner.liquidFuel == null ? 'neutral' : owner.liquidFuel ? (thinLiq ? 'caution' : overall === 'deteriorating' ? 'caution' : 'neutral') : 'avoid',
      reason: owner.liquidFuel == null
        ? 'Liquid FUEL balance unavailable — not treated as zero.'
        : owner.liquidFuel
          ? 'If selling, compare size vs pool liquidity; larger clips usually get worse effective price.'
          : 'No liquid FUEL to sell until matured mints are claimed.',
    },
  ]
}

/** Risk war / profile across market + owner areas for the Cockpit desk. */
export function buildRiskProfile(args: {
  market: MarketDirectionInput
  owner: OwnerDirectionInput
}): RiskArea[] {
  const { market, owner } = args
  const liq = market.fuelLiquidityUsd
  const vol = market.fuelVolume24h
  const turnover = liq && vol != null && liq > 0 ? vol / liq : null
  const areas: RiskArea[] = [
    {
      id: 'liquidity',
      label: 'Liquidity depth',
      tone: liq == null ? 'unknown' : liq < 25_000 ? 'risk' : liq < 50_000 ? 'warn' : 'good',
      detail: liq == null
        ? 'FUEL pool liquidity unavailable.'
        : `About $${Math.round(liq).toLocaleString()} in the FUEL/WETH pool snapshot — thin depth raises buy/sell slippage.`,
    },
    {
      id: 'turnover',
      label: 'Turnover heat',
      tone: turnover == null ? 'unknown' : turnover > 5 ? 'risk' : turnover > 2 ? 'warn' : 'good',
      detail: turnover == null
        ? 'Volume/liquidity ratio unavailable.'
        : `${turnover.toFixed(1)}× pool liquidity traded in 24h (Dexscreener).`,
    },
    {
      id: 'flow',
      label: 'Buy / sell pressure',
      tone: (() => {
        const buys = market.fuelBuys24h
        const sells = market.fuelSells24h
        if (buys == null || sells == null || buys + sells === 0) return 'unknown'
        const skew = (buys - sells) / (buys + sells)
        if (skew < -0.15) return 'warn'
        if (skew > 0.15) return 'good'
        return 'warn'
      })(),
      detail: market.fuelBuys24h != null && market.fuelSells24h != null
        ? `${market.fuelBuys24h.toLocaleString()} buys / ${market.fuelSells24h.toLocaleString()} sells — counts are third-party, not verified swaps.`
        : 'Trade-count skew unavailable.',
    },
    {
      id: 'claim',
      label: 'Claim / penalty risk',
      tone: (owner.dueOrLate ?? 0) > 0 ? 'risk' : owner.nextMaturityTs != null && owner.nextMaturityTs - owner.nowTs <= 3 * 86_400 ? 'warn' : owner.activeMints ? 'good' : 'unknown',
      detail: (owner.dueOrLate ?? 0) > 0
        ? `${owner.dueOrLate} matured slot(s) — late claims escalate penalty under verified Token rules.`
        : owner.nextMaturityTs != null
          ? `Next maturity in about ${((owner.nextMaturityTs - owner.nowTs) / 86_400).toFixed(1)} days.`
          : 'No maturity wave loaded yet.',
    },
    {
      id: 'inventory',
      label: 'Inventory concentration',
      tone: owner.activeMints == null ? 'unknown' : owner.activeMints >= 100 ? 'warn' : owner.activeMints >= 50 ? 'warn' : 'good',
      detail: owner.activeMints == null
        ? 'Mint inventory not loaded.'
        : `${owner.activeMints.toLocaleString()} open mint slot(s) — large books raise fee and claim-management load.`,
    },
    {
      id: 'holders',
      label: 'Holder concentration',
      tone: market.fuelTopHolderPct == null ? 'unknown' : market.fuelTopHolderPct > 10 ? 'warn' : 'good',
      detail: market.fuelTopHolderPct == null
        ? 'Top non-contract holder share unavailable.'
        : `Largest non-contract holder ≈ ${market.fuelTopHolderPct.toFixed(2)}% of supply.`,
    },
    {
      id: 'coverage',
      label: 'Data coverage',
      tone: market.partial ? 'warn' : 'good',
      detail: market.partial
        ? 'Some sources are partial or delayed — treat the desk as incomplete.'
        : 'Core market/protocol sources responded for this snapshot.',
    },
  ]

  if (market.contractsVerified != null && market.contractsTotal != null) {
    areas.push({
      id: 'verification',
      label: 'Contract verification',
      tone: market.contractsVerified === market.contractsTotal ? 'good' : 'warn',
      detail: `${market.contractsVerified}/${market.contractsTotal} configured contracts explorer-verified — verification is not a security audit.`,
    })
  }

  return areas
}

export function riskHeadline(areas: RiskArea[]): { tone: 'good' | 'warn' | 'risk' | 'unknown'; label: string } {
  const known = areas.filter(area => area.tone !== 'unknown')
  if (known.length === 0) return { tone: 'unknown', label: 'Risk profile incomplete' }
  const risk = known.filter(area => area.tone === 'risk').length
  const warn = known.filter(area => area.tone === 'warn').length
  if (risk > 0) return { tone: 'risk', label: `${risk} elevated risk area${risk === 1 ? '' : 's'}` }
  if (warn > 0) return { tone: 'warn', label: `${warn} watch item${warn === 1 ? '' : 's'}` }
  return { tone: 'good', label: 'No elevated risk flags in loaded areas' }
}
