import { getAddress, isAddress } from 'viem'
import { storageKey } from './storage'
const key = () => storageKey('watchlist')
export function normalizeWatchlist(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((value): value is string => typeof value === 'string' && isAddress(value)).map(value => getAddress(value)))].slice(0, 50)
}
export function readWatchlist(): string[] {
  try { return normalizeWatchlist(JSON.parse(localStorage.getItem(key()) ?? '[]')) } catch { return [] }
}
export function saveWatchlist(addresses: string[]): boolean {
  try { localStorage.setItem(key(), JSON.stringify(normalizeWatchlist(addresses))); return true } catch { return false }
}
