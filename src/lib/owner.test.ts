import { describe, expect, it } from 'vitest'
import {
  buildActionBias,
  buildRiskProfile,
  overallTone,
  riskHeadline,
  scoreMarketDirection,
  scoreOwnerDirection,
  OWNER_WALLET,
} from './owner'

describe('owner cockpit direction', () => {
  it('pins the personal wallet checksum address', () => {
    expect(OWNER_WALLET).toBe('0x36ccC887e2c98f710F789a1f9551e24c01aDE6F6')
  })

  it('flags thin liquidity and negative price as deteriorating pressure', () => {
    const signals = scoreMarketDirection({
      fuelChange24h: -8,
      moreChange24h: -2,
      fuelLiquidityUsd: 12_000,
      moreLiquidityUsd: 40_000,
      fuelVolume24h: 80_000,
      fuelBuys24h: 10,
      fuelSells24h: 40,
      partial: false,
    })
    expect(overallTone(signals)).toBe('deteriorating')
    expect(signals.find(signal => signal.id === 'fuel-liquidity')?.tone).toBe('deteriorating')
  })

  it('favors wait/manage when the owner has a large open mint book', () => {
    const market = {
      fuelChange24h: 1,
      moreChange24h: 0,
      fuelLiquidityUsd: 60_000,
      moreLiquidityUsd: 60_000,
      fuelVolume24h: 20_000,
      fuelBuys24h: 20,
      fuelSells24h: 18,
      partial: false,
    }
    const owner = {
      activeMints: 288,
      nextMaturityTs: Math.floor(Date.now() / 1000) + 5 * 86_400,
      dueOrLate: 0,
      liquidFuel: false,
      nowTs: Math.floor(Date.now() / 1000),
    }
    const actions = buildActionBias({ market, owner, overall: overallTone([...scoreMarketDirection(market), ...scoreOwnerDirection(owner)]) })
    expect(actions.find(action => action.id === 'wait')?.tone).toBe('favor')
    expect(actions.find(action => action.id === 'mint')?.tone).toBe('avoid')
    expect(actions.find(action => action.id === 'sell')?.tone).toBe('avoid')
  })

  it('raises claim urgency when positions are due', () => {
    const signals = scoreOwnerDirection({
      activeMints: 10,
      nextMaturityTs: Math.floor(Date.now() / 1000) - 100,
      dueOrLate: 4,
      liquidFuel: false,
      nowTs: Math.floor(Date.now() / 1000),
    })
    expect(signals.find(signal => signal.id === 'claim-urgency')?.tone).toBe('deteriorating')
  })

  it('does not treat a missing liquid FUEL balance as zero', () => {
    const market = {
      fuelChange24h: 1,
      moreChange24h: 0,
      fuelLiquidityUsd: 60_000,
      moreLiquidityUsd: 60_000,
      fuelVolume24h: 20_000,
      fuelBuys24h: 20,
      fuelSells24h: 18,
      partial: false,
    }
    const owner = {
      activeMints: 10,
      nextMaturityTs: Math.floor(Date.now() / 1000) + 5 * 86_400,
      dueOrLate: 0,
      liquidFuel: null,
      nowTs: Math.floor(Date.now() / 1000),
    }
    const actions = buildActionBias({ market, owner, overall: 'mixed' })
    expect(actions.find(action => action.id === 'sell')?.tone).toBe('neutral')
    expect(actions.find(action => action.id === 'sell')?.reason).toMatch(/unavailable/i)
  })

  it('builds a risk profile with liquidity and claim areas', () => {
    const areas = buildRiskProfile({
      market: {
        fuelChange24h: -1,
        moreChange24h: 0,
        fuelLiquidityUsd: 12_000,
        moreLiquidityUsd: 40_000,
        fuelVolume24h: 90_000,
        fuelBuys24h: 5,
        fuelSells24h: 40,
        partial: false,
        fuelTopHolderPct: 12,
        contractsVerified: 6,
        contractsTotal: 7,
      },
      owner: {
        activeMints: 288,
        nextMaturityTs: Math.floor(Date.now() / 1000) - 10,
        dueOrLate: 12,
        liquidFuel: false,
        nowTs: Math.floor(Date.now() / 1000),
      },
    })
    expect(areas.find(area => area.id === 'liquidity')?.tone).toBe('risk')
    expect(areas.find(area => area.id === 'claim')?.tone).toBe('risk')
    expect(riskHeadline(areas).tone).toBe('risk')
  })
})
