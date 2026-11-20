import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { MapContainer, TileLayer, GeoJSON, Circle, useMap } from 'react-leaflet'
import { useLocation, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import type { DisplayMode, GeoJSONFeatureCollection, HeatScaleMode } from '../types'
import {
  buildHeatCells,
  heatCellKmForMapZoom,
  heatDrawRadiusM,
  heatFill,
  peakHeatDensity,
} from '../lib/heatmap'
import { arcCenterLng, escapeHtml, pointLngLat, unwrapPointCollection } from '../lib/geoSafe'
import {
  clearMapFocusConsumed,
  focusKey,
  markMapFocusConsumed,
  parseMapFocusSearch,
  stripMapFocusSearch,
} from '../lib/insightsUrl'
import {
  BATTLE_OVERVIEW_SOFT_MAX,
  CENTROID_OVERVIEW_CAP,
  HEAT_POINT_SOFT_MAX,
  MIDLOC_OVERVIEW_CAP,
  filterPointFeatures,
  useDebouncedValue,
} from '../lib/perf'
import 'leaflet/dist/leaflet.css'

type Props = {
  selectedId: string | null
  allowedWarIds: Set<string> | null
  battles: GeoJSONFeatureCollection | null
  theaters: GeoJSONFeatureCollection | null
  midloc: GeoJSONFeatureCollection | null
  warCentroids: GeoJSONFeatureCollection | null
  layers: { battles: boolean; theaters: boolean; midloc: boolean; centroids: boolean }
  yearFrom: number
  yearTo: number
  battleCap: number
  displayMode: DisplayMode
  heatScale: HeatScaleMode
  active: boolean
  /** Current location search — used for ?lat=&lng= fly-to. */
  search?: string
}

/** Remount key: length alone is wrong when overview caps keep the same count. */
function geoLayerKey(
  prefix: string,
  features: GeoJSONFeatureCollection['features'] | undefined,
  filterFp: string,
): string {
  const n = features?.length ?? 0
  if (!n || !features) return `${prefix}-${filterFp}-0`
  const sample = (f: (typeof features)[number] | undefined) =>
    String(
      f?.properties?.event_id ??
        f?.properties?.war_id ??
        f?.properties?.name ??
        f?.properties?.year ??
        '',
    )
  const first = sample(features[0])
  const mid = sample(features[Math.floor(n / 2)])
  const last = sample(features[n - 1])
  return `${prefix}-${filterFp}-${n}-${first}-${mid}-${last}`
}

function warIdsFingerprint(ids: Set<string> | null | undefined): string {
  if (!ids) return 'all'
  if (ids.size === 0) return '0'
  let h = ids.size | 0
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0
  }
  return `${ids.size}:${h}`
}

function FitToSelection({
  selectedId,
  battles,
  theaters,
  warCentroids,
  layersTheaters,
  active,
  pendingFocus,
  skipFitAfterFocusRef,
  yearFrom,
  yearTo,
}: {
  selectedId: string | null
  battles: GeoJSONFeatureCollection | null
  theaters: GeoJSONFeatureCollection | null
  warCentroids: GeoJSONFeatureCollection | null
  layersTheaters: boolean
  active: boolean
  pendingFocus: boolean
  skipFitAfterFocusRef: MutableRefObject<boolean>
  yearFrom: number
  yearTo: number
}) {
  const map = useMap()
  const prevSelectedRef = useRef(selectedId)
  const prevYearsRef = useRef(`${yearFrom}:${yearTo}`)
  const lastFittedKeyRef = useRef<string | null>(null)
  const prevActiveRef = useRef(active)

  useEffect(() => {
    if (pendingFocus) {
      prevSelectedRef.current = selectedId
      return
    }
    if (prevSelectedRef.current !== selectedId) {
      skipFitAfterFocusRef.current = false
      prevSelectedRef.current = selectedId
    }
  }, [selectedId, pendingFocus, skipFitAfterFocusRef])

  useEffect(() => {
    const key = `${yearFrom}:${yearTo}`
    if (pendingFocus) {
      prevYearsRef.current = key
      return
    }
    if (prevYearsRef.current !== key) {
      skipFitAfterFocusRef.current = false
      prevYearsRef.current = key
    }
  }, [yearFrom, yearTo, pendingFocus, skipFitAfterFocusRef])

  useEffect(() => {
    const becameActive = active && !prevActiveRef.current
    prevActiveRef.current = active
    if (!active) return
    if (!selectedId) {
      lastFittedKeyRef.current = null
      return
    }
    if (pendingFocus) return
    // Numbers fly-to wins over fitBounds when both war= and lat/lng are present
    if (skipFitAfterFocusRef.current) return

    const fitKey = `${selectedId}:${yearFrom}:${yearTo}`
    // Map↔Globe switch with same war + years — keep the user's camera
    if (becameActive && lastFittedKeyRef.current === fitKey) return

    const bounds = L.latLngBounds([])
    let first: [number, number] | null = null
    let west = 180
    let east = -180

    if (layersTheaters) {
      theaters?.features.forEach((f) => {
        if (String(f.properties?.war_id ?? '') !== selectedId || !f.geometry) return
        const t = f.geometry.type
        if (t !== 'Polygon' && t !== 'MultiPolygon') return
        try {
          const layer = L.geoJSON(f as GeoJSON.Feature)
          const b = layer.getBounds()
          if (b.isValid()) {
            bounds.extend(b)
            const c = b.getCenter()
            if (!first) first = [c.lng, c.lat]
            west = Math.min(west, b.getWest())
            east = Math.max(east, b.getEast())
          }
        } catch {
          /* skip bad theater geometry */
        }
      })
    }

    const yearScoped = filterPointFeatures(battles, {
      yearFrom,
      yearTo,
      selectedId,
      requireWarMatch: true,
      limit: 4000,
    })
    yearScoped?.features.forEach((f) => {
      const ll = pointLngLat(f.geometry)
      if (!ll) return
      if (!first) first = ll
      west = Math.min(west, ll[0])
      east = Math.max(east, ll[0])
      bounds.extend([ll[1], ll[0]])
    })

    // Proxy-only wars: fall back to war centroid when no battles/theater
    if (!bounds.isValid()) {
      const cents = filterPointFeatures(warCentroids, {
        yearFrom,
        yearTo,
        selectedId,
        requireWarMatch: true,
        yearMode: 'war_span',
        limit: 1,
      })
      cents?.features.forEach((f) => {
        const ll = pointLngLat(f.geometry)
        if (!ll) return
        if (!first) first = ll
        west = Math.min(west, ll[0])
        east = Math.max(east, ll[0])
        bounds.extend([ll[1], ll[0]])
      })
    }

    if (!bounds.isValid()) return
    lastFittedKeyRef.current = fitKey
    map.stop()
    // Antimeridian / world-spanning: the min/max box would be the whole world —
    // centre on the circular mean of the war's points and show it zoomed out.
    if (east - west > 180 && first) {
      const pts: number[] = []
      battles?.features.forEach((f) => {
        if (String(f.properties?.war_id ?? '') !== selectedId) return
        const ll = pointLngLat(f.geometry)
        if (ll) pts.push(ll[0])
      })
      // Centre of the same continuous arc the points/outline are drawn on
      const lng = arcCenterLng(pts) ?? (first as [number, number])[0]
      map.setView([bounds.getCenter().lat, lng], 2, { animate: true })
    } else {
      map.fitBounds(bounds.pad(0.2), { animate: true, maxZoom: 8 })
    }
    return () => {
      map.stop()
    }
  }, [
    selectedId,
    battles,
    theaters,
    warCentroids,
    layersTheaters,
    map,
    active,
    pendingFocus,
    skipFitAfterFocusRef,
    yearFrom,
    yearTo,
  ])
  return null
}

/** One-shot fly to ?lat=&lng=; strips coords from the URL after a successful fly. */
function FocusFromNumbers({
  active,
  search,
  onPendingChange,
  onFocusFlown,
}: {
  active: boolean
  search: string
  onPendingChange?: (pending: boolean) => void
  /** Called after a successful Numbers fly so FitToSelection does not overwrite it. */
  onFocusFlown?: () => void
}) {
  const map = useMap()
  const navigate = useNavigate()
  const location = useLocation()
  const flownKey = useRef<string | null>(null)
  const pendingRef = useRef<{ lat: number; lng: number } | null>(null)

  useEffect(() => {
    if (!active) {
      onPendingChange?.(false)
      return
    }
    const fromUrl =
      parseMapFocusSearch(search) ?? parseMapFocusSearch(window.location.search)
    if (!fromUrl) {
      // No focus in URL — release consumed keys so the same coords can deep-link again
      clearMapFocusConsumed()
      pendingRef.current = null
      flownKey.current = null
      onPendingChange?.(false)
      return
    }
    pendingRef.current = fromUrl
    const focus = pendingRef.current
    const key = focusKey(focus.lat, focus.lng)

    const stripIfNeeded = () => {
      const stripped = stripMapFocusSearch(window.location.search)
      const nextSearch = stripped ? `?${stripped}` : ''
      const cur = `${window.location.pathname}${window.location.search}`
      const next = `${location.pathname}${nextSearch}`
      if (next !== cur) {
        navigate({ pathname: location.pathname, search: nextSearch }, { replace: true })
      }
    }

    // Already flown — still strip if coords reappeared
    if (flownKey.current === key) {
      markMapFocusConsumed(key)
      stripIfNeeded()
      onPendingChange?.(false)
      return
    }

    onPendingChange?.(true)
    let cancelled = false
    let flyStarted = false
    let pendingTimer: number | undefined
    const fly = () => {
      if (cancelled) return
      flyStarted = true
      flownKey.current = key
      markMapFocusConsumed(key)
      pendingRef.current = null
      onFocusFlown?.()
      map.stop()
      map.flyTo([focus.lat, focus.lng], 7, { animate: true, duration: 1.05 })
      // Strip focus params after fly starts — cleanup must not map.stop() mid-animation
      stripIfNeeded()
      // Keep FitToSelection blocked until fly animation roughly ends
      pendingTimer = window.setTimeout(() => {
        if (!cancelled) onPendingChange?.(false)
      }, 1100)
    }
    map.whenReady(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(fly)
      })
    })
    return () => {
      cancelled = true
      if (pendingTimer != null) window.clearTimeout(pendingTimer)
      // stripIfNeeded remounts this effect; skipping stop keeps the fly alive
      if (!flyStarted) {
        try {
          map.stop()
        } catch {
          /* ignore */
        }
        onPendingChange?.(false)
      }
      // If fly started, leave pending true until the timer (or no-focus path) clears it
    }
  }, [active, map, search, navigate, location.pathname, onPendingChange, onFocusFlown])
  return null
}

function MapInvalidate({ active }: { active: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(id)
  }, [active, map])
  return null
}

/** Reports Leaflet zoom so heat bins can coarsen/refine with the view. */
function HeatZoomReporter({ enabled, onZoom }: { enabled: boolean; onZoom: (z: number) => void }) {
  const map = useMap()
  useEffect(() => {
    if (!enabled) return
    const sync = () => onZoom(map.getZoom())
    sync()
    map.on('zoomend', sync)
    return () => {
      map.off('zoomend', sync)
    }
  }, [map, enabled, onZoom])
  return null
}

export function WarMap({
  selectedId,
  allowedWarIds,
  battles,
  theaters,
  midloc,
  warCentroids,
  layers,
  yearFrom,
  yearTo,
  battleCap,
  displayMode,
  heatScale,
  active,
  search = '',
}: Props) {
  const dyFrom = useDebouncedValue(yearFrom, 120)
  const dyTo = useDebouncedValue(yearTo, 120)
  const showHeat = displayMode === 'heatmap'
  const [mapZoom, setMapZoom] = useState(2)
  const onMapZoom = useCallback((z: number) => setMapZoom(z), [])
  const heatCellKm = useMemo(
    () => heatCellKmForMapZoom(mapZoom, Boolean(selectedId)),
    [mapZoom, selectedId],
  )
  const debouncedHeatCellKm = useDebouncedValue(heatCellKm, 100)

  const filteredBattles = useMemo(() => {
    if (!active || showHeat || !layers.battles) return null
    const fc = filterPointFeatures(battles, {
      yearFrom: dyFrom,
      yearTo: dyTo,
      selectedId,
      requireWarMatch: Boolean(selectedId),
      warIds: selectedId ? null : allowedWarIds,
      limit: battleCap,
    })
    // Pacific-spanning war: draw its points on one continuous world copy so they
    // line up with the (equally unwrapped) theater outline.
    return fc && selectedId ? unwrapPointCollection(fc) : fc
  }, [active, battles, layers.battles, selectedId, allowedWarIds, dyFrom, dyTo, battleCap, showHeat])

  const heatSource = useMemo(() => {
    if (!active || !showHeat) return null
    return filterPointFeatures(battles, {
      yearFrom: dyFrom,
      yearTo: dyTo,
      selectedId,
      requireWarMatch: Boolean(selectedId),
      warIds: selectedId ? null : allowedWarIds,
      limit: HEAT_POINT_SOFT_MAX,
    })
  }, [active, showHeat, battles, selectedId, allowedWarIds, dyFrom, dyTo])

  const absoluteMaxDensity = useMemo(() => {
    if (!active || !showHeat || heatScale !== 'absolute') return undefined
    // Absolute = vs full catalog peak at this zoom (not the filtered cell set)
    return peakHeatDensity(battles, debouncedHeatCellKm) || undefined
  }, [active, showHeat, heatScale, battles, debouncedHeatCellKm])

  const heatCells = useMemo(() => {
    if (!active || !showHeat || !heatSource) return []
    return buildHeatCells(heatSource, {
      cellKm: debouncedHeatCellKm,
      scaleMode: heatScale,
      absoluteMaxDensity,
    })
  }, [active, showHeat, heatSource, debouncedHeatCellKm, heatScale, absoluteMaxDensity])

  const filteredTheaters = useMemo(() => {
    if (!active || !layers.theaters || !theaters || !selectedId) return null
    // Keep theater for orphan selection (outside filters) — matches detail banner
    return {
      type: 'FeatureCollection' as const,
      features: theaters.features.filter((f) => {
        if (String(f.properties?.war_id ?? '') !== selectedId) return false
        const t = f.geometry?.type
        return t === 'Polygon' || t === 'MultiPolygon'
      }),
    }
  }, [active, theaters, layers.theaters, selectedId])

  // MIDLOC is not war-linked; hide while focused on a war to avoid false association.
  // Heat mode shows density only — no point layers.
  const filteredMidloc = useMemo(() => {
    if (!active || showHeat || !layers.midloc || selectedId) return null
    return filterPointFeatures(midloc, {
      yearFrom: dyFrom,
      yearTo: dyTo,
      limit: MIDLOC_OVERVIEW_CAP,
    })
  }, [active, midloc, layers.midloc, selectedId, dyFrom, dyTo, showHeat])

  const filteredCentroids = useMemo(() => {
    if (!active || showHeat || !layers.centroids) return null
    return filterPointFeatures(warCentroids, {
      yearFrom: dyFrom,
      yearTo: dyTo,
      selectedId,
      requireWarMatch: Boolean(selectedId),
      warIds: selectedId ? null : allowedWarIds,
      yearMode: 'war_span',
      limit: selectedId ? undefined : CENTROID_OVERVIEW_CAP,
    })
  }, [active, warCentroids, layers.centroids, selectedId, allowedWarIds, dyFrom, dyTo, showHeat])

  const filterFp = useMemo(
    () => `${warIdsFingerprint(allowedWarIds)}-${battleCap}`,
    [allowedWarIds, battleCap],
  )
  const battleKey = geoLayerKey('bt', filteredBattles?.features, `${selectedId ?? 'all'}-${dyFrom}-${dyTo}-${filterFp}`)
  const centroidKey = geoLayerKey(
    'centroids',
    filteredCentroids?.features,
    `${selectedId ?? 'all'}-${dyFrom}-${dyTo}-${filterFp}`,
  )
  const midlocKey = geoLayerKey('mid', filteredMidloc?.features, `${dyFrom}-${dyTo}`)
  const sampledNote = Boolean(filteredBattles?.truncated)
  const [pendingFocus, setPendingFocus] = useState(
    () => Boolean(parseMapFocusSearch(search) ?? parseMapFocusSearch(typeof window !== 'undefined' ? window.location.search : '')),
  )
  const skipFitAfterFocusRef = useRef(false)
  const onPendingChange = useCallback((pending: boolean) => setPendingFocus(pending), [])
  const onFocusFlown = useCallback(() => {
    skipFitAfterFocusRef.current = true
  }, [])

  return (
    <div className="map-root" aria-hidden={!active} style={{ visibility: active ? 'visible' : 'hidden' }}>
      <MapContainer
        center={[20, 20]}
        zoom={2}
        minZoom={2}
        worldCopyJump
        preferCanvas
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA, USGS'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        />
        <MapInvalidate active={active} />
        <HeatZoomReporter enabled={showHeat && active} onZoom={onMapZoom} />
        <FocusFromNumbers
          active={active}
          search={search}
          onPendingChange={onPendingChange}
          onFocusFlown={onFocusFlown}
        />
        <FitToSelection
          selectedId={selectedId}
          battles={battles}
          theaters={theaters}
          warCentroids={warCentroids}
          layersTheaters={layers.theaters}
          active={active}
          pendingFocus={pendingFocus}
          skipFitAfterFocusRef={skipFitAfterFocusRef}
          yearFrom={dyFrom}
          yearTo={dyTo}
        />
        {filteredTheaters && filteredTheaters.features.length > 0 && (
          <GeoJSON
            key={`th-${selectedId}`}
            data={filteredTheaters as GeoJSON.FeatureCollection}
            style={() => ({
              color: '#3ecfbf',
              weight: 2,
              dashArray: '6 5',
              fillColor: '#3ecfbf',
              fillOpacity: 0.06,
            })}
            onEachFeature={(feature, layer) => {
              const p = feature.properties || {}
              const q = escapeHtml(p.quality_flag ?? 'approx')
              const method = escapeHtml(p.method ?? '')
              const pts = p.point_count != null ? `${escapeHtml(p.point_count)} unique points<br/>` : ''
              layer.bindPopup(
                `<strong>Theater (approximate)</strong><br/>Quality: ${q}${method ? ` · ${method}` : ''}<br/>${pts}<span style="opacity:.7">Not a political border</span>`,
              )
            }}
          />
        )}
        {showHeat &&
          heatCells.map((c) => {
            const col = heatFill(c.t)
            return (
              <Circle
                key={`h-${c.cellKm}-${c.lat.toFixed(4)}-${c.lng.toFixed(4)}-${c.count}`}
                center={[c.lat, c.lng]}
                radius={heatDrawRadiusM(c.cellKm)}
                pathOptions={{
                  color: col.stroke,
                  fillColor: col.fill,
                  fillOpacity: 1,
                  weight: 1,
                  opacity: 0.85,
                }}
              />
            )
          })}
        {filteredCentroids && filteredCentroids.features.length > 0 && (
          <GeoJSON
            key={centroidKey}
            data={filteredCentroids as GeoJSON.FeatureCollection}
            pointToLayer={(_f, latlng) =>
              L.circleMarker(latlng, {
                radius: selectedId ? 7 : 4,
                color: '#2a1848',
                fillColor: '#a78bfa',
                fillOpacity: 0.85,
                weight: 1,
              })
            }
            onEachFeature={(feature, layer) => {
              const p = feature.properties || {}
              const src = String(p.geo_source ?? 'battles')
              const conf =
                src === 'battles' ? 'high' : src === 'ucdp_centroid' ? 'medium' : src === 'midloc_dyadic' ? 'low' : 'none'
              layer.bindPopup(
                `<strong>${escapeHtml(p.title ?? 'War')}</strong><br/>${escapeHtml(p.start_year ?? '?')}–${escapeHtml(p.end_year ?? '?')}<br/><span style="opacity:.85">Map point confidence: ${escapeHtml(conf)} (${escapeHtml(src)})</span><br/><span style="opacity:.7">${escapeHtml(p.war_id ?? '')}</span>`,
              )
            }}
          />
        )}
        {filteredBattles && filteredBattles.features.length > 0 && (
          <GeoJSON
            key={battleKey}
            data={filteredBattles as GeoJSON.FeatureCollection}
            pointToLayer={(_f, latlng) =>
              L.circleMarker(latlng, {
                radius: selectedId ? 5 : 3,
                color: '#070d18',
                weight: 1,
                fillColor: '#f0c36a',
                fillOpacity: selectedId ? 0.95 : 0.55,
              })
            }
            onEachFeature={(feature, layer) => {
              const p = feature.properties || {}
              layer.bindPopup(
                `<strong>${escapeHtml(p.name ?? 'Battle')}</strong><br/>${escapeHtml(p.year ?? '?')} · ${escapeHtml(p.source ?? '')}<br/><span style="opacity:.7">${escapeHtml(p.war_id ?? '')}</span>`,
              )
            }}
          />
        )}
        {filteredMidloc && filteredMidloc.features.length > 0 && (
          <GeoJSON
            key={midlocKey}
            data={filteredMidloc as GeoJSON.FeatureCollection}
            pointToLayer={(_f, latlng) =>
              L.circleMarker(latlng, {
                radius: 4,
                color: '#0b1e33',
                fillColor: '#5aa8ff',
                fillOpacity: 0.9,
                weight: 1.5,
              })
            }
            onEachFeature={(feature, layer) => {
              const p = feature.properties || {}
              layer.bindPopup(
                `<strong>Militarized dispute (MIDLOC)</strong><br/>${escapeHtml(p.name ?? '')}<br/>${escapeHtml(p.year ?? '')}`,
              )
            }}
          />
        )}
      </MapContainer>
      {showHeat && (
        <div className="heat-legend" aria-hidden>
          <span>
            <span className="hl-long">{heatScale === 'absolute' ? 'Lower (abs)' : 'Lower density'}</span>
            <span className="hl-short">Low</span>
          </span>
          <div className="heat-legend-bar" />
          <span>
            <span className="hl-long">{heatScale === 'absolute' ? 'Higher (abs)' : 'Higher density'}</span>
            <span className="hl-short">High</span>
          </span>
        </div>
      )}
      {sampledNote && (
        <div className="perf-badge" title="Points load in stages; select a war for a denser sample">
          Showing {filteredBattles!.features.length.toLocaleString()}
          {battleCap < BATTLE_OVERVIEW_SOFT_MAX ? '+' : ''} battles (loading denser sample…)
        </div>
      )}
    </div>
  )
}
