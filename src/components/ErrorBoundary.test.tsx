// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(() => {
  cleanup()
})

function Boom(): never {
  throw new Error('render crash')
}

it('renders children when nothing throws', () => {
  render(
    <ErrorBoundary>
      <span>healthy content</span>
    </ErrorBoundary>,
  )
  expect(screen.getByText('healthy content')).toBeTruthy()
})

it('shows an honest fallback instead of a blank page when a child throws', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
  } finally {
    spy.mockRestore()
  }
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByText(/This view ran into a problem/)).toBeTruthy()
  // Diagnostics stay private: the error text never reaches the page.
  expect(screen.queryByText(/render crash/)).toBeNull()
  expect(screen.getByRole('link', { name: '/api/market-history' })).toBeTruthy()
})

it('reload button triggers a page reload', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { value: { reload }, writable: true })
  try {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
  } finally {
    spy.mockRestore()
  }
  fireEvent.click(screen.getByRole('button', { name: /Reload the page/ }))
  expect(reload).toHaveBeenCalledTimes(1)
})
