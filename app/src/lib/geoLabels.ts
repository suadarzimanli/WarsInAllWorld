import type { War } from '../types'
import { tierLabel } from './data'

export type CoverageStats = {
  total: number
  withBattlePoints: number
  proxyOnly: number
  noMapLocation: number
}

/** Honest geo coverage from the war catalog (not centroid-file length alone). */
export function coverageStats(wars: War[]): CoverageStats {
  let withBattlePoints = 0
  let proxyOnly = 0
  for (const w of wars) {
    if ((w.battle_count ?? 0) > 0) withBattlePoints++
    else if (w.geo_source) proxyOnly++
  }
  return {
    total: wars.length,
    withBattlePoints,
    proxyOnly,
    noMapLocation: wars.length - withBattlePoints - proxyOnly,
  }
}

export function geoSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'battles':
      return 'Mean of linked battle points'
    case 'ucdp_centroid':
      return 'UCDP conflict centroid (summary, not battles)'
    case 'midloc_dyadic':
      return 'MIDLOC dispute proxy — not battle locations'
    case 'participant_centroid':
      return 'Mean of participant state centers — weak guess, not a battlefield'
    default:
      return source ? String(source) : 'No map location'
  }
}

export function geoSourceConfidence(source: string | null | undefined): 'high' | 'medium' | 'low' | 'none' {
  switch (source) {
    case 'battles':
      return 'high'
    case 'ucdp_centroid':
      return 'medium'
    case 'midloc_dyadic':
    case 'participant_centroid':
      return 'low'
    default:
      return 'none'
  }
}

/** Alias kept for Insights/About — same labels as explorer `tierLabel`. */
export function tierCoverageLabel(tier: string): string {
  return tierLabel(tier)
}

export function theaterQualityLabel(flag: string | null | undefined): string {
  switch (flag) {
    case 'ok':
      return 'OK — hull from several battle points'
    case 'sparse':
      return 'Sparse — few points; outline is rough'
    case 'single_point_buffer':
      return 'Single-point buffer — location known, extent invented'
    default:
      return flag ? String(flag) : 'Approximate theater'
  }
}

export function theaterMethodLabel(method: string | null | undefined): string {
  switch (method) {
    case 'concave_hull':
      return 'Concave hull'
    case 'convex_hull':
      return 'Convex hull'
    case 'buffer_merge':
      return 'Buffered points'
    default:
      return method ? String(method) : 'Derived outline'
  }
}

/** Human label for a war's death figure — COW and UCDP measure different things. */
export function deathEstimateLabel(source: string | null | undefined): string {
  switch (source) {
    case 'cow_battle_deaths':
      return 'Battle deaths (COW)'
    case 'ucdp_best_total':
      return 'Battle-related deaths, all years (UCDP best estimate)'
    default:
      return 'Death estimate'
  }
}

/**
 * Note shown when the map carries only a sample of a war's UCDP events.
 * Returns null when everything linked is on the map (or the war has no UCDP link).
 */
export function ucdpSampleNote(war: Pick<War, 'ucdp_events_total' | 'ucdp_events_shown'>): string | null {
  const total = war.ucdp_events_total ?? 0
  const shown = war.ucdp_events_shown ?? 0
  if (total <= 0 || shown >= total) return null
  return `Map shows ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} UCDP events (deadliest first). Totals use all events.`
}

/** Year span text; marks COW wars still ongoing when the source ends. */
export function warSpanLabel(
  war: Pick<War, 'start_year' | 'end_year' | 'ongoing_at_source_end' | 'span_from_battles'>,
  fmt: (y: number | null) => string,
): string {
  const span = `${fmt(war.start_year)} – ${fmt(war.end_year)}`
  if (war.ongoing_at_source_end) return `${span} (ongoing when source ends)`
  if (war.span_from_battles) return `${span} (from its battles; source gives one year)`
  return span
}
