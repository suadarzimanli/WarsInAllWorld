import type {
  CatalogMeta,
  CitationDataset,
  CoverageMode,
  DefinitionMode,
  GeoJSONFeatureCollection,
  ProgressSnapshot,
  War,
} from '../types'

const EMPTY_FC: GeoJSONFeatureCollection = { type: 'FeatureCollection', features: [] }

/** Resolve `data/...` under Vite `base` (needed for GitHub project Pages). */
function dataPath(name: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const root = base.endsWith('/') ? base : `${base}/`
  return `${root}data/${name}`
}

export async function loadWars(): Promise<War[]> {
  const res = await fetch(dataPath('wars.json'))
  if (!res.ok) throw new Error('Failed to load wars.json — run python scripts/run_etl.py first')
  const raw = await res.json()
  if (!Array.isArray(raw)) throw new Error('wars.json is not an array')
  const wars = raw as War[]
  // Guard against duplicate war_id keys in the UI list
  const seen = new Set<string>()
  return wars
    .map((w) => ({
      ...w,
      title: displayLabel(w.title),
      participant_summary: w.participant_summary ? displayLabel(w.participant_summary) : w.participant_summary,
      sources: displayLabel(w.sources),
    }))
    .filter((w) => {
      if (!w.war_id || seen.has(w.war_id)) return false
      seen.add(w.war_id)
      return true
    })
}

/** Load GeoJSON; on failure return an empty collection so one bad layer does not blank the app. */
export async function loadGeoJSON(name: string): Promise<GeoJSONFeatureCollection> {
  try {
    const res = await fetch(dataPath(name))
    if (!res.ok) {
      console.warn(`Failed to load ${name} (${res.status})`)
      return EMPTY_FC
    }
    const fc = (await res.json()) as GeoJSONFeatureCollection
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
      console.warn(`${name} is not a FeatureCollection`)
      return EMPTY_FC
    }
    for (const f of fc.features) {
      if (!f?.properties) continue
      for (const [k, v] of Object.entries(f.properties)) {
        if (typeof v === 'string') f.properties[k] = displayLabel(v)
      }
    }
    return fc
  } catch (e) {
    console.warn(`Failed to load ${name}`, e)
    return EMPTY_FC
  }
}

export async function loadCitations(): Promise<CitationDataset[]> {
  try {
    const res = await fetch(dataPath('citations.json'))
    if (!res.ok) return []
    const raw = (await res.json()) as { datasets?: CitationDataset[] }
    return Array.isArray(raw.datasets) ? raw.datasets : []
  } catch {
    return []
  }
}

export async function loadCatalogMeta(): Promise<CatalogMeta | null> {
  try {
    const res = await fetch(dataPath('catalog_meta.json'))
    if (!res.ok) return null
    return (await res.json()) as CatalogMeta
  } catch {
    return null
  }
}

export async function loadProgressHistory(): Promise<ProgressSnapshot[]> {
  try {
    const res = await fetch(dataPath('progress_history.json'))
    if (!res.ok) return []
    const raw = (await res.json()) as ProgressSnapshot[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/** Never show the banned place-name; use "Kurdish Groups" instead. */
function displayLabel(text: string | null | undefined): string {
  if (text == null) return ''
  return String(text).replace(/Kurdistan/gi, 'Kurdish Groups')
}

function warActiveInRange(war: War, yearFrom: number, yearTo: number): boolean {
  if (war.start_year == null) return false
  const end = war.end_year ?? war.start_year
  return !(end < yearFrom || war.start_year > yearTo)
}

/** Exported for digest / shared year-span checks. */
export function warOverlapsYears(war: War, yearFrom: number, yearTo: number): boolean {
  return warActiveInRange(war, yearFrom, yearTo)
}

export type WarSort = 'year_asc' | 'year_desc' | 'title' | 'battles'

export const DEFINITION_MODES: Array<{
  id: DefinitionMode
  label: string
  hint: string
}> = [
  {
    id: 'all',
    label: 'All sources',
    hint: 'Every war record in this atlas (mixed definitions — compare carefully).',
  },
  {
    id: 'cow_strict',
    label: 'COW',
    hint: 'Correlates of War formal wars only (1816+). Many lack battle points on the map.',
  },
  {
    id: 'named',
    label: 'Named',
    hint: 'HCED battle-linked names and War Atlas curated wars (encyclopedia-style).',
  },
  {
    id: 'warlike_ucdp',
    label: 'Warlike',
    hint: 'COW wars plus UCDP conflicts with ≥1,000 battle-related deaths in at least one calendar year.',
  },
]

export function tierLabel(tier: string): string {
  switch (tier) {
    case 'cow_war':
      return 'COW'
    case 'atlas_curated':
      return 'Atlas'
    case 'hced_war_string':
      return 'HCED'
    case 'ucdp_warlike':
      return 'UCDP warlike'
    case 'ucdp_conflict':
      return 'UCDP'
    case 'named_encyclopedia':
      return 'Named'
    default:
      return tier.replace(/_/g, ' ')
  }
}

export const COVERAGE_MODES: Array<{ id: CoverageMode; label: string; hint: string }> = [
  { id: 'all', label: 'Any geo', hint: 'All wars, including those with no map location.' },
  {
    id: 'has_battles',
    label: 'Has battles',
    hint: 'Only wars with mapped battle/combat events (usable in heat & gold points).',
  },
  {
    id: 'proxy_only',
    label: 'Proxy only',
    hint: 'Weak location only (MIDLOC / UCDP / participant centroid) — no battle points.',
  },
  {
    id: 'unmapped',
    label: 'Unmapped',
    hint: 'No battle points and no location proxy yet (many COW-only wars).',
  },
]

export function warCoverageBucket(war: War): 'has_battles' | 'proxy_only' | 'unmapped' {
  if ((war.battle_count ?? 0) > 0) return 'has_battles'
  if (war.geo_source) return 'proxy_only'
  return 'unmapped'
}

export function filterWars(
  wars: War[],
  opts: {
    yearFrom: number
    yearTo: number
    query: string
    mode: DefinitionMode
    coverage?: CoverageMode
    sort?: WarSort
  },
): War[] {
  const q = opts.query.trim().toLowerCase()
  const coverage = opts.coverage ?? 'all'
  const list = wars
    .filter((w) => warActiveInRange(w, opts.yearFrom, opts.yearTo))
    .filter((w) => {
      if (opts.mode === 'cow_strict') return w.definition_tier === 'cow_war'
      if (opts.mode === 'named')
        return (
          w.definition_tier === 'atlas_curated' ||
          w.definition_tier === 'hced_war_string' ||
          w.definition_tier === 'named_encyclopedia'
        )
      if (opts.mode === 'warlike_ucdp')
        return w.definition_tier === 'ucdp_warlike' || w.definition_tier === 'cow_war'
      return true
    })
    .filter((w) => {
      if (coverage === 'all') return true
      return warCoverageBucket(w) === coverage
    })
    .filter((w) => !q || w.title.toLowerCase().includes(q) || w.war_id.toLowerCase().includes(q))

  const sort = opts.sort ?? 'year_asc'
  return list.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title)
    if (sort === 'battles')
      return (b.battle_count ?? 0) - (a.battle_count ?? 0) || (a.start_year ?? 0) - (b.start_year ?? 0)
    if (sort === 'year_desc') return (b.start_year ?? 0) - (a.start_year ?? 0)
    return (a.start_year ?? 0) - (b.start_year ?? 0)
  })
}

export function formatYear(y: number | null): string {
  if (y == null || !Number.isFinite(y)) return '?'
  if (y < 0) return `${Math.abs(y)} BCE`
  return String(y)
}

export function yearLabel(y: number): string {
  if (!Number.isFinite(y)) return '…'
  return y < 0 ? `${Math.abs(y)} BCE` : String(y)
}

/**
 * Parse a year field from the explorer. Ellipsis / empty / non-numeric keep
 * `fallback` (including ±Infinity for “all years”). Never treat Number('') as 0.
 * Callers that want empty → open end should check empty text before calling.
 */
export function parseYearInput(raw: string, fallback: number): number {
  const t = raw.trim()
  if (!t || t === '…' || t === '...') return fallback
  const upper = t.toUpperCase()
  // Require BC/BCE as a token — avoid false positives like "1945CBC"
  const bce = /(?:^|[^A-Z0-9])B\.?C\.?E?(?:[^A-Z0-9]|$)/.test(upper)
  const digits = t.replace(/[^\d-]/g, '')
  if (!digits || digits === '-' || digits === '--') return fallback
  const n = Number(digits)
  if (!Number.isFinite(n)) return fallback
  if (bce) return -Math.abs(n)
  return n
}

/** True when the explorer shows the full catalog year span (both ends open or clamped to catalog). */
export function isAllYearsRange(
  yearFrom: number,
  yearTo: number,
  yearMin: number,
  yearMax: number,
): boolean {
  return (
    (!Number.isFinite(yearFrom) && !Number.isFinite(yearTo)) ||
    (yearFrom <= yearMin && yearTo >= yearMax)
  )
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
