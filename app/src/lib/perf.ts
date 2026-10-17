import { useEffect, useState } from 'react'
import type { GeoJSONFeatureCollection } from '../types'
import { pointLngLat } from './geoSafe'

/** Shared caps so Map and Globe show the same density for the same filters. */
const BATTLE_OVERVIEW_CAP = 2500
const BATTLE_OVERVIEW_STEP = 2500
export const BATTLE_OVERVIEW_SOFT_MAX = 12000
const BATTLE_FOCUS_CAP = 8000
export const MIDLOC_OVERVIEW_CAP = 1200
export const CENTROID_OVERVIEW_CAP = 2000
/** Cap heat source points so Absolute/Relative binning stays responsive. */
export const HEAT_POINT_SOFT_MAX = 25000

export type FilteredPoints = GeoJSONFeatureCollection & { truncated: boolean }

/** Prefer evenly spaced sample so overview stays readable. */
function sampleFeatures(
  features: GeoJSONFeatureCollection['features'],
  limit: number,
): GeoJSONFeatureCollection['features'] {
  if (features.length <= limit) return features
  const out: GeoJSONFeatureCollection['features'] = []
  const step = features.length / limit
  for (let i = 0; i < limit; i++) {
    out.push(features[Math.floor(i * step)]!)
  }
  return out
}

export function filterPointFeatures(
  fc: GeoJSONFeatureCollection | null,
  opts: {
    yearFrom: number
    yearTo: number
    selectedId?: string | null
    requireWarMatch?: boolean
    /** When set, keep only points whose war_id is in this set (orphans dropped). */
    warIds?: Set<string> | null
    /** Property used for year filtering. Default: "year" (events). Use start/end for wars. */
    yearMode?: 'event' | 'war_span'
    limit?: number
  },
): FilteredPoints | null {
  if (!fc) return null
  const selectedId = opts.selectedId ?? null
  const requireWarMatch = opts.requireWarMatch ?? Boolean(selectedId)
  const warIds = opts.warIds ?? null
  const matched: GeoJSONFeatureCollection['features'] = []
  for (const f of fc.features) {
    if (!pointLngLat(f.geometry)) continue
    if (opts.yearMode === 'war_span') {
      const start = f.properties?.start_year as number | null | undefined
      const end = (f.properties?.end_year as number | null | undefined) ?? start
      if (start == null) continue
      if (end! < opts.yearFrom || start > opts.yearTo) continue
    } else {
      const y = f.properties?.year as number | null | undefined
      const eitherFinite = Number.isFinite(opts.yearFrom) || Number.isFinite(opts.yearTo)
      if (y == null || !Number.isFinite(Number(y))) {
        if (eitherFinite) continue
      } else {
        if (Number.isFinite(opts.yearFrom) && (y as number) < opts.yearFrom) continue
        if (Number.isFinite(opts.yearTo) && (y as number) > opts.yearTo) continue
      }
    }
    const wid = f.properties?.war_id
    const widStr = wid == null || wid === '' ? null : String(wid)
    if (requireWarMatch && selectedId && widStr !== selectedId) continue
    if (warIds) {
      if (!widStr || !warIds.has(widStr)) continue
    }
    matched.push(f)
  }
  const limit = opts.limit
  const truncated = limit != null && matched.length > limit
  const features = limit != null ? sampleFeatures(matched, limit) : matched
  return { type: 'FeatureCollection', features, truncated }
}

/** Debounce a rapidly changing value (year sliders, search). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

/** Grow overview battle sample over time so the map fills in without freezing. */
export function useProgressiveBattleCap(selectedId: string | null, resetKey: string): number {
  const [cap, setCap] = useState(BATTLE_OVERVIEW_CAP)
  useEffect(() => {
    if (selectedId) {
      setCap(BATTLE_FOCUS_CAP)
      return
    }
    setCap(BATTLE_OVERVIEW_CAP)
    const id = window.setInterval(() => {
      setCap((c) => {
        if (c >= BATTLE_OVERVIEW_SOFT_MAX) {
          window.clearInterval(id)
          return c
        }
        return Math.min(c + BATTLE_OVERVIEW_STEP, BATTLE_OVERVIEW_SOFT_MAX)
      })
    }, 450)
    return () => window.clearInterval(id)
  }, [selectedId, resetKey])
  return selectedId ? BATTLE_FOCUS_CAP : cap
}
