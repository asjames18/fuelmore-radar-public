// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { FirstClaimCountdown } from './FirstClaimCountdown'

afterEach(() => { cleanup(); vi.useRealTimers() })

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const ready = (days: Array<{ date: string; scheduled: number }>, due = 0) => ({
  status: 'ready' as const,
  days,
  activeCount: 100,
  due,
  samplesChecked: 3,
  historyFrom: null,
})

it('counts down to the first date with scheduled maturities', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${tomorrow}T00:00:00Z`).getTime() - 36_000_000)
  render(<FirstClaimCountdown maturity={ready([{ date: tomorrow, scheduled: 901 }])}/>)
  expect(screen.getByText('First rewards unlock in')).toBeTruthy()
  // 10 hours out: 0d 10h 00m 00s
  expect(screen.getByText('0d 10h 00m 00s')).toBeTruthy()
  expect(screen.getByText(/901 positions maturing that day/)).toBeTruthy()
})

it('skips past dates and picks the earliest upcoming one', () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  render(<FirstClaimCountdown maturity={ready([
    { date: yesterday, scheduled: 50 },
    { date: tomorrow, scheduled: 901 },
  ])}/>)
  expect(screen.getByText(/901 positions maturing that day/)).toBeTruthy()
})

it('shows the live state when matured positions are waiting', () => {
  render(<FirstClaimCountdown maturity={ready([{ date: tomorrow, scheduled: 901 }], 17)}/>)
  expect(screen.getByText('First rewards are live')).toBeTruthy()
  expect(screen.getByText(/17 matured positions ready to claim/)).toBeTruthy()
})

it('stays quiet when the schedule is unavailable or empty', () => {
  const { container, rerender } = render(<FirstClaimCountdown maturity={undefined}/>)
  expect(container.firstChild).toBeNull()
  rerender(<FirstClaimCountdown maturity={{ status: 'unavailable', error: 'scan incomplete' }}/>)
  expect(container.firstChild).toBeNull()
  rerender(<FirstClaimCountdown maturity={ready([])}/>)
  expect(container.firstChild).toBeNull()
})

it('ticks every second', () => {
  vi.useFakeTimers()
  const target = new Date(`${tomorrow}T00:00:00Z`).getTime()
  vi.setSystemTime(target - 65_000)
  render(<FirstClaimCountdown maturity={ready([{ date: tomorrow, scheduled: 901 }])}/>)
  expect(screen.getByText('0d 00h 01m 05s')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(5000) })
  expect(screen.getByText('0d 00h 01m 00s')).toBeTruthy()
})
