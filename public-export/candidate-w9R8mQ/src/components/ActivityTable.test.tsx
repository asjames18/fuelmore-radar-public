// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ActivityTable } from './ActivityTable'
import { sourceCheck } from '../lib/sourceStatus'
afterEach(cleanup)
it('distinguishes failed transfer sources from a confirmed empty response', () => {
  render(<ActivityTable activity={[]} sources={[sourceCheck('FUEL transfers', 0, 1, new Date().toISOString(), '')]}/> )
  expect(screen.getByText(/Transfer data unavailable/)).toBeTruthy()
  expect(screen.queryByText('No indexed transfers returned.')).toBeNull()
})
it('reports empty only when both transfer sources responded', () => {
  render(<ActivityTable activity={[]} sources={['FUEL transfers', 'MORE transfers'].map(name => sourceCheck(name, 1, 1, new Date().toISOString(), ''))}/> )
  expect(screen.getByText('No indexed transfers returned.')).toBeTruthy()
})
