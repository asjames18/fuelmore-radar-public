export type SourceCheck = { name: string; status: 'available' | 'partial' | 'unavailable'; checkedAt: string; detail: string; retained?: boolean; attemptedAt?: string }
export function sourceCheck(name: string, available: number, total: number, checkedAt: string, detail: string): SourceCheck {
  return { name, status: available === total ? 'available' : available === 0 ? 'unavailable' : 'partial', checkedAt, detail }
}
export function hasUnavailableSources(sources: SourceCheck[]) {
  return sources.some(source => source.status !== 'available')
}
