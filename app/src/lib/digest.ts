import type { CatalogMeta, GeoJSONFeatureCollection, War } from '../types'
import { warOverlapsYears } from './data'
import { coverageStats, tierCoverageLabel } from './geoLabels'
import { pointLngLat } from './geoSafe'
import { REGION_LABELS, regionFor, type MacroRegion } from './regions'

export type DigestEraBucket = {
  id: string
  label: string
  wars: number
  withBattles: number
}

export type DigestTierRow = {
  tier: string
  label: string
  total: number
  withBattles: number
  proxy: number
  unmapped: number
}

export type DigestRegionRow = {
  region: MacroRegion
  label: string
  battlePoints: number
  share: number
}

export type DigestTopWar = {
  war_id: string
  title: string
  start_year: number | null
  end_year: number | null
  battle_count: number
  definition_tier: string
}

export type CatalogDigest = {
  totalWars: number
  withBattles: number
  proxyOnly: number
  unmapped: number
  battlePoints: number
  yearMin: number | null
  yearMax: number | null
  eras: DigestEraBucket[]
  tiers: DigestTierRow[]
  regions: DigestRegionRow[]
  topWars: DigestTopWar[]
  readTips: string[]
}

function eraLabel(bucket: string): string {
  switch (bucket) {
    case 'bce':
      return 'Before Common Era'
    case '0000_0499':
      return '0–499'
    case '0500_0999':
      return '500–999'
    case '1000_1499':
      return '1000–1499'
    case '1500_1799':
      return '1500–1799'
    case '1800_1899':
      return '1800–1899'
    case '1900_1999':
      return '1900–1999'
    case '2000_present':
      return '2000–present'
    default:
      return bucket.replace(/_/g, ' ') || 'Unknown era'
  }
}

function eraSortKey(id: string): number {
  const order = [
    'bce',
    '0000_0499',
    '0500_0999',
    '1000_1499',
    '1500_1799',
    '1800_1899',
    '1900_1999',
    '2000_present',
  ]
  const i = order.indexOf(id)
  return i < 0 ? 900 : i
}

function countBattlePoints(
  battles: GeoJSONFeatureCollection | null,
  yearFrom?: number | null,
  yearTo?: number | null,
): { total: number; byRegion: Map<MacroRegion, number>; byWarId: Map<string, number> } {
  const byRegion = new Map<MacroRegion, number>()
  const byWarId = new Map<string, number>()
  const seen = new Set<string>()
  let total = 0
  for (const f of battles?.features ?? []) {
    if (!f.geometry || f.geometry.type !== 'Point') continue
    const eid = f.properties?.event_id
    if (eid != null && eid !== '') {
      const id = String(eid)
      if (seen.has(id)) continue
      seen.add(id)
    }
    const yearRaw = f.properties?.year
    const year = yearRaw == null || yearRaw === '' ? null : Number(yearRaw)
    if (year != null && Number.isFinite(year)) {
      if (yearFrom != null && year < yearFrom) continue
      if (yearTo != null && year > yearTo) continue
    } else if (yearFrom != null || yearTo != null) {
      continue
    }
    const ll = pointLngLat(f.geometry)
    if (!ll) continue
    const [lng, lat] = ll
    const r = regionFor(lat, lng)
    byRegion.set(r, (byRegion.get(r) ?? 0) + 1)
    const wid = f.properties?.war_id
    if (wid != null && wid !== '') {
      const w = String(wid)
      byWarId.set(w, (byWarId.get(w) ?? 0) + 1)
    }
    total += 1
  }
  return { total, byRegion, byWarId }
}

export function buildCatalogDigest(
  wars: War[],
  battles: GeoJSONFeatureCollection | null,
  catalogMeta: CatalogMeta | null,
  opts?: { yearFrom?: number | null; yearTo?: number | null },
): CatalogDigest {
  const yearFrom = opts?.yearFrom ?? null
  const yearTo = opts?.yearTo ?? null
  const eraScoped = yearFrom != null || yearTo != null

  const inRange = (w: War) => {
    if (yearFrom == null && yearTo == null) return true
    return warOverlapsYears(
      w,
      yearFrom ?? Number.NEGATIVE_INFINITY,
      yearTo ?? Number.POSITIVE_INFINITY,
    )
  }

  const filtered = wars.filter(inRange)
  const cov = coverageStats(filtered)
  const { total: battlePoints, byRegion, byWarId } = countBattlePoints(battles, yearFrom, yearTo)

  const eraMap = new Map<string, DigestEraBucket>()
  for (const w of filtered) {
    const id = w.era_bucket || 'unknown'
    let row = eraMap.get(id)
    if (!row) {
      row = { id, label: eraLabel(id), wars: 0, withBattles: 0 }
      eraMap.set(id, row)
    }
    row.wars += 1
    const inEraPoints = byWarId.get(w.war_id) ?? 0
    const hasBattles = eraScoped ? inEraPoints > 0 : (w.battle_count ?? 0) > 0
    if (hasBattles) row.withBattles += 1
  }
  const eras = [...eraMap.values()].sort((a, b) => eraSortKey(a.id) - eraSortKey(b.id))

  const tierMeta = catalogMeta?.tier_coverage
  let tiers: DigestTierRow[] = []
  if (tierMeta && !eraScoped) {
    tiers = Object.entries(tierMeta)
      .map(([tier, c]) => ({
        tier,
        label: tierCoverageLabel(tier),
        total: c.total,
        withBattles: c.battles,
        proxy: c.proxy,
        unmapped: c.unmapped,
      }))
      .sort((a, b) => b.total - a.total)
  } else {
    const m = new Map<string, DigestTierRow>()
    for (const w of filtered) {
      const tier = w.definition_tier || 'unknown'
      let row = m.get(tier)
      if (!row) {
        row = {
          tier,
          label: tierCoverageLabel(tier),
          total: 0,
          withBattles: 0,
          proxy: 0,
          unmapped: 0,
        }
        m.set(tier, row)
      }
      row.total += 1
      const inEraPoints = byWarId.get(w.war_id) ?? 0
      if (eraScoped ? inEraPoints > 0 : (w.battle_count ?? 0) > 0) row.withBattles += 1
      else if (eraScoped ? w.geo_source && (w.battle_count ?? 0) === 0 : w.geo_source) row.proxy += 1
      else row.unmapped += 1
    }
    tiers = [...m.values()].sort((a, b) => b.total - a.total)
  }

  const regions: DigestRegionRow[] = [...byRegion.entries()]
    .map(([region, n]) => ({
      region,
      label: REGION_LABELS[region],
      battlePoints: n,
      share: battlePoints > 0 ? n / battlePoints : 0,
    }))
    .sort((a, b) => b.battlePoints - a.battlePoints)

  const topWars = [...filtered]
    .map((w) => {
      const scoped = byWarId.get(w.war_id) ?? 0
      const battle_count = eraScoped ? scoped : (w.battle_count ?? scoped)
      return {
        war_id: w.war_id,
        title: w.title,
        start_year: w.start_year,
        end_year: w.end_year,
        battle_count,
        definition_tier: w.definition_tier,
      }
    })
    .filter((w) => w.battle_count > 0)
    .sort((a, b) => b.battle_count - a.battle_count)
    .slice(0, 12)

  let yearMin: number | null = null
  let yearMax: number | null = null
  for (const w of filtered) {
    if (w.start_year != null) yearMin = yearMin == null ? w.start_year : Math.min(yearMin, w.start_year)
    const e = w.end_year ?? w.start_year
    if (e != null) yearMax = yearMax == null ? e : Math.max(yearMax, e)
  }

  let withBattles: number
  let proxyOnly: number
  let unmapped: number
  if (eraScoped) {
    withBattles = 0
    proxyOnly = 0
    unmapped = 0
    for (const w of filtered) {
      if ((byWarId.get(w.war_id) ?? 0) > 0) withBattles += 1
      // Proxy only if no in-window points and catalog has no battles (rough pin only)
      else if (w.geo_source && (w.battle_count ?? 0) === 0) proxyOnly += 1
      else unmapped += 1
    }
  } else {
    withBattles = cov.withBattlePoints
    proxyOnly = cov.proxyOnly
    unmapped = cov.noMapLocation
  }

  return {
    totalWars: cov.total,
    withBattles,
    proxyOnly,
    unmapped,
    battlePoints,
    yearMin,
    yearMax,
    eras,
    tiers,
    regions,
    topWars,
    readTips: [
      'Yellow dots are fights we have coordinates for.',
      'Heat is just how crowded those dots get — not how “important” a war was.',
      'Some wars only get a rough pin (country center, dispute proxy). The detail panel says so.',
      'Empty space often means we don’t have mapped battles yet, not that nothing happened.',
    ],
  }
}

export { formatYear as formatYearShort } from './data'
