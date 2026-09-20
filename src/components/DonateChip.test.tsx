// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { DonateChip, DONATE_ADDRESS } from './DonateChip'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DonateChip', () => {
  it('copies the donation address to the clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<DonateChip/>)
    const button = screen.getByRole('button', { name: /copy donation address/i })
    expect(button.getAttribute('aria-label')).toContain('Robinhood Chain (chain ID 4663)')

    await act(async () => {
      fireEvent.click(button)
    })

    expect(writeText).toHaveBeenCalledWith(DONATE_ADDRESS)
    expect(screen.getByText('Copied')).toBeTruthy()
  })

  it('shows a truncated address, not the full address, in the footer', () => {
    const { container } = render(<DonateChip/>)
    expect(container.querySelector('code')?.textContent).toBe('0x995f…1f7a')
    expect(screen.queryByText(DONATE_ADDRESS)).toBeNull()
  })
})
