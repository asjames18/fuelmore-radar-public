import { parseUnits } from 'viem'

export const shortAddress = (address: string, lead = 6, tail = 4) =>
  `${address.slice(0, lead)}…${address.slice(-tail)}`

export const formatUsd = (value: number | null, compact = false) => {
  if (value == null || !Number.isFinite(value)) return '—'
  if (compact && Math.abs(value) >= 1_000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(value)
  }
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 8
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: digits,
  }).format(value)
}

export const formatToken = (value: bigint | null, digits = 0) => {
  if (value == null) return '—'
  const amount = Number(value) / 1e18
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, notation: amount > 999_999 ? 'compact' : 'standard' }).format(amount)
}

/** Decimal token strings from the activity collector; invalid values stay unknown. */
export const formatClaimedFuel = (value: string, digits = 2) => {
  try {
    return formatToken(parseUnits(value, 18), digits)
  } catch {
    return '—'
  }
}

export const formatEth = (value: bigint | null, digits = 4) => {
  if (value == null) return '—'
  return `${(Number(value) / 1e18).toLocaleString('en-US', { maximumFractionDigits: digits })} ETH`
}

export const formatChange = (value: number | null) =>
  value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

export const timeAgo = (iso: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}
