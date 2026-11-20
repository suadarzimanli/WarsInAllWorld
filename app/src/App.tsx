import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AboutAtlas } from './components/AboutAtlas'
import { AtlasLegend } from './components/AtlasLegend'
import { DisplayModeSwitch } from './components/DisplayModeSwitch'
import { InsightsPage } from './components/InsightsPage'
import { WarChrome } from './components/WarChrome'
import { WarMap } from './components/WarMap'
import { WarGlobe } from './components/WarGlobe'
import { filterWars, loadCatalogMeta, loadCitations, loadGeoJSON, loadProgressHistory, loadWars } from './lib/data'
import { coverageStats } from './lib/geoLabels'
import { useProgressiveBattleCap } from './lib/perf'
import { buildExplorerSearch, fullExplorerStateFromSearch, readExplorerUrl, sanitizeExplorerPartial } from './lib/urlState'
import {
  eraExplorerSearch,
  mergeExplorerSearchWithFocus,
  normalizePath,
  readInsightsUrl,
  stripMapFocusSearch,
} from './lib/insightsUrl'
import { ErrorBoundary } from './components/ErrorBoundary'
import type {
  AppLayers,
  CatalogMeta,
  CitationDataset,
  CoverageMode,
  DefinitionMode,
  DisplayMode,
  GeoJSONFeatureCollection,
  HeatScaleMode,
  ProgressSnapshot,
  War,
} from './types'

type ExplorerSnapshot = {
  yearFrom: number
  yearTo: number
  query: string
  mode: DefinitionMode
  coverage: CoverageMode
  displayMode: DisplayMode
  heatScale: HeatScaleMode
  selectedId: string | null
  layers: AppLayers
  sidebarOpen: boolean
}

const DEFAULT_LAYERS: AppLayers = {
  battles: true,
  theaters: true,
  midloc: false,
  centroids: false,
}

const SHARED_STORAGE_KEY = 'wiaw:explorer'
const ABOUT_SEEN_KEY = 'wiaw:about-seen'

function loadSnapshot(): Partial<ExplorerSnapshot> | null {
  try {
    const raw =
      sessionStorage.getItem(SHARED_STORAGE_KEY) ??
      sessionStorage.getItem('wiaw:explorer:map') ??
      sessionStorage.getItem('wiaw:explorer:globe')
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Old default was 1800–2025; treat that as "all years"
    if (parsed.yearFrom === 1800 && parsed.yearTo === 2025) {
      delete parsed.yearFrom
      delete parsed.yearTo
    }
    const clean = sanitizeExplorerPartial(parsed)
    const out: Partial<ExplorerSnapshot> = {}
    if (clean.yearFrom != null) out.yearFrom = clean.yearFrom
    if (clean.yearTo != null) out.yearTo = clean.yearTo
    if (clean.query != null) out.query = clean.query
    if (clean.mode != null) out.mode = clean.mode
    if (clean.coverage != null) out.coverage = clean.coverage
    if (clean.displayMode != null) out.displayMode = clean.displayMode
    if (clean.heatScale != null) out.heatScale = clean.heatScale
    if (clean.selectedId !== undefined) out.selectedId = clean.selectedId
    if (clean.layers) out.layers = { ...DEFAULT_LAYERS, ...clean.layers }
    if (typeof parsed.sidebarOpen === 'boolean') out.sidebarOpen = parsed.sidebarOpen
    return out
  } catch {
    return null
  }
}

function saveSnapshot(snap: ExplorerSnapshot) {
  try {
    const payload = {
      ...snap,
      yearFrom: Number.isFinite(snap.yearFrom) ? snap.yearFrom : null,
      yearTo: Number.isFinite(snap.yearTo) ? snap.yearTo : null,
    }
    sessionStorage.setItem(SHARED_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* ignore quota */
  }
}

/** Shared filters for Map + Globe so both views always show the same data. */
function useExplorerState(wars: War[]) {
  const location = useLocation()
  const navigate = useNavigate()
  const saved = useMemo(() => {
    const fromSession = loadSnapshot() ?? {}
    const fromUrl = readExplorerUrl() ?? {}
    // Explicit all-years from Numbers — drop session year filters (+ stale war/query)
    if (fromUrl.yearsAll) {
      const rest = { ...fromSession }
      delete rest.yearFrom
      delete rest.yearTo
      if (fromUrl.selectedId == null) delete rest.selectedId
      if (fromUrl.query == null) delete rest.query
      return { ...rest, ...fromUrl }
    }
    // War deep-link without from/to → clear session years so selection is not auto-dropped
    if (
      fromUrl.selectedId &&
      fromUrl.yearFrom == null &&
      fromUrl.yearTo == null &&
      !fromUrl.yearFromOpen &&
      !fromUrl.yearToOpen &&
      !fromUrl.yearsAll
    ) {
      const rest = { ...fromSession }
      delete rest.yearFrom
      delete rest.yearTo
      return { ...rest, ...fromUrl }
    }
    // One-sided year URL clears the open side from session (+ stale war/query if omitted)
    if (fromUrl.yearFromOpen || fromUrl.yearToOpen) {
      const rest = { ...fromSession }
      if (fromUrl.yearFromOpen) delete rest.yearFrom
      if (fromUrl.yearToOpen) delete rest.yearTo
      if (fromUrl.selectedId == null) delete rest.selectedId
      if (fromUrl.query == null) delete rest.query
      return { ...rest, ...fromUrl }
    }
    // Sparse URL merge — undefined URL fields must not wipe session
    return { ...fromSession, ...fromUrl }
  }, [])

  const yearMin = useMemo(() => {
    const ys = wars.map((w) => w.start_year).filter((y): y is number => y != null)
    return ys.length ? Math.min(...ys) : -1500
  }, [wars])
  const yearMax = useMemo(() => {
    const ys = wars.map((w) => w.end_year ?? w.start_year).filter((y): y is number => y != null)
    return ys.length ? Math.max(...ys) : 2025
  }, [wars])

  const [yearFrom, setYearFrom] = useState(() => {
    if (saved.yearsAll || saved.yearFromOpen) return Number.NEGATIVE_INFINITY
    if (saved.yearFrom != null && Number.isFinite(saved.yearFrom)) return saved.yearFrom
    return Number.NEGATIVE_INFINITY
  })
  const [yearTo, setYearTo] = useState(() => {
    if (saved.yearsAll || saved.yearToOpen) return Number.POSITIVE_INFINITY
    if (saved.yearTo != null && Number.isFinite(saved.yearTo)) return saved.yearTo
    return Number.POSITIVE_INFINITY
  })
  const [query, setQuery] = useState(() => saved.query ?? '')
  const [mode, setMode] = useState<DefinitionMode>(() => saved.mode ?? 'all')
  const [coverage, setCoverage] = useState<CoverageMode>(() => saved.coverage ?? 'all')
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => saved.displayMode ?? 'points')
  const [heatScale, setHeatScale] = useState<HeatScaleMode>(() => saved.heatScale ?? 'relative')
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    saved.selectedId !== undefined ? saved.selectedId : null,
  )
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (saved.sidebarOpen != null) return saved.sidebarOpen
    // Phones/tablets: start collapsed so the map/globe is usable immediately
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches) {
      return false
    }
    return true
  })

  // Entering a narrow viewport: collapse explorer so the map stays primary
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)')
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setSidebarOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const [layers, setLayers] = useState<AppLayers>(() => ({
    ...DEFAULT_LAYERS,
    ...(saved.layers ?? {}),
  }))

  // Only clamp finite years — keep ±Infinity as "all years"
  useEffect(() => {
    if (!wars.length) return
    setYearFrom((y) => {
      if (!Number.isFinite(y)) return y
      return Math.min(Math.max(y, yearMin), yearMax)
    })
    setYearTo((y) => {
      if (!Number.isFinite(y)) return y
      return Math.min(Math.max(y, yearMin), yearMax)
    })
  }, [wars, yearMin, yearMax])

  // Keep from <= to when both are finite
  useEffect(() => {
    if (!Number.isFinite(yearFrom) || !Number.isFinite(yearTo)) return
    if (yearFrom > yearTo) {
      setYearFrom(yearTo)
      setYearTo(yearFrom)
    }
  }, [yearFrom, yearTo])

  // Apply deep-link / back-forward query changes while explorer stays mounted.
  // Writer self-replaces set lastSearchApplied first — those are skipped.
  // Focus strip (lat/lng only) is ignored via stripMapFocusSearch compare.
  const lastSearchApplied = useRef<string | null>(null)
  useEffect(() => {
    if (lastSearchApplied.current === null) {
      lastSearchApplied.current = location.search
      return
    }
    if (location.search === lastSearchApplied.current) return
    const prev = lastSearchApplied.current
    lastSearchApplied.current = location.search
    if (stripMapFocusSearch(prev) === stripMapFocusSearch(location.search)) return

    const snap = fullExplorerStateFromSearch(location.search)
    setYearFrom(snap.yearFrom)
    setYearTo(snap.yearTo)
    setQuery(snap.query)
    setMode(snap.mode)
    setCoverage(snap.coverage)
    setDisplayMode(snap.displayMode)
    setHeatScale(snap.heatScale)
    setSelectedId(snap.selectedId)
    setLayers(snap.layers)
  }, [location.search])

  const snapRef = useRef({
    yearFrom,
    yearTo,
    query,
    mode,
    coverage,
    displayMode,
    heatScale,
    selectedId,
    layers,
    sidebarOpen,
    yearMin,
    yearMax,
    pathname: location.pathname,
    search: location.search,
  })
  snapRef.current = {
    yearFrom,
    yearTo,
    query,
    mode,
    coverage,
    displayMode,
    heatScale,
    selectedId,
    layers,
    sidebarOpen,
    yearMin,
    yearMax,
    pathname: location.pathname,
    search: location.search,
  }

  const writeExplorerUrl = useCallback(
    (snap: typeof snapRef.current) => {
      const search = buildExplorerSearch({
        yearFrom: snap.yearFrom,
        yearTo: snap.yearTo,
        yearMin: snap.yearMin,
        yearMax: snap.yearMax,
        query: snap.query,
        mode: snap.mode,
        coverage: snap.coverage,
        displayMode: snap.displayMode,
        heatScale: snap.heatScale,
        selectedId: snap.selectedId,
        layers: snap.layers,
      })
      // Keep one-shot ?lat=&lng= until Focus flies (never on Globe; never if consumed)
      const qs = mergeExplorerSearchWithFocus(search, snap.search || window.location.search, {
        pathname: snap.pathname,
      })
      const nextSearch = qs ? `?${qs}` : ''
      const next = `${snap.pathname}${nextSearch}`
      const cur = `${window.location.pathname}${window.location.search}`
      if (next === cur) return
      lastSearchApplied.current = nextSearch
      navigate({ pathname: snap.pathname, search: nextSearch }, { replace: true })
    },
    [navigate],
  )

  useEffect(() => {
    const id = window.setTimeout(() => {
      const snap = snapRef.current
      saveSnapshot({
        yearFrom: snap.yearFrom,
        yearTo: snap.yearTo,
        query: snap.query,
        mode: snap.mode,
        coverage: snap.coverage,
        displayMode: snap.displayMode,
        heatScale: snap.heatScale,
        selectedId: snap.selectedId,
        layers: snap.layers,
        sidebarOpen: snap.sidebarOpen,
      })
      writeExplorerUrl(snap)
    }, 250)
    return () => window.clearTimeout(id)
  }, [
    yearFrom,
    yearTo,
    yearMin,
    yearMax,
    query,
    mode,
    coverage,
    displayMode,
    heatScale,
    selectedId,
    layers,
    sidebarOpen,
    location.pathname,
    writeExplorerUrl,
  ])

  // Flush session only on unmount (avoid Strict Mode URL navigate churn).
  useEffect(() => {
    return () => {
      const snap = snapRef.current
      saveSnapshot({
        yearFrom: snap.yearFrom,
        yearTo: snap.yearTo,
        query: snap.query,
        mode: snap.mode,
        coverage: snap.coverage,
        displayMode: snap.displayMode,
        heatScale: snap.heatScale,
        selectedId: snap.selectedId,
        layers: snap.layers,
        sidebarOpen: snap.sidebarOpen,
      })
    }
  }, [])

  return {
    yearMin,
    yearMax,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    query,
    setQuery,
    mode,
    setMode,
    coverage,
    setCoverage,
    displayMode,
    setDisplayMode,
    heatScale,
    setHeatScale,
    selectedId,
    setSelectedId,
    layers,
    setLayers,
    sidebarOpen,
    setSidebarOpen,
  }
}

type ExplorerState = ReturnType<typeof useExplorerState>

function ExplorerShell({
  wars,
  battles,
  theaters,
  midloc,
  warCentroids,
  citations,
  catalogMeta,
  progressHistory,
  state,
  allowedWarIds,
  battleCap,
  view,
  active,
  search,
}: {
  wars: War[]
  battles: GeoJSONFeatureCollection | null
  theaters: GeoJSONFeatureCollection | null
  midloc: GeoJSONFeatureCollection | null
  warCentroids: GeoJSONFeatureCollection | null
  citations: CitationDataset[]
  catalogMeta: CatalogMeta | null
  progressHistory: ProgressSnapshot[]
  state: ExplorerState
  allowedWarIds: Set<string>
  battleCap: number
  view: 'map' | 'globe'
  active: boolean
  search: string
}) {
  const otherViewPath = view === 'map' ? '/globe' : '/map'

  return (
    <div
      className={`view-body${active ? ' is-active' : ' is-inactive'}`}
      aria-hidden={!active}
      {...(!active ? ({ inert: true } as HTMLAttributes<HTMLDivElement>) : {})}
    >
      <ErrorBoundary label={view === 'map' ? 'Map' : 'Globe'} compact>
        {view === 'map' ? (
          <WarMap
            selectedId={state.selectedId}
            allowedWarIds={allowedWarIds}
            battles={battles}
            theaters={theaters}
            midloc={midloc}
            warCentroids={warCentroids}
            layers={state.layers}
            yearFrom={state.yearFrom}
            yearTo={state.yearTo}
            battleCap={battleCap}
            displayMode={state.displayMode}
            heatScale={state.heatScale}
            active={active}
            search={search}
          />
        ) : (
          <WarGlobe
            selectedId={state.selectedId}
            allowedWarIds={allowedWarIds}
            battles={battles}
            theaters={theaters}
            midloc={midloc}
            warCentroids={warCentroids}
            layers={state.layers}
            yearFrom={state.yearFrom}
            yearTo={state.yearTo}
            battleCap={battleCap}
            displayMode={state.displayMode}
            heatScale={state.heatScale}
            active={active}
            search={search}
          />
        )}
      </ErrorBoundary>
      {active && (
        <>
          <DisplayModeSwitch
            mode={state.displayMode}
            onMode={state.setDisplayMode}
            heatScale={state.heatScale}
            onHeatScale={state.setHeatScale}
          />
          <AtlasLegend
            displayMode={state.displayMode}
            layers={state.layers}
            selectedId={state.selectedId}
          />
          <WarChrome
            wars={wars}
            selectedId={state.selectedId}
            onSelect={state.setSelectedId}
            yearFrom={state.yearFrom}
            yearTo={state.yearTo}
            onYearFrom={state.setYearFrom}
            onYearTo={state.setYearTo}
            yearMin={state.yearMin}
            yearMax={state.yearMax}
            query={state.query}
            onQuery={state.setQuery}
            mode={state.mode}
            onMode={state.setMode}
            coverage={state.coverage}
            onCoverage={state.setCoverage}
            displayMode={state.displayMode}
            heatScale={state.heatScale}
            layers={state.layers}
            onLayers={(patch) => state.setLayers((L) => ({ ...L, ...patch }))}
            theaters={theaters}
            otherViewPath={otherViewPath}
            viewLabel={view === 'map' ? 'Map' : 'Globe'}
            sidebarOpen={state.sidebarOpen}
            onSidebarOpen={state.setSidebarOpen}
            citations={citations}
            catalogCoverage={coverageStats(wars)}
            catalogMeta={catalogMeta}
            progressHistory={progressHistory}
          />
        </>
      )}
    </div>
  )
}

function DualExplorers({
  wars,
  battles,
  theaters,
  midloc,
  warCentroids,
  citations,
  catalogMeta,
  progressHistory,
}: {
  wars: War[]
  battles: GeoJSONFeatureCollection | null
  theaters: GeoJSONFeatureCollection | null
  midloc: GeoJSONFeatureCollection | null
  warCentroids: GeoJSONFeatureCollection | null
  citations: CitationDataset[]
  catalogMeta: CatalogMeta | null
  progressHistory: ProgressSnapshot[]
}) {
  const location = useLocation()
  const path = normalizePath(location.pathname)
  const onGlobe = path === '/globe'
  const state = useExplorerState(wars)
  const [globeVisited, setGlobeVisited] = useState(onGlobe)
  useEffect(() => {
    if (onGlobe) setGlobeVisited(true)
  }, [onGlobe])

  const allowedWarIds = useMemo(() => {
    const list = filterWars(wars, {
      yearFrom: state.yearFrom,
      yearTo: state.yearTo,
      query: state.query,
      mode: state.mode,
      coverage: state.coverage,
    })
    return new Set(list.map((w) => w.war_id))
  }, [wars, state.yearFrom, state.yearTo, state.query, state.mode, state.coverage])

  // Drop unknown war ids (bad URL / stale session). Keep selection when only
  // filtered out of the current year/mode/coverage set.
  const { selectedId: currentSelectedId, setSelectedId: setCurrentSelectedId } = state
  useEffect(() => {
    if (!currentSelectedId || !wars.length) return
    if (!wars.some((w) => w.war_id === currentSelectedId)) {
      setCurrentSelectedId(null)
    }
  }, [wars, currentSelectedId, setCurrentSelectedId])

  // One progressive sample for both views — same points on Map and Globe
  const battleCap = useProgressiveBattleCap(
    state.selectedId,
    `${state.yearFrom}:${state.yearTo}:${state.query}:${state.mode}:${allowedWarIds.size}`,
  )

  // Unknown paths briefly render DualExplorers before * → /map; keep Map active.
  const mapActive = !onGlobe
  const globeActive = onGlobe

  return (
    <div className="explorer-pair">
      <ExplorerShell
        wars={wars}
        battles={battles}
        theaters={theaters}
        midloc={midloc}
        warCentroids={warCentroids}
        citations={citations}
        catalogMeta={catalogMeta}
        progressHistory={progressHistory}
        state={state}
        allowedWarIds={allowedWarIds}
        battleCap={battleCap}
        view="map"
        active={mapActive}
        search={location.search}
      />
      {globeVisited && (
        <ExplorerShell
          wars={wars}
          battles={battles}
          theaters={theaters}
          midloc={midloc}
          warCentroids={warCentroids}
          citations={citations}
          catalogMeta={catalogMeta}
          progressHistory={progressHistory}
          state={state}
          allowedWarIds={allowedWarIds}
          battleCap={battleCap}
          view="globe"
          active={globeActive}
          search={location.search}
        />
      )}
    </div>
  )
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M2.5 12.5 L8 3.5 L13.5 12.5 Z" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="8" cy="9.2" r="1.1" fill="currentColor" />
      </svg>
    </span>
  )
}

export default function App() {
  const location = useLocation()
  const path = normalizePath(location.pathname)
  const onInsights = path === '/insights'
  const insightsMapSearch = onInsights
    ? (() => {
        const q = eraExplorerSearch(readInsightsUrl(location.search).era ?? 'all')
        return q ? `?${q}` : ''
      })()
    : location.search
  const [wars, setWars] = useState<War[] | null>(null)
  const [battles, setBattles] = useState<GeoJSONFeatureCollection | null>(null)
  const [theaters, setTheaters] = useState<GeoJSONFeatureCollection | null>(null)
  const [midloc, setMidloc] = useState<GeoJSONFeatureCollection | null>(null)
  const [warCentroids, setWarCentroids] = useState<GeoJSONFeatureCollection | null>(null)
  const [citations, setCitations] = useState<CitationDataset[]>([])
  const [catalogMeta, setCatalogMeta] = useState<CatalogMeta | null>(null)
  const [progressHistory, setProgressHistory] = useState<ProgressSnapshot[]>([])
  const [battlesReady, setBattlesReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Start every request at once; each layer appears as soon as its own file
        // arrives instead of all layers waiting for the largest (battles).
        // The loaders never throw for optional layers (they fall back to empty).
        const guard =
          <T,>(set: (v: T) => void) =>
          (v: T) => {
            if (!cancelled) set(v)
          }
        const metaP = loadCatalogMeta().then(guard(setCatalogMeta))
        loadCitations().then(guard(setCitations))
        loadProgressHistory().then(guard(setProgressHistory))
        loadGeoJSON('wars.geojson').then(guard(setWarCentroids))
        loadGeoJSON('midloc.geojson').then(guard(setMidloc))
        loadGeoJSON('theaters.geojson').then(guard(setTheaters))
        const battlesP = loadGeoJSON('battles.geojson').then(guard(setBattles))

        const w = await loadWars()
        if (cancelled) return
        setWars(w)

        // Numbers page needs both battles and catalog metadata
        await Promise.all([battlesP, metaP])
        if (cancelled) return
        setBattlesReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const coverage = useMemo(() => coverageStats(wars ?? []), [wars])
  const [aboutOpen, setAboutOpen] = useState(() => {
    try {
      return localStorage.getItem(ABOUT_SEEN_KEY) !== '1'
    } catch {
      return true
    }
  })

  const closeAbout = useCallback(() => {
    setAboutOpen(false)
    try {
      localStorage.setItem(ABOUT_SEEN_KEY, '1')
    } catch {
      /* ignore */
    }
  }, [])

  if (error) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <div className="brand" style={{ justifyContent: 'center', marginBottom: '0.75rem' }}>
            <BrandMark />
            <span className="brand-title">Wars In All World</span>
          </div>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
          <p className="muted">From the repo root run: python scripts/run_etl.py</p>
        </div>
      </div>
    )
  }

  if (!wars) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <div className="brand" style={{ justifyContent: 'center' }}>
            <BrandMark />
            <span className="brand-title">Wars In All World</span>
          </div>
          <div className="loading-pulse" aria-hidden />
          <p>Loading research atlas…</p>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Wars, battles, theaters, and disputes
          </p>
        </div>
      </div>
    )
  }

  const withGeo =
    warCentroids?.features.filter((f) => f.geometry?.type === 'Point').length ?? 0

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-title">
            <span className="brand-title-full">Wars In All World</span>
            <span className="brand-title-short">Wars</span>
          </span>
          <span className="brand-sub">research atlas</span>
        </div>
        <div className="topbar-center">
          <nav className="nav-switch" aria-label="View">
            <NavLink
              to={{ pathname: '/map', search: onInsights ? insightsMapSearch : location.search }}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              Map
            </NavLink>
            <NavLink
              to={{ pathname: '/globe', search: onInsights ? insightsMapSearch : location.search }}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              Globe
            </NavLink>
            <NavLink to="/insights" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-label-full">Numbers</span>
              <span className="nav-label-short">Stats</span>
            </NavLink>
          </nav>
        </div>
        <div className="topbar-actions">
          {!onInsights && (
            <div
              className="topbar-stats"
              title={`${coverage.withBattlePoints} wars with battle/combat points; ${coverage.proxyOnly} proxy-only; ${coverage.noMapLocation} with no map location. Centroids file: ${withGeo}.`}
            >
              <span>
                <strong>{coverage.withBattlePoints.toLocaleString()}</strong>/
                {coverage.total.toLocaleString()} with battles
              </span>
              <span className="topbar-stats-muted">
                {coverage.noMapLocation.toLocaleString()} unmapped
              </span>
            </div>
          )}
          <button
            type="button"
            className="btn ghost topbar-about"
            onClick={() => setAboutOpen(true)}
            title="What this atlas is and is not"
            aria-label="About this atlas"
          >
            <span className="about-label">About</span>
          </button>
        </div>
      </header>
      {/*
        Only two grid children under .app-shell (topbar + main). Extra siblings
        (Routes / About) previously stole the 1fr row and left Map/Globe at height 0.
      */}
      <div className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/map" replace />} />
          <Route path="/map" element={null} />
          <Route path="/globe" element={null} />
          <Route path="/insights" element={null} />
          <Route path="*" element={<Navigate to="/map" replace />} />
        </Routes>
        {onInsights ? (
          <ErrorBoundary label="Numbers">
            {battlesReady ? (
              <InsightsPage
                wars={wars}
                battles={battles}
                catalogMeta={catalogMeta}
                citations={citations}
              />
            ) : (
              <div className="loading-screen" style={{ minHeight: '50vh' }}>
                <div className="loading-card">
                  <div className="loading-pulse" aria-hidden />
                  <p>Loading battle points…</p>
                </div>
              </div>
            )}
          </ErrorBoundary>
        ) : (
          <DualExplorers
            wars={wars}
            battles={battles}
            theaters={theaters}
            midloc={midloc}
            warCentroids={warCentroids}
            citations={citations}
            catalogMeta={catalogMeta}
            progressHistory={progressHistory}
          />
        )}
      </div>
      <AboutAtlas
        open={aboutOpen}
        onClose={closeAbout}
        coverage={coverage}
        catalogMeta={catalogMeta}
        progressHistory={progressHistory}
      />
    </div>
  )
}
