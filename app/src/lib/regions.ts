/** Coarse macro-regions for educational catalog analysis (not political borders). */

export type MacroRegion =
  | 'europe'
  | 'middle_east'
  | 'north_africa'
  | 'sub_saharan_africa'
  | 'central_south_asia'
  | 'east_asia'
  | 'southeast_asia'
  | 'americas'
  | 'oceania'
  | 'other'

export const REGION_LABELS: Record<MacroRegion, string> = {
  europe: 'Europe',
  middle_east: 'Middle East',
  north_africa: 'North Africa',
  sub_saharan_africa: 'Sub-Saharan Africa',
  central_south_asia: 'Central & South Asia',
  east_asia: 'East Asia',
  southeast_asia: 'Southeast Asia',
  americas: 'Americas',
  oceania: 'Oceania',
  other: 'Other / polar',
}

/**
 * Assign a battle point to a macro-region.
 * Order matters: more specific boxes first (SE Asia before Oceania / East Asia).
 */
export function regionFor(lat: number, lng: number): MacroRegion {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'other'
  if (lat > 72 || lat < -55) return 'other'

  // Americas
  if (lng >= -170 && lng <= -25 && lat >= -56 && lat <= 72) return 'americas'

  // Middle East (Levant, Arabia, Iran, Anatolia east of Aegean core)
  if (lat >= 12 && lat <= 42 && lng >= 26 && lng <= 63) return 'middle_east'
  // Anatolia / Caucasus fringe often counted with ME strategic theater
  if (lat >= 36 && lat <= 43 && lng >= 26 && lng <= 45) return 'middle_east'

  // North Africa
  if (lat >= 15 && lat <= 37.5 && lng >= -17 && lng < 26) return 'north_africa'

  // Europe (after carving ME/NA)
  if (lat >= 36 && lat <= 72 && lng >= -25 && lng <= 40) return 'europe'
  if (lat >= 54 && lat <= 72 && lng >= 40 && lng <= 60) return 'europe' // NW Russia fringe

  // Southeast Asia before Oceania / East Asia (Hanoi, Surabaya, etc.)
  if (lat >= -10 && lat < 23 && lng >= 92 && lng <= 141) return 'southeast_asia'

  // East Asia
  if (lat >= 18 && lat <= 55 && lng >= 100 && lng <= 145) return 'east_asia'

  // Oceania (Australia / NZ / Pacific islands — after SE Asia carve-out)
  if (lat >= -50 && lat <= -10 && lng >= 110 && lng <= 180) return 'oceania'
  if (lat >= -50 && lat <= -10 && lng >= -180 && lng <= -150) return 'oceania'
  if (lat > -10 && lat <= 0 && lng >= 150 && lng <= 180) return 'oceania'

  // Central & South Asia
  if (lat >= 5 && lat <= 50 && lng >= 44 && lng < 100) return 'central_south_asia'

  // Sub-Saharan Africa
  if (lat >= -35 && lat < 15 && lng >= -20 && lng <= 52) return 'sub_saharan_africa'

  return 'other'
}
