import type { GeoJSONFeatureCollection } from '../types'

export type WarBattleStats = {
  /** mapped battles per year */
  byYear: Map<number, number>
  /** mapped battles per source dataset (hced, war_atlas, ucdp, …) */
  bySource: Map<string, number>
  total: number
}

/** One pass over all battle points → per-war stats (for the details card). */
export function indexWarBattles(battles: GeoJSONFeatureCollection | null): Map<string, WarBattleStats> {
  const out = new Map<string, WarBattleStats>()
  for (const f of battles?.features ?? []) {
    const p = f.properties ?? {}
    const id = p.war_id == null ? '' : String(p.war_id)
    if (!id) continue
    let s = out.get(id)
    if (!s) {
      s = { byYear: new Map(), bySource: new Map(), total: 0 }
      out.set(id, s)
    }
    s.total++
    const y = p.year
    if (typeof y === 'number' && Number.isFinite(y)) s.byYear.set(y, (s.byYear.get(y) ?? 0) + 1)
    const src = p.source == null ? 'unknown' : String(p.source)
    s.bySource.set(src, (s.bySource.get(src) ?? 0) + 1)
  }
  return out
}

export type YearBin = { from: number; to: number; count: number }

/**
 * Bins for the battles-per-year chart: one bar per year for short wars, wider
 * bins (2, 5, 10, 25, 50, 100 years) for long ones, at most `maxBars` bars.
 */
export function yearBins(byYear: Map<number, number>, start: number, end: number, maxBars = 24): YearBin[] {
  const years = [...byYear.keys()]
  let a = Math.min(start, ...years)
  let b = Math.max(end, ...years)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return []
  a = Math.floor(a)
  b = Math.floor(b)
  const span = b - a + 1
  const width = [1, 2, 5, 10, 25, 50, 100, 250, 500].find((w) => Math.ceil(span / w) <= maxBars) ?? Math.ceil(span / maxBars)
  // Align wider bins to round years (e.g. decades)
  const first = width === 1 ? a : Math.floor(a / width) * width
  const bins: YearBin[] = []
  for (let lo = first; lo <= b; lo += width) bins.push({ from: lo, to: lo + width - 1, count: 0 })
  for (const [y, c] of byYear) {
    const i = Math.floor((y - first) / width)
    if (bins[i]) bins[i]!.count += c
  }
  return bins
}

export const SOURCE_LABELS: Record<string, string> = {
  hced: 'HCED',
  war_atlas: 'War Atlas',
  ucdp: 'UCDP GED',
  cow: 'COW',
  midloc: 'MIDLOC',
}
export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s.replace(/_/g, ' ')
