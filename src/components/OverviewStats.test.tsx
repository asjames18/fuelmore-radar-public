// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OverviewStats } from './OverviewStats'
import type { ProtocolSnapshot } from '../lib/types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const E18 = 10n ** 18n
const protocol = {
  totalSupply: 1_000_000n * E18,
  moreTotalSupply: 500_000n * E18,
  globalRank: 5n,
  activeMinters: 42n,
  totalStaked: 250_000n * E18,
  activeStakes: 10n,
  amp: 1n,
  eaar: 2n,
  maxTermSeconds: 3_153_600n,
  fuelBurnt: 50_000n * E18,
  moreBurnt: 1_000n * E18,
  ethUsedFuelBurns: 5n * E18,
  ethUsedMoreBurns: 1n * E18,
  totalDistributed: 0n,
  vaultBalance: 12n * E18,
  vaultSwept: 0n,
  vaultCycle: 3n,
  vaultCycleEnd: 0n,
} as ProtocolSnapshot

const days = [
  { date: '2026-09-15', mintWallets: 8, claimWallets: 4, mints: 9, claims: 5, claimedFuel: '100' },
  { date: '2026-09-16', mintWallets: 9, claimWallets: 5, mints: 10, claims: 6, claimedFuel: '200' },
  { date: '2026-09-17', mintWallets: 10, claimWallets: 6, mints: 11, claims: 7, claimedFuel: '300' },
  { date: '2026-09-18', mintWallets: 11, claimWallets: 7, mints: 12, claims: 8, claimedFuel: '400' },
  { date: '2026-09-19', mintWallets: 12, claimWallets: 8, mints: 13, claims: 9, claimedFuel: '500' },
  { date: '2026-09-20', mintWallets: 13, claimWallets: 9, mints: 14, claims: 10, claimedFuel: '600' },
  { date: '2026-09-21', mintWallets: 14, claimWallets: 10, mints: 15, claims: 11, claimedFuel: '700' },
]
const envelope = {
  status: 'ready',
  progress: null,
  error: null,
  report: {
    days,
    maturity: {
      status: 'ready',
      days: [
        { date: '2026-09-21', scheduled: 3 },
        { date: '2026-09-25', scheduled: 7 },
        { date: '2026-09-29', scheduled: 11 },
      ],
      activeCount: 100,
      due: 4,
      samplesChecked: 5,
      historyFrom: null,
    },
    throughBlock: '987654',
    throughTimestamp: Math.floor(Date.now() / 1000),
  },
}

const handlers = { onSeeProtocol: () => {}, onSeeMarkets: () => {} }

it('shows today numbers, 7-day totals, and next-7-day maturities without charts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope)))
  render(<OverviewStats protocol={protocol} {...handlers}/>)
  await screen.findByText((_, el) => el?.textContent === 'Today · 2026-09-21 · incomplete')
  // today block
  expect(screen.getByText('Mint senders').parentElement?.querySelector('strong')?.textContent).toBe('14')
  expect(screen.getByText('Claim senders').parentElement?.querySelector('strong')?.textContent).toBe('10')
  // 7-day totals: mints 9+10+11+12+13+14+15 = 84, claims 5+6+7+8+9+10+11 = 56
  const groups = screen.getAllByText('Mint starts')
  expect(groups).toHaveLength(2)
  const sevenDay = groups[1].parentElement?.querySelector('strong')?.textContent
  expect(sevenDay).toBe('84')
  const rewardClaims = screen.getAllByText('Reward claims')
  expect(rewardClaims).toHaveLength(2)
  expect(rewardClaims[1].parentElement?.querySelector('strong')?.textContent).toBe('56')
  // next-7-day maturities: 2026-09-25 (7) only; 2026-09-29 is beyond +7 days
  expect(screen.getByText('Scheduled maturities · next 7 days').parentElement?.querySelector('strong')?.textContent).toBe('7')
  expect(screen.queryByRole('img')).toBeNull()
})

it('shows condensed protocol numbers and links onward', async () => {
  const onSeeProtocol = vi.fn()
  const onSeeMarkets = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope)))
  render(<OverviewStats protocol={protocol} onSeeProtocol={onSeeProtocol} onSeeMarkets={onSeeMarkets}/>)
  await screen.findByText('Protocol at a glance')
  expect(screen.getByText('FUEL supply').parentElement?.querySelector('strong')?.textContent).toBe('1M')
  expect(screen.getByText('FUEL staked').parentElement?.querySelector('strong')?.textContent).toBe('250,000')
  expect(screen.getByText('Pump fund').parentElement?.querySelector('strong')?.textContent).toBe('12 ETH')
  fireEvent.click(screen.getByRole('button', { name: /Full activity/ }))
  expect(onSeeProtocol).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Price charts/ }))
  expect(onSeeMarkets).toHaveBeenCalled()
})

it('keeps protocol numbers visible when the activity feed fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
  render(<OverviewStats protocol={protocol} {...handlers}/>)
  await screen.findByText('Daily stats unavailable right now.')
  expect(screen.getByText('Protocol at a glance')).toBeTruthy()
  expect(screen.queryByText(/Today ·/)).toBeNull()
})

it('flags delayed data when the envelope reports stale', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...envelope, status: 'stale', error: 'tip behind' })))
  render(<OverviewStats protocol={protocol} {...handlers}/>)
  await screen.findByText(/Delayed data/)
})

it('treats a null report in the envelope as unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'error', progress: null, error: 'Activity snapshot unavailable', report: null })))
  render(<OverviewStats protocol={protocol} {...handlers}/>)
  await screen.findByText('Daily stats unavailable right now.')
  expect(screen.getByText('Protocol at a glance')).toBeTruthy()
})

it('flags a lagging supply snapshot during claim flow instead of presenting it as current', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope)))
  const nowSec = Math.floor(Date.now() / 1000)
  render(<OverviewStats protocol={protocol} protocolObservation={{ blockTimestamp: String(nowSec - 900) }} {...handlers}/>)
  await screen.findByText((_, el) => el?.textContent === 'Today · 2026-09-21 · incomplete')
  expect(screen.getByText(/Supply is moving quickly/)).toBeTruthy()
})

it('shows no supply warning when the snapshot is fresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(envelope)))
  const nowSec = Math.floor(Date.now() / 1000)
  render(<OverviewStats protocol={protocol} protocolObservation={{ blockTimestamp: String(nowSec - 60) }} {...handlers}/>)
  await screen.findByText((_, el) => el?.textContent === 'Today · 2026-09-21 · incomplete')
  expect(screen.queryByText(/Supply is moving quickly/)).toBeNull()
})
