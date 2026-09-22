import { describe, expect, it } from 'vitest'
import { hasUnavailableSources, sourceCheck } from './sourceStatus'
describe('source availability', () => {
  it('reports partial and wholly unavailable reads without calling them live', () => {
    expect(sourceCheck('RPC', 16, 17, 'now', '').status).toBe('partial')
    expect(sourceCheck('RPC', 0, 17, 'now', '').status).toBe('unavailable')
    expect(hasUnavailableSources([sourceCheck('Markets', 2, 2, 'now', ''), sourceCheck('Holders', 0, 1, 'now', '')])).toBe(true)
  })
  it('treats successful empty results as available', () => {
    expect(hasUnavailableSources([sourceCheck('Empty transfers', 1, 1, 'now', '')])).toBe(false)
  })
})
