import type { AppLayers, CoverageMode, DefinitionMode, DisplayMode, HeatScaleMode } from '../types'

export type UrlExplorerState = {
  yearFrom?: number
  yearTo?: number
  /** URL has to= but no from= → from is open (−∞) */
  yearFromOpen?: boolean
  /** URL has from= but no to= → to is open (+∞) */
  yearToOpen?: boolean
  /** Explicit all-years sentinel from Numbers (`years=all`) */
  yearsAll?: boolean
  query?: string
  mode?: DefinitionMode
  coverage?: CoverageMode
  displayMode?: DisplayMode
  heatScale?: HeatScaleMode
  selectedId?: string | null
  layers?: Partial<AppLayers>
}

const DEFINITION_MODE_IDS: DefinitionMode[] = ['all', 'cow_strict', 'named', 'warlike_ucdp']
const DISPLAY_MODE_IDS: DisplayMode[] = ['points', 'heatmap']
const COVERAGE_MODE_IDS: CoverageMode[] = ['all', 'has_battles', 'proxy_only', 'unmapped']
const HEAT_SCALE_IDS: HeatScaleMode[] = ['relative', 'absolute']
const LAYER_KEYS: (keyof AppLayers)[] = ['battles', 'theaters', 'midloc', 'centroids']

function parseNum(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function isCoverageMode(v: unknown): v is CoverageMode {
  return typeof v === 'string' && COVERAGE_MODE_IDS.includes(v as CoverageMode)
}

function isHeatScale(v: unknown): v is HeatScaleMode {
  return typeof v === 'string' && HEAT_SCALE_IDS.includes(v as HeatScaleMode)
}

function isDefinitionMode(v: unknown): v is DefinitionMode {
  return typeof v === 'string' && DEFINITION_MODE_IDS.includes(v as DefinitionMode)
}

function isDisplayMode(v: unknown): v is DisplayMode {
  return typeof v === 'string' && DISPLAY_MODE_IDS.includes(v as DisplayMode)
}

/** Sanitize a partial explorer snapshot from sessionStorage / URL merge. */
export function sanitizeExplorerPartial(raw: Record<string, unknown> | null | undefined): UrlExplorerState {
  if (!raw || typeof raw !== 'object') return {}
  const out: UrlExplorerState = {}

  const yf = raw.yearFrom
  const yt = raw.yearTo
  if (typeof yf === 'number' && Number.isFinite(yf)) out.yearFrom = yf
  if (typeof yt === 'number' && Number.isFinite(yt)) out.yearTo = yt
  if (typeof raw.query === 'string') out.query = raw.query
  if (isDefinitionMode(raw.mode)) out.mode = raw.mode
  if (isCoverageMode(raw.coverage)) out.coverage = raw.coverage
  if (isDisplayMode(raw.displayMode)) out.displayMode = raw.displayMode
  if (isHeatScale(raw.heatScale)) out.heatScale = raw.heatScale
  if (raw.selectedId === null) out.selectedId = null
  else if (typeof raw.selectedId === 'string' && raw.selectedId) out.selectedId = raw.selectedId

  if (raw.layers && typeof raw.layers === 'object') {
    const L = raw.layers as Record<string, unknown>
    const layers: Partial<AppLayers> = {}
    for (const k of LAYER_KEYS) {
      if (typeof L[k] === 'boolean') layers[k] = L[k]
    }
    if (Object.keys(layers).length) out.layers = layers
  }

  return out
}

/** Read explorer state from the current URL query string (only defined keys). */
export function readExplorerUrl(search = window.location.search): UrlExplorerState | null {
  const p = new URLSearchParams(search)
  if (![...p.keys()].length) return null

  const out: UrlExplorerState = {}

  if (p.get('years') === 'all') {
    out.yearsAll = true
    out.yearFromOpen = true
    out.yearToOpen = true
  }

  const from = parseNum(p.get('from'))
  const to = parseNum(p.get('to'))
  if (!out.yearsAll) {
    if (from != null) out.yearFrom = from
    if (to != null) out.yearTo = to
    // One-sided open from *parsed* values (invalid/empty from= is treated as absent)
    if (to != null && from == null) out.yearFromOpen = true
    if (from != null && to == null) out.yearToOpen = true
    // Normalize inverted ranges from bad links
    if (out.yearFrom != null && out.yearTo != null && out.yearFrom > out.yearTo) {
      const tmp = out.yearFrom
      out.yearFrom = out.yearTo
      out.yearTo = tmp
    }
  }

  if (p.has('q')) out.query = p.get('q') ?? ''

  const modeRaw = p.get('mode')
  if (modeRaw && isDefinitionMode(modeRaw)) out.mode = modeRaw

  const covRaw = p.get('geo')
  if (covRaw && isCoverageMode(covRaw)) out.coverage = covRaw

  const displayRaw = p.get('display')
  if (displayRaw && isDisplayMode(displayRaw)) out.displayMode = displayRaw

  const heatRaw = p.get('heat')
  if (heatRaw && isHeatScale(heatRaw)) out.heatScale = heatRaw

  const layersRaw = p.get('layers')
  if (layersRaw != null && layersRaw !== '') {
    const set = new Set(layersRaw.split(',').map((s) => s.trim()).filter(Boolean))
    const known = LAYER_KEYS.filter((k) => set.has(k))
    // Ignore garbage like ?layers=bogus so we don't turn everything off
    if (known.length > 0 || set.size === 0) {
      out.layers = {
        battles: set.has('battles'),
        theaters: set.has('theaters'),
        midloc: set.has('midloc'),
        centroids: set.has('centroids'),
      }
    }
  }

  // Missing `war` → omit (keep session). Explicit empty → clear.
  if (p.has('war')) {
    const war = p.get('war')
    out.selectedId = war ? war : null
  }

  return out
}

/** Build a shareable query string (no leading ?). */
export function buildExplorerSearch(opts: {
  yearFrom: number
  yearTo: number
  yearMin: number
  yearMax: number
  query: string
  mode: DefinitionMode
  coverage: CoverageMode
  displayMode: DisplayMode
  heatScale: HeatScaleMode
  selectedId: string | null
  layers: AppLayers
}): string {
  const p = new URLSearchParams()
  const fromOpen = !Number.isFinite(opts.yearFrom)
  const toOpen = !Number.isFinite(opts.yearTo)
  // Persist all-years so remount/share does not revive session year filters
  if (fromOpen && toOpen) {
    p.set('years', 'all')
  } else {
    if (Number.isFinite(opts.yearFrom) && opts.yearFrom > opts.yearMin) {
      p.set('from', String(Math.round(opts.yearFrom)))
    }
    if (Number.isFinite(opts.yearTo) && opts.yearTo < opts.yearMax) {
      p.set('to', String(Math.round(opts.yearTo)))
    }
  }
  if (opts.query.trim()) p.set('q', opts.query.trim())
  if (opts.mode !== 'all') p.set('mode', opts.mode)
  if (opts.coverage !== 'all') p.set('geo', opts.coverage)
  if (opts.displayMode !== 'points') p.set('display', opts.displayMode)
  if (opts.heatScale !== 'relative') p.set('heat', opts.heatScale)
  if (opts.selectedId) p.set('war', opts.selectedId)

  const on = (Object.keys(opts.layers) as (keyof AppLayers)[]).filter((k) => opts.layers[k])
  const defaultsOn: (keyof AppLayers)[] = ['battles', 'theaters']
  const isDefault =
    on.length === defaultsOn.length && defaultsOn.every((k) => on.includes(k))
  if (!isDefault) p.set('layers', on.join(','))

  return p.toString()
}

export function explorerShareUrl(pathname: string, search: string): string {
  const base = `${window.location.origin}${pathname}`
  return search ? `${base}?${search}` : base
}

export type FullExplorerUrlState = {
  yearFrom: number
  yearTo: number
  query: string
  mode: DefinitionMode
  coverage: CoverageMode
  displayMode: DisplayMode
  heatScale: HeatScaleMode
  selectedId: string | null
  layers: AppLayers
}

const DEFAULT_URL_LAYERS: AppLayers = {
  battles: true,
  theaters: true,
  midloc: false,
  centroids: false,
}

/**
 * Full snapshot from a URL search string for history POP / external navigation.
 * Empty search → catalog defaults (not “keep previous state”).
 */
export function fullExplorerStateFromSearch(search: string): FullExplorerUrlState {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const p = new URLSearchParams(raw)
  if (![...p.keys()].length) {
    return {
      yearFrom: Number.NEGATIVE_INFINITY,
      yearTo: Number.POSITIVE_INFINITY,
      query: '',
      mode: 'all',
      coverage: 'all',
      displayMode: 'points',
      heatScale: 'relative',
      selectedId: null,
      layers: { ...DEFAULT_URL_LAYERS },
    }
  }
  const fromUrl = readExplorerUrl(search.startsWith('?') ? search : `?${search}`) ?? {}
  let yearFrom = Number.NEGATIVE_INFINITY
  let yearTo = Number.POSITIVE_INFINITY
  if (fromUrl.yearsAll || (fromUrl.yearFromOpen && fromUrl.yearToOpen)) {
    yearFrom = Number.NEGATIVE_INFINITY
    yearTo = Number.POSITIVE_INFINITY
  } else {
    if (fromUrl.yearFromOpen) yearFrom = Number.NEGATIVE_INFINITY
    else if (fromUrl.yearFrom != null) yearFrom = fromUrl.yearFrom
    if (fromUrl.yearToOpen) yearTo = Number.POSITIVE_INFINITY
    else if (fromUrl.yearTo != null) yearTo = fromUrl.yearTo
  }
  // War deep-link without years → open span so selection is not auto-filtered out
  if (
    fromUrl.selectedId &&
    fromUrl.yearFrom == null &&
    fromUrl.yearTo == null &&
    !fromUrl.yearFromOpen &&
    !fromUrl.yearToOpen &&
    !fromUrl.yearsAll
  ) {
    yearFrom = Number.NEGATIVE_INFINITY
    yearTo = Number.POSITIVE_INFINITY
  }
  return {
    yearFrom,
    yearTo,
    query: fromUrl.query ?? '',
    mode: fromUrl.mode ?? 'all',
    coverage: fromUrl.coverage ?? 'all',
    displayMode: fromUrl.displayMode ?? 'points',
    heatScale: fromUrl.heatScale ?? 'relative',
    selectedId: fromUrl.selectedId !== undefined ? fromUrl.selectedId : null,
    layers: fromUrl.layers ? { ...DEFAULT_URL_LAYERS, ...fromUrl.layers } : { ...DEFAULT_URL_LAYERS },
  }
}
