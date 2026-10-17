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
