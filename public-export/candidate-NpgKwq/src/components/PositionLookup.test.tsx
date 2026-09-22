// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PositionLookup } from './PositionLookup'
afterEach(() => {cleanup();vi.restoreAllMocks()})
it('does not preload a personal wallet by default', () => {
 const fetch = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'))
 render(<PositionLookup/> )
 const input = screen.getByRole('textbox',{name:/Robinhood Chain wallet/i}) as HTMLInputElement
 expect(input.value).toBe('')
 expect(fetch).not.toHaveBeenCalled()
})
