import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type {
  CatalogMeta,
  CitationDataset,
  CoverageMode,
  DefinitionMode,
  DisplayMode,
  GeoJSONFeatureCollection,
  HeatScaleMode,
  ProgressSnapshot,
  War,
} from '../types'
import {
  COVERAGE_MODES,
  DEFINITION_MODES,
  downloadJson,
  filterWars,
  formatYear,
  parseYearInput,
  isAllYearsRange,
  tierLabel,
  warCoverageBucket,
  yearLabel,
  type WarSort,
} from '../lib/data'
import {
  coverageStats,
  deathEstimateLabel,
  geoSourceConfidence,
  geoSourceLabel,
  theaterMethodLabel,
  theaterQualityLabel,
  ucdpSampleNote,
  warSpanLabel,
  type CoverageStats,
} from '../lib/geoLabels'
import { useDebouncedValue } from '../lib/perf'
import { HudPortal } from './Hud'
import { BattleSpark } from './BattleSpark'
import { indexWarBattles, sourceLabel, yearBins } from '../lib/warStats'
import { buildExplorerSearch, explorerShareUrl } from '../lib/urlState'

type Props = {
  wars: War[]
  /** All battle points (for per-war charts in the details card) */
  battles: GeoJSONFeatureCollection | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  yearFrom: number
  yearTo: number
  onYearFrom: (y: number) => void
  onYearTo: (y: number) => void
  yearMin: number
  yearMax: number
  query: string
  onQuery: (q: string) => void
  mode: DefinitionMode
  onMode: (m: DefinitionMode) => void
  coverage: CoverageMode
  onCoverage: (c: CoverageMode) => void
  displayMode: DisplayMode
  heatScale: HeatScaleMode
  layers: {
    battles: boolean
    theaters: boolean
    midloc: boolean
    centroids: boolean
  }
  onLayers: (patch: Partial<Props['layers']>) => void
  theaters: GeoJSONFeatureCollection | null
  otherViewPath: '/map' | '/globe'
  viewLabel: 'Map' | 'Globe'
  sidebarOpen: boolean
  onSidebarOpen: (open: boolean) => void
  citations: CitationDataset[]
  catalogCoverage: CoverageStats
  catalogMeta: CatalogMeta | null
  progressHistory: ProgressSnapshot[]
}

type Tab = 'list' | 'filters' | 'layers'

/** 16634907 → "16.6M", 52000 → "52k", null → "—" */
function compactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  return Math.round(n).toLocaleString()
}

/** Paint the war list in chunks so the UI stays responsive, but load everything. */
const LIST_CHUNK = 200

function yearPresets(yearMax: number): Array<{ label: string; from: number; to: number }> {
  return [
    { label: 'All years', from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
    { label: 'Before 1500', from: Number.NEGATIVE_INFINITY, to: 1499 },
    { label: '1500–1815', from: 1500, to: 1815 },
    { label: '1816–1945', from: 1816, to: 1945 },
    { label: '1946–1991', from: 1946, to: 1991 },
    { label: '1992–now', from: 1992, to: yearMax },
  ]
}

export function WarChrome({
  wars,
  battles,
  selectedId,
  onSelect,
  yearFrom,
  yearTo,
  onYearFrom,
  onYearTo,
  yearMin,
  yearMax,
  query,
  onQuery,
  mode,
  onMode,
  coverage,
  onCoverage,
  displayMode,
  heatScale,
  layers,
  onLayers,
  theaters,
  otherViewPath,
  viewLabel,
  sidebarOpen,
  onSidebarOpen,
  citations,
  catalogCoverage,
  catalogMeta,
  progressHistory,
}: Props) {
  const location = useLocation()
  const [tab, setTab] = useState<Tab>('list')
  // Open on the best-documented wars (WWII, Napoleonic…) rather than the oldest
  // single-battle records — first impressions matter.
  const [sort, setSort] = useState<WarSort>('battles')
  const [visible, setVisible] = useState(LIST_CHUNK)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [fromText, setFromText] = useState(yearLabel(yearFrom))
  const [toText, setToText] = useState(yearLabel(yearTo))
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle')

  const listFrom = useDebouncedValue(yearFrom, 80)
  const listTo = useDebouncedValue(yearTo, 80)
  const listQuery = useDebouncedValue(query, 120)

  const filtered = useMemo(
    () =>
      filterWars(wars, {
        yearFrom: listFrom,
        yearTo: listTo,
        query: listQuery,
        mode,
        coverage,
        sort,
      }),
    [wars, listFrom, listTo, listQuery, mode, coverage, sort],
  )
  const selected = wars.find((w) => w.war_id === selectedId) ?? null
  const selectedOutsideFilters = Boolean(
    selected && !filtered.some((w) => w.war_id === selected.war_id),
  )
  const modeMeta = DEFINITION_MODES.find((m) => m.id === mode)
  const coverageMeta = COVERAGE_MODES.find((m) => m.id === coverage)
  const allYears = isAllYearsRange(yearFrom, yearTo, yearMin, yearMax)
  const selectedCitations = useMemo(() => {
    if (!selected?.sources) return []
    const ids = selected.sources.split('|').map((s) => s.trim()).filter(Boolean)
    return ids
      .map((id) => citations.find((c) => c.id === id))
      .filter((c): c is CitationDataset => Boolean(c))
  }, [selected, citations])

  const selectedTheater = useMemo(() => {
    if (!selectedId || !theaters) return null
    return theaters.features.find((f) => String(f.properties?.war_id ?? '') === selectedId) ?? null
  }, [selectedId, theaters])

  const filteredCoverage = useMemo(() => coverageStats(filtered), [filtered])

  const copyShareLink = async () => {
    const search = buildExplorerSearch({
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
    })
    const url = explorerShareUrl(location.pathname, search)
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('ok')
    } catch {
      setCopyState('err')
    }
  }

  useEffect(() => {
    if (copyState === 'idle') return
    const id = window.setTimeout(() => setCopyState('idle'), 1800)
    return () => window.clearTimeout(id)
  }, [copyState])

  const exportFiltered = () => {
    downloadJson('filtered-wars.json', {
      generated_at: new Date().toISOString(),
      filters: {
        yearFrom: Number.isFinite(yearFrom) ? yearFrom : null,
        yearTo: Number.isFinite(yearTo) ? yearTo : null,
        yearFromOpen: !Number.isFinite(yearFrom),
        yearToOpen: !Number.isFinite(yearTo),
        query,
        mode,
        coverage,
        displayMode,
      },
      count: filtered.length,
      with_battle_points: filteredCoverage.withBattlePoints,
      wars: filtered,
    })
  }
  useEffect(() => {
    setVisible(Math.min(LIST_CHUNK, filtered.length || LIST_CHUNK))
  }, [yearFrom, yearTo, query, mode, coverage, sort, filtered.length])

  // Keep loading the rest of the list automatically (no "Load more" gate)
  useEffect(() => {
    if (visible >= filtered.length) return
    const id = window.setTimeout(() => {
      setVisible((n) => Math.min(n + LIST_CHUNK, filtered.length))
    }, 16)
    return () => window.clearTimeout(id)
  }, [visible, filtered.length])

  useEffect(() => {
    setFromText(yearLabel(yearFrom))
    setToText(yearLabel(yearTo))
  }, [yearFrom, yearTo])

  useEffect(() => {
    if (!selectedId) {
      setMobileDetailOpen(false)
      return
    }
    // Phones/tablets: keep the map visible; Details FAB opens the sheet on demand
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches) {
      onSidebarOpen(false)
      setMobileDetailOpen(false)
      return
    }
    setMobileDetailOpen(true)
  }, [selectedId, onSidebarOpen])

  const clampYear = (y: number) => {
    if (!Number.isFinite(y)) return y
    return Math.min(Math.max(y, yearMin), yearMax)
  }

  const setRange = (from: number, to: number) => {
    const a = clampYear(from)
    const b = clampYear(to)
    if (!Number.isFinite(a) && !Number.isFinite(b)) {
      onYearFrom(Number.NEGATIVE_INFINITY)
      onYearTo(Number.POSITIVE_INFINITY)
      return
    }
    let nextFrom = Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY
    let nextTo = Number.isFinite(b) ? b : Number.POSITIVE_INFINITY
    if (Number.isFinite(nextFrom) && Number.isFinite(nextTo) && nextFrom > nextTo) {
      const tmp = nextFrom
      nextFrom = nextTo
      nextTo = tmp
    }
    onYearFrom(nextFrom)
    onYearTo(nextTo)
  }

  const commitFrom = () => {
    const t = fromText.trim()
    if (!t || t === '…' || t === '...') {
      onYearFrom(Number.NEGATIVE_INFINITY)
      setFromText(yearLabel(Number.NEGATIVE_INFINITY))
      return
    }
    const y = parseYearInput(fromText, yearFrom)
    if (!Number.isFinite(y)) {
      onYearFrom(Number.NEGATIVE_INFINITY)
      setFromText(yearLabel(Number.NEGATIVE_INFINITY))
      return
    }
    setRange(y, yearTo)
  }

  const commitTo = () => {
    const t = toText.trim()
    if (!t || t === '…' || t === '...') {
      onYearTo(Number.POSITIVE_INFINITY)
      setToText(yearLabel(Number.POSITIVE_INFINITY))
      return
    }
    const y = parseYearInput(toText, yearTo)
    if (!Number.isFinite(y)) {
      onYearTo(Number.POSITIVE_INFINITY)
      setToText(yearLabel(Number.POSITIVE_INFINITY))
      return
    }
    setRange(yearFrom, y)
  }

  const battleIndex = useMemo(() => indexWarBattles(battles), [battles])
  const selStats = selected ? battleIndex.get(selected.war_id) : undefined
  const selBins = useMemo(
    () =>
      selected && selStats
        ? yearBins(selStats.byYear, selected.start_year ?? Infinity, selected.end_year ?? selected.start_year ?? -Infinity)
        : [],
    [selected, selStats],
  )
  const listMaxBattles = useMemo(() => filtered.reduce((m, w) => Math.max(m, w.battle_count || 0), 1), [filtered])

  const shown = filtered.slice(0, visible)
  const listLoading = visible < filtered.length

  return (
    <>
      {/* Collapsed: a compact chip in the top-left zone. Open: the left dock (desktop) or bottom sheet (phone). */}
      <HudPortal slot={sidebarOpen ? 'dock-left' : 'top-left'}>
      <aside className={`panel panel-left${sidebarOpen ? '' : ' collapsed'}`}>
        <div className="panel-header">
          <div>
            <h2>Explorer</h2>
            <p className="panel-kicker">
              {filtered.length.toLocaleString()} wars ·{' '}
              {filteredCoverage.withBattlePoints.toLocaleString()} with battles · {viewLabel}
              {!allYears && (
                <>
                  {' '}
                  · {yearLabel(yearFrom)}–{yearLabel(yearTo)}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn explorer-toggle"
            onClick={() => {
              const next = !sidebarOpen
              onSidebarOpen(next)
              // One sheet at a time on phones/tablets
              if (next && typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches) {
                setMobileDetailOpen(false)
              }
            }}
            aria-expanded={sidebarOpen}
            title={sidebarOpen ? 'Collapse panel' : 'Expand panel'}
            aria-label={sidebarOpen ? 'Collapse explorer panel' : 'Expand explorer panel'}
          >
            {sidebarOpen ? (
              <span className="explorer-toggle-hide">Hide</span>
            ) : (
              <>
                <span className="explorer-toggle-full">Show</span>
                <span className="explorer-toggle-short">Explore</span>
              </>
            )}
          </button>
        </div>

        {sidebarOpen && selectedOutsideFilters && selected && (
          <div className="filter-orphan-banner" role="status">
            <p>
              <strong>{selected.title}</strong> is outside the current filters.
            </p>
            <div className="filter-orphan-actions">
              <button type="button" className="btn ghost" onClick={() => onSelect(null)}>
                Clear selection
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  onYearFrom(Number.NEGATIVE_INFINITY)
                  onYearTo(Number.POSITIVE_INFINITY)
                  onQuery('')
                  onMode('all')
                  onCoverage('all')
                }}
              >
                Widen filters
              </button>
            </div>
          </div>
        )}

        {sidebarOpen && (
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div className="panel-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                className={tab === 'list' ? 'active' : ''}
                aria-selected={tab === 'list'}
                onClick={() => setTab('list')}
              >
                Wars
              </button>
              <button
                type="button"
                role="tab"
                className={tab === 'filters' ? 'active' : ''}
                aria-selected={tab === 'filters'}
                onClick={() => setTab('filters')}
              >
                Filters
              </button>
              <button
                type="button"
                role="tab"
                className={tab === 'layers' ? 'active' : ''}
                aria-selected={tab === 'layers'}
                onClick={() => setTab('layers')}
              >
                Layers
              </button>
            </div>

            {tab === 'filters' && (
              <div className="panel-section filters-scroll">
                <div>
                  <span className="field-label">Years</span>
                  <p className="field-hint" style={{ marginTop: 0, marginBottom: '0.45rem' }}>
                    Show wars that overlap this range.
                  </p>
                  <div className="year-inputs">
                    <label>
                      From
                      <input
                        value={fromText}
                        onChange={(e) => setFromText(e.target.value)}
                        onBlur={commitFrom}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        inputMode="numeric"
                        aria-label="From year"
                      />
                    </label>
                    <span className="year-sep" aria-hidden>
                      →
                    </span>
                    <label>
                      To
                      <input
                        value={toText}
                        onChange={(e) => setToText(e.target.value)}
                        onBlur={commitTo}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        inputMode="numeric"
                        aria-label="To year"
                      />
                    </label>
                  </div>
                  <div className="chip-row" style={{ marginTop: '0.55rem' }}>
                    {yearPresets(yearMax).map((p) => {
                      const isAll = p.label === 'All years'
                      const active = isAll
                        ? allYears
                        : yearFrom === clampYear(p.from) && yearTo === clampYear(p.to)
                      return (
                        <button
                          key={p.label}
                          type="button"
                          className={`chip${active ? ' active' : ''}`}
                          onClick={() => setRange(p.from, p.to)}
                        >
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div>
                  <span className="field-label">Search</span>
                  <div className="search-wrap">
                    <input
                      value={query}
                      onChange={(e) => onQuery(e.target.value)}
                      placeholder="Name or war id…"
                      aria-label="Search wars"
                    />
                    {query && (
                      <button type="button" className="clear-q" onClick={() => onQuery('')} aria-label="Clear search">
                        ×
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <span className="field-label">Definition</span>
                  <div className="chip-row">
                    {DEFINITION_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`chip${mode === m.id ? ' active' : ''}`}
                        title={m.hint}
                        onClick={() => onMode(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {modeMeta && <p className="field-hint">{modeMeta.hint}</p>}
                </div>

                <div>
                  <span className="field-label">Map coverage</span>
                  <div className="chip-row">
                    {COVERAGE_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`chip${coverage === m.id ? ' active' : ''}`}
                        title={m.hint}
                        onClick={() => onCoverage(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {coverageMeta && <p className="field-hint">{coverageMeta.hint}</p>}
                  {catalogMeta?.tier_coverage && (
                    <div className="tier-coverage-block">
                      <span className="field-label">By source tier</span>
                      <ul className="tier-coverage-list">
                        {Object.entries(catalogMeta.tier_coverage).map(([tier, row]) => (
                          <li key={tier}>
                            <strong>{tierLabel(tier)}</strong>: {row.battles}/{row.total} battles
                            {row.proxy ? ` · ${row.proxy} proxy` : ''}
                            {row.unmapped ? ` · ${row.unmapped} unmapped` : ''}
                          </li>
                        ))}
                      </ul>
                      {(catalogMeta.crosswalk_ambiguous != null ||
                        catalogMeta.crosswalk_rejected != null ||
                        catalogMeta.crosswalk_accepted_decisions != null) && (
                        <p className="field-hint">
                          Crosswalk: {catalogMeta.crosswalk_accepted_decisions ?? 0} accepted decisions ·{' '}
                          {catalogMeta.crosswalk_ambiguous ?? 0} still ambiguous ·{' '}
                          {catalogMeta.crosswalk_rejected ?? 0} rejected.
                        </p>
                      )}
                      {progressHistory.length > 0 && (
                        <div className="progress-history">
                          <span className="field-label">COW coverage over time</span>
                          <ul className="tier-coverage-list">
                            {progressHistory.slice(-6).map((snap) => (
                              <li key={snap.at}>
                                {new Date(snap.at).toLocaleDateString()}:{' '}
                                {snap.cow_with_battles ?? '?'}/{snap.cow_total ?? '?'} with battles
                                {snap.cow_pct_with_battles != null
                                  ? ` (${snap.cow_pct_with_battles}%)`
                                  : ''}
                                {snap.cow_unmapped != null ? ` · ${snap.cow_unmapped} unmapped` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <span className="field-label">Share & export</span>
                  <div className="btn-row" style={{ marginTop: '0.35rem' }}>
                    <button type="button" className="btn" onClick={copyShareLink}>
                      {copyState === 'ok' ? 'Link copied' : copyState === 'err' ? 'Copy failed' : 'Copy link'}
                    </button>
                    <button type="button" className="btn" onClick={exportFiltered}>
                      Export filtered JSON
                    </button>
                  </div>
                  <p className="field-hint">
                    The link restores years, definition, search, layers, display mode, and selected war.
                  </p>
                </div>

                <div>
                  <span className="field-label">Sort</span>
                  <div className="sort-row">
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value as WarSort)}
                      aria-label="Sort wars"
                    >
                      <option value="battles">Most mapped battles</option>
                      <option value="year_asc">Year ↑</option>
                      <option value="year_desc">Year ↓</option>
                      <option value="title">Title A–Z</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {tab === 'layers' && (
              <div className="panel-section">
                <div className="guide-card">
                  <strong>What am I looking at?</strong>
                  <ul>
                    <li>
                      <em>Points</em> mode: each gold pin is one battle or combat event.
                    </li>
                    <li>
                      <em>Heat map</em> mode: equal-area density of mapped battle events (events per
                      km²; redder = denser). All point layers stay hidden.
                    </li>
                    <li>Purple = one summary pin per war. Blue = militarized disputes (not wars).</li>
                    <li>Dashed outline = approximate theater for the selected war only.</li>
                  </ul>
                  <p className="guide-note">
                    Now: <strong>{displayMode === 'heatmap' ? 'Heat map' : 'Points'}</strong>
                    {displayMode === 'heatmap'
                      ? ' — equal-area density from every mapped battle/combat event in the current filters (not MIDLOC or centroids; duplicates collapsed). Wars without battle locations will not appear.'
                      : ' — individual events; use the centered toggle to switch.'}
                  </p>
                  <p className="guide-note">
                    Catalog: {catalogCoverage.withBattlePoints.toLocaleString()} /{' '}
                    {catalogCoverage.total.toLocaleString()} wars have battle points;
                    {catalogCoverage.proxyOnly > 0
                      ? ` ${catalogCoverage.proxyOnly.toLocaleString()} proxy-only;`
                      : ''}{' '}
                    {catalogCoverage.noMapLocation.toLocaleString()} unmapped.
                  </p>
                </div>
                <div className="layer-toggles">
                  <span className="layer-group-label">Points</span>
                  <label className={`layer-card${displayMode === 'heatmap' ? ' is-dimmed' : ''}`}>
                    <input
                      type="checkbox"
                      checked={layers.battles}
                      disabled={displayMode === 'heatmap'}
                      onChange={(e) => onLayers({ battles: e.target.checked })}
                    />
                    <span className="layer-copy">
                      <span className="layer-title">
                        <span className="swatch battle" aria-hidden />
                        Battles & combat events
                      </span>
                      <span className="layer-desc">
                        Gold pins — each is one fight/event (HCED / Atlas / UCDP). All point layers
                        are hidden while Heat map is on (heat still uses battle events for density).
                      </span>
                    </span>
                  </label>
                  <label className={`layer-card${displayMode === 'heatmap' ? ' is-dimmed' : ''}`}>
                    <input
                      type="checkbox"
                      checked={layers.midloc}
                      disabled={displayMode === 'heatmap'}
                      onChange={(e) => onLayers({ midloc: e.target.checked })}
                    />
                    <span className="layer-copy">
                      <span className="layer-title">
                        <span className="swatch midloc" aria-hidden />
                        Militarized disputes
                      </span>
                      <span className="layer-desc">
                        Blue MIDLOC points (1816–2010). Research layer for disputes — not the same as
                        wars. Hidden while a war is selected or Heat map is on.
                      </span>
                    </span>
                  </label>
                  <label className={`layer-card${displayMode === 'heatmap' ? ' is-dimmed' : ''}`}>
                    <input
                      type="checkbox"
                      checked={layers.centroids}
                      disabled={displayMode === 'heatmap'}
                      onChange={(e) => onLayers({ centroids: e.target.checked })}
                    />
                    <span className="layer-copy">
                      <span className="layer-title">
                        <span className="swatch centroid" aria-hidden />
                        War centroids
                      </span>
                      <span className="layer-desc">
                        Purple — one pin per war with geography (average of its battles, or a proxy).
                        Off by default. Hidden while Heat map is on.
                      </span>
                    </span>
                  </label>

                  <span className="layer-group-label">Context</span>
                  <label className="layer-card">
                    <input
                      type="checkbox"
                      checked={layers.theaters}
                      onChange={(e) => onLayers({ theaters: e.target.checked })}
                    />
                    <span className="layer-copy">
                      <span className="layer-title">
                        <span className="swatch theater" aria-hidden />
                        Theater outline
                      </span>
                      <span className="layer-desc">
                        Dashed outline for the <em>selected</em> war only (needs a war selected).
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            )}

            {tab === 'list' && (
              <>
                <div className="panel-section" style={{ paddingBottom: '0.65rem' }}>
                  <div className="search-wrap">
                    <input
                      value={query}
                      onChange={(e) => onQuery(e.target.value)}
                      placeholder="Quick search…"
                      aria-label="Search wars"
                    />
                    {query && (
                      <button type="button" className="clear-q" onClick={() => onQuery('')} aria-label="Clear search">
                        ×
                      </button>
                    )}
                  </div>
                  <div className="chip-row" style={{ marginTop: '0.15rem' }}>
                    {DEFINITION_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`chip${mode === m.id ? ' active' : ''}`}
                        title={m.hint}
                        onClick={() => onMode(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {shown.length === 0 ? (
                  <div className="empty-state">
                    <strong>No wars match</strong>
                    Try <button type="button" className="linkish" onClick={() => setTab('filters')}>Filters</button> — widen years or clear search.
                  </div>
                ) : (
                  <ul className="war-list panel-section scroll">
                    {shown.map((w) => (
                      <li key={w.war_id}>
                        <button
                          type="button"
                          className={w.war_id === selectedId ? 'active' : ''}
                          onClick={() => onSelect(w.war_id === selectedId ? null : w.war_id)}
                        >
                          <span className="title-row">
                            <span className="title">{w.title}</span>
                            <span className={`tier-pill ${w.definition_tier}`}>{tierLabel(w.definition_tier)}</span>
                          </span>
                          <span className="meta">
                            <span className="meta-years">
                              {formatYear(w.start_year)}–{formatYear(w.end_year)}
                            </span>
                            <span className="meta-bar" aria-hidden>
                              <i style={{ width: `${w.battle_count ? Math.max(3, Math.sqrt(w.battle_count / listMaxBattles) * 100) : 0}%` }} />
                            </span>
                            <span className="meta-count">
                              {w.battle_count ? `${w.battle_count.toLocaleString()} battle${w.battle_count === 1 ? '' : 's'}` : 'no battles'}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="list-footer">
                  <span className="muted">
                    {listLoading
                      ? `Loading list… ${visible.toLocaleString()} / ${filtered.length.toLocaleString()}`
                      : `${filtered.length.toLocaleString()} wars`}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </aside>
      </HudPortal>

      {selected && (
        <HudPortal slot="dock-right">
        <aside className={`panel panel-right detail${mobileDetailOpen ? ' mobile-open' : ''}`}>
          <div className="detail-head">
            <div className="detail-actions-top">
              <button type="button" className="btn ghost" onClick={() => onSelect(null)}>
                Clear
              </button>
              <button
                type="button"
                className="btn ghost detail-close-mobile"
                onClick={() => setMobileDetailOpen(false)}
                aria-label="Close war details"
              >
                Close
              </button>
            </div>
            <span className={`tier-pill ${selected.definition_tier}`}>{tierLabel(selected.definition_tier)}</span>
            <h2>{selected.title}</h2>
            <p className="detail-span">{warSpanLabel(selected, formatYear)}</p>
          </div>
          <div className="detail-body">
            <div className="dossier-stats">
              <div className="dstat">
                <span className="dstat-n">{selected.battle_count.toLocaleString()}</span>
                <span className="dstat-l">Mapped battles</span>
              </div>
              <div className="dstat" title={deathEstimateLabel(selected.death_source)}>
                <span className="dstat-n">{compactNumber(selected.death_estimate)}</span>
                <span className="dstat-l">
                  {selected.death_source === 'cow_battle_deaths'
                    ? 'Battle deaths · COW'
                    : selected.death_source === 'ucdp_best_total'
                      ? 'Deaths · UCDP best'
                      : 'Deaths (est.)'}
                </span>
              </div>
              <div className="dstat">
                <span className="dstat-n">{(selected.sources || '').split('|').filter(Boolean).length || '—'}</span>
                <span className="dstat-l">Catalogue sources</span>
              </div>
            </div>
            {selBins.length > 0 ? (
              <section className="dossier-block" aria-label="Mapped battles over time">
                <h3 className="dossier-kicker">Mapped battles over time</h3>
                <BattleSpark bins={selBins} />
              </section>
            ) : (
              <p className="dossier-spatial">
                {warCoverageBucket(selected) === 'proxy_only'
                  ? `No battle points — map shows a ${geoSourceLabel(selected.geo_source).toLowerCase()} instead.`
                  : 'No battle points or location proxy yet — common for COW-only wars.'}
              </p>
            )}
            <section className="dossier-block" aria-label="Sources">
              <h3 className="dossier-kicker">Where this war comes from</h3>
              <div className="source-chips">
                {(selected.sources || '')
                  .split('|')
                  .filter(Boolean)
                  .map((s) => (
                    <span key={`c-${s}`} className="source-chip catalog" title="War listed in this dataset">
                      <i aria-hidden />
                      {sourceLabel(s)} · war record
                    </span>
                  ))}
                {selStats &&
                  [...selStats.bySource.entries()]
                    .sort((x, y) => y[1] - x[1])
                    .map(([s, n]) => (
                      <span key={`b-${s}`} className="source-chip battles" title="Mapped battle/combat events from this dataset">
                        <i aria-hidden />
                        {sourceLabel(s)} · {n.toLocaleString()} battle{n === 1 ? '' : 's'}
                      </span>
                    ))}
              </div>
            </section>
            <dl className="meta-grid">
              {selected.geo_source && (
                <div className="meta-card wide">
                  <dt>Map point</dt>
                  <dd>
                    <span className={`confidence-pill confidence-${geoSourceConfidence(selected.geo_source)}`}>
                      {geoSourceConfidence(selected.geo_source)}
                    </span>{' '}
                    {geoSourceLabel(selected.geo_source)}
                  </dd>
                </div>
              )}
              {!selected.geo_source && (selected.battle_count ?? 0) === 0 && (
                <div className="meta-card wide">
                  <dt>Map point</dt>
                  <dd>
                    <span className="confidence-pill confidence-none">none</span> No battle points or
                    location proxy yet — common for COW-only wars.
                  </dd>
                </div>
              )}
              {selectedTheater && (
                <div className="meta-card wide">
                  <dt>Theater outline</dt>
                  <dd>
                    <span
                      className={`confidence-pill confidence-${
                        selectedTheater.properties?.quality_flag === 'ok'
                          ? 'high'
                          : selectedTheater.properties?.quality_flag === 'sparse'
                            ? 'medium'
                            : 'low'
                      }`}
                    >
                      {String(selectedTheater.properties?.quality_flag ?? 'approx')}
                    </span>{' '}
                    {theaterQualityLabel(String(selectedTheater.properties?.quality_flag ?? ''))}
                    {' · '}
                    {theaterMethodLabel(String(selectedTheater.properties?.method ?? ''))}
                    {selectedTheater.properties?.point_count != null && (
                      <> · {String(selectedTheater.properties.point_count)} unique points</>
                    )}
                    . Always approximate — not a political border.
                  </dd>
                </div>
              )}
              {selected.participant_summary && (
                <div className="meta-card wide">
                  <dt>Participants</dt>
                  <dd>{selected.participant_summary}</dd>
                </div>
              )}
              {selected.death_estimate != null && (
                <div className="meta-card wide">
                  <dt>{deathEstimateLabel(selected.death_source)}</dt>
                  <dd>{Math.round(selected.death_estimate).toLocaleString()}</dd>
                </div>
              )}
              {selected.ucdp_peak_year_deaths != null && (
                <div className="meta-card">
                  <dt>UCDP peak year</dt>
                  <dd>
                    {selected.ucdp_peak_year_deaths.toLocaleString()} deaths
                    {selected.ucdp_war_years != null && (
                      <> · {selected.ucdp_war_years} war-level year{selected.ucdp_war_years === 1 ? '' : 's'}</>
                    )}
                  </dd>
                </div>
              )}
              {ucdpSampleNote(selected) && (
                <div className="meta-card wide">
                  <dt>UCDP events on map</dt>
                  <dd>{ucdpSampleNote(selected)}</dd>
                </div>
              )}
              {selected.wikidata_qid && (
                <div className="meta-card">
                  <dt>Wikidata</dt>
                  <dd>
                    <a
                      href={`https://www.wikidata.org/wiki/${selected.wikidata_qid}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {selected.wikidata_qid}
                    </a>
                  </dd>
                </div>
              )}
              <div className="meta-card wide">
                <dt>ID</dt>
                <dd>
                  <code style={{ fontSize: '0.8rem', opacity: 0.9 }}>{selected.war_id}</code>
                </dd>
              </div>
            </dl>

            {selectedCitations.length > 0 && (
              <div className="citations-block">
                <h3 className="citations-title">Citations</h3>
                <ul className="citations-list">
                  {selectedCitations.map((c) => (
                    <li key={c.id}>
                      <span className="cite-id">{c.id}</span>
                      <span className="cite-text">{c.citation}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="btn-row">
              <Link
                className="btn primary"
                to={{ pathname: otherViewPath, search: location.search }}
              >
                Open on {otherViewPath === '/globe' ? 'Globe' : 'Map'}
              </Link>
              <button
                type="button"
                className="btn"
                onClick={() => downloadJson(`${selected.war_id}.json`, selected)}
              >
                Download JSON
              </button>
              <button type="button" className="btn" onClick={copyShareLink}>
                {copyState === 'ok' ? 'Link copied' : 'Copy link'}
              </button>
            </div>
            <p className="detail-note">
              Theater outlines are approximate hulls of linked points — not borders. Map and Globe
              share filters; the URL updates so you can share the current view.
            </p>
          </div>
        </aside>
        </HudPortal>
      )}

      {selected && !mobileDetailOpen && (
        <HudPortal slot="bottom-center">
        <button
          type="button"
          className="btn primary mobile-detail-fab"
          onClick={() => setMobileDetailOpen(true)}
          aria-label={`Open details for ${selected.title}`}
        >
          <span className="mobile-detail-fab-icon" aria-hidden>
            ⓘ
          </span>
          <span className="mobile-detail-fab-text">
            <span className="mobile-detail-fab-label">Details</span>
            <span className="mobile-detail-fab-title">{selected.title}</span>
          </span>
        </button>
        </HudPortal>
      )}
    </>
  )
}
