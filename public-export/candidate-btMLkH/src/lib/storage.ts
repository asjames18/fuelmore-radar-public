/** Keep visitor preferences separate when editions share a development origin. */
export function storageKey(name: string): string {
  const edition = import.meta.env.MODE === 'public' ? ':public' : ''
  return `fuelmore-radar${edition}:${name}:v1`
}
