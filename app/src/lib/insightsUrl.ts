/** URL helpers for the Numbers (/insights) page and map focus deep links. */

export type InsightsEra = 'all' | 'pre1900' | 'from1900'

export type InsightsUrlState = {
  era?: InsightsEra
}

const ERA_IDS: InsightsEra[] = ['all', 'pre1900', 'from1900']

/** Keys already flown-to; writer must not re-attach these coords. */
const consumedFocusKeys = new Set<string>()

export function focusKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`
}

export function markMapFocusConsumed(key: string): void {
  consumedFocusKeys.add(key)
}

export function isMapFocusConsumed(key: string): boolean {
  return consumedFocusKeys.has(key)
}

/** Clear consumed focus keys (e.g. when focus leaves the URL, or between tests). */
export function clearMapFocusConsumed(): void {
  consumedFocusKeys.clear()
}

export function eraYearBounds(era: InsightsEra): { yearFrom?: number; yearTo?: number } {
  if (era === 'pre1900') return { yearTo: 1899 }
  if (era === 'from1900') return { yearFrom: 1900 }
  return {}
}

/** Explorer query for Open map/globe so era chips carry into Map/Globe years. */
export function eraExplorerSearch(era: InsightsEra): string {
  const bounds = eraYearBounds(era)
  const p = new URLSearchParams()
  if (bounds.yearFrom != null) p.set('from', String(bounds.yearFrom))
  if (bounds.yearTo != null) p.set('to', String(bounds.yearTo))
  // Sentinel so “All years” does not leave session year filters stuck
  if (era === 'all') p.set('years', 'all')
  return p.toString()
}

export function readInsightsUrl(search = window.location.search): InsightsUrlState {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const out: InsightsUrlState = {}
  const era = p.get('era')
  if (era && ERA_IDS.includes(era as InsightsEra)) out.era = era as InsightsEra
  return out
}

export function buildInsightsSearch(opts: { era: InsightsEra }): string {
  const p = new URLSearchParams()
  if (opts.era !== 'all') p.set('era', opts.era)
  return p.toString()
}

/** Build /map?war=&from=&to= so selection survives session year filters. */
export function mapWarPath(war: {
  war_id: string
  start_year: number | null
  end_year: number | null
}): string {
  const p = new URLSearchParams()
  p.set('war', war.war_id)
  if (war.start_year != null && Number.isFinite(war.start_year)) {
    p.set('from', String(Math.round(war.start_year)))
  }
  const end = war.end_year ?? war.start_year
  if (end != null && Number.isFinite(end)) {
    p.set('to', String(Math.round(end)))
  }
  return `/map?${p.toString()}`
}

function isValidFocus(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  )
}

export function parseMapFocusSearch(search: string): { lat: number; lng: number } | null {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  // Params must be present — Number(null) === 0 would otherwise invent 0°,0°.
  if (!p.has('lat') || !p.has('lng')) return null
  const latRaw = p.get('lat')
  const lngRaw = p.get('lng')
  if (latRaw == null || lngRaw == null || latRaw.trim() === '' || lngRaw.trim() === '') return null
  const lat = Number(latRaw)
  const lng = Number(lngRaw)
  if (!isValidFocus(lat, lng)) return null
  return { lat, lng }
}

/** Remove one-shot focus coords from the current search string. */
export function stripMapFocusSearch(search: string): string {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  p.delete('lat')
  p.delete('lng')
  return p.toString()
}

/** Strip trailing slashes for consistent route checks. */
export function normalizePath(pathname: string): string {
  const p = pathname.replace(/\/+$/, '')
  return p || '/'
}

/**
 * Merge explorer query with one-shot map focus from the live URL so the
 * debounce writer does not strip ?lat=&lng= before FocusFromNumbers / Globe fly.
 * Skips coords already consumed.
 */
export function mergeExplorerSearchWithFocus(
  explorerSearch: string,
  liveSearch: string,
  _opts?: { pathname?: string },
): string {
  const focus = parseMapFocusSearch(liveSearch)
  if (!focus) return explorerSearch
  if (isMapFocusConsumed(focusKey(focus.lat, focus.lng))) return explorerSearch
  const p = new URLSearchParams(explorerSearch)
  p.set('lat', focus.lat.toFixed(3))
  p.set('lng', focus.lng.toFixed(3))
  return p.toString()
}
