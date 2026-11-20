import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import * as Cesium from 'cesium'
import type { DisplayMode, GeoJSONFeatureCollection, HeatScaleMode } from '../types'
import {
  buildHeatCells,
  heatCellKmForCameraHeight,
  heatDrawRadiusM,
  heatFill,
  peakHeatDensity,
} from '../lib/heatmap'
import { circularMeanLng, escapeHtml, pointLngLat } from '../lib/geoSafe'
import {
  clearMapFocusConsumed,
  focusKey,
  markMapFocusConsumed,
  parseMapFocusSearch,
  stripMapFocusSearch,
} from '../lib/insightsUrl'
import {
  CENTROID_OVERVIEW_CAP,
  HEAT_POINT_SOFT_MAX,
  MIDLOC_OVERVIEW_CAP,
  filterPointFeatures,
  useDebouncedValue,
} from '../lib/perf'
import 'cesium/Build/Cesium/Widgets/widgets.css'

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
  search?: string
}

type Pt = {
  lat: number
  lng: number
  name?: string
  year?: number
  war_id?: string
  kind: string
  t?: number
  count?: number
  cellKm?: number
}

/**
 * Cesium globe with PointPrimitiveCollection (much cheaper than Entity points)
 * and hard caps when no war is selected.
 */
export function WarGlobe({
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
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const pointsCollectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null)
  const heatDataSourceRef = useRef<Cesium.CustomDataSource | null>(null)
  const theaterEntityRef = useRef<Cesium.Entity | null>(null)
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const [viewerReady, setViewerReady] = useState(false)
  const [pendingFocus, setPendingFocus] = useState(() =>
    Boolean(
      parseMapFocusSearch(search) ??
        parseMapFocusSearch(typeof window !== 'undefined' ? window.location.search : ''),
    ),
  )
  const skipFlyAfterFocusRef = useRef(false)
  const flownFocusKeyRef = useRef<string | null>(null)

  const dyFrom = useDebouncedValue(yearFrom, 140)
  const dyTo = useDebouncedValue(yearTo, 140)
  const showHeat = displayMode === 'heatmap'
  const [cameraHeight, setCameraHeight] = useState(18_000_000)
  const [pickInfo, setPickInfo] = useState<{ title: string; html: string } | null>(null)
  const heatCellKm = useMemo(
    () => heatCellKmForCameraHeight(cameraHeight, Boolean(selectedId)),
    [cameraHeight, selectedId],
  )
  const debouncedHeatCellKm = useDebouncedValue(heatCellKm, 120)

  const { points, battleTruncated } = useMemo(() => {
    const out: Pt[] = []
    let truncated = false
    if (!active) return { points: out, battleTruncated: truncated }

    if (showHeat) {
      const source = filterPointFeatures(battles, {
        yearFrom: dyFrom,
        yearTo: dyTo,
        selectedId,
        requireWarMatch: Boolean(selectedId),
        warIds: selectedId ? null : allowedWarIds,
        limit: HEAT_POINT_SOFT_MAX,
      })
      const absoluteMaxDensity =
        heatScale === 'absolute' ? peakHeatDensity(battles, debouncedHeatCellKm) || undefined : undefined
      for (const c of buildHeatCells(source, {
        cellKm: debouncedHeatCellKm,
        scaleMode: heatScale,
        absoluteMaxDensity,
      })) {
        out.push({
          lat: c.lat,
          lng: c.lng,
          name: `${c.count} events · ${c.densityPer1000Km2.toFixed(2)} per 1 000 km²`,
          kind: 'heat',
          t: c.t,
          count: c.count,
          cellKm: c.cellKm,
        })
      }
    } else {
      // Points mode only — heat cells are never mixed with pins.
      if (layers.battles) {
        const fc = filterPointFeatures(battles, {
          yearFrom: dyFrom,
          yearTo: dyTo,
          selectedId,
          requireWarMatch: Boolean(selectedId),
          warIds: selectedId ? null : allowedWarIds,
          limit: battleCap,
        })
        truncated = Boolean(fc?.truncated)
        for (const f of fc?.features ?? []) {
          const ll = pointLngLat(f.geometry)
          if (!ll) continue
          const [lng, lat] = ll
          const y = f.properties?.year as number | null
          out.push({
            lat,
            lng,
            name: String(f.properties?.name ?? ''),
            year: y ?? undefined,
            war_id: String(f.properties?.war_id ?? ''),
            kind: 'battle',
          })
        }
      }
      // MIDLOC is not war-linked; hide while focused on a war.
      if (layers.midloc && !selectedId) {
        const fc = filterPointFeatures(midloc, {
          yearFrom: dyFrom,
          yearTo: dyTo,
          limit: MIDLOC_OVERVIEW_CAP,
        })
        for (const f of fc?.features ?? []) {
          const ll = pointLngLat(f.geometry)
          if (!ll) continue
          const [lng, lat] = ll
          const y = f.properties?.year as number | null
          out.push({
            lat,
            lng,
            name: String(f.properties?.name ?? 'MIDLOC'),
            year: y ?? undefined,
            kind: 'midloc',
          })
        }
      }
      if (layers.centroids) {
        const fc = filterPointFeatures(warCentroids, {
          yearFrom: dyFrom,
          yearTo: dyTo,
          selectedId,
          requireWarMatch: Boolean(selectedId),
          warIds: selectedId ? null : allowedWarIds,
          yearMode: 'war_span',
          limit: selectedId ? undefined : CENTROID_OVERVIEW_CAP,
        })
        for (const f of fc?.features ?? []) {
          const ll = pointLngLat(f.geometry)
          if (!ll) continue
          const [lng, lat] = ll
          out.push({
            lat,
            lng,
            name: String(f.properties?.title ?? 'War'),
            year: (f.properties?.start_year as number | undefined) ?? undefined,
            war_id: String(f.properties?.war_id ?? ''),
            kind: 'centroid',
          })
        }
      }
    }
    return { points: out, battleTruncated: truncated }
  }, [
    active,
    battles,
    midloc,
    warCentroids,
    layers.battles,
    layers.midloc,
    layers.centroids,
    selectedId,
    allowedWarIds,
    dyFrom,
    dyTo,
    battleCap,
    showHeat,
    debouncedHeatCellKm,
    heatScale,
  ])

  const theaterRing = useMemo(() => {
    if (!active || !layers.theaters || !theaters || !selectedId) return null as number[][] | null
    // Keep theater for orphan selection (outside filters) — matches Map + detail banner
    const ringFromCoords = (ring: number[][]): number[][] | null => {
      const clean: number[][] = []
      for (const pt of ring) {
        const lng = Number(pt[0])
        const lat = Number(pt[1])
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        // Theater rings that cross the antimeridian are stored with lng up to ±360
        // (continuous outline); Cesium normalises them, so do not drop those points.
        if (lat < -90 || lat > 90 || lng < -360 || lng > 360) continue
        clean.push([lng, lat])
      }
      return clean.length >= 3 ? clean : null
    }
    const ringArea = (ring: number[][]) => {
      let minLng = 180
      let maxLng = -180
      let minLat = 90
      let maxLat = -90
      for (const [lng, lat] of ring) {
        minLng = Math.min(minLng, lng)
        maxLng = Math.max(maxLng, lng)
        minLat = Math.min(minLat, lat)
        maxLat = Math.max(maxLat, lat)
      }
      return Math.max(0, maxLng - minLng) * Math.max(0, maxLat - minLat)
    }
    let best: number[][] | null = null
    let bestArea = -1
    const consider = (coords: number[][]) => {
      const ring = ringFromCoords(coords)
      if (!ring) return
      const area = ringArea(ring)
      if (area >= bestArea) {
        bestArea = area
        best = ring
      }
    }
    for (const f of theaters.features) {
      if (!f.geometry) continue
      if (String(f.properties?.war_id ?? '') !== selectedId) continue
      if (f.geometry.type === 'Polygon') {
        consider((f.geometry.coordinates as number[][][])[0] ?? [])
      } else if (f.geometry.type === 'MultiPolygon') {
        for (const poly of f.geometry.coordinates as number[][][][]) {
          consider(poly[0] ?? [])
        }
      }
    }
    return best
  }, [active, theaters, layers.theaters, selectedId])

  // Create once on mount (parent keeps globe mounted after first visit via globeVisited)
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    const viewer = new Cesium.Viewer(containerRef.current, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      // Cesium InfoBox uses a sandboxed about:blank iframe → noisy console errors on Pages.
      // We show picks in a simple overlay instead.
      infoBox: false,
      selectionIndicator: false,
      baseLayer: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      targetFrameRate: 30,
    })

    viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 18,
        credit: 'Esri World Imagery',
      }),
    )

    const ctrl = viewer.scene.screenSpaceCameraController
    ctrl.enableZoom = true
    ctrl.enableRotate = true
    ctrl.enableTranslate = true
    ctrl.enableTilt = true
    ctrl.minimumZoomDistance = 500
    ctrl.maximumZoomDistance = 45_000_000
    ctrl.zoomFactor = 2.5
    ctrl.inertiaZoom = 0.8
    ctrl.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH]

    viewer.scene.globe.enableLighting = false
    viewer.scene.globe.depthTestAgainstTerrain = false
    viewer.scene.fog.enabled = true
    const sceneAny = viewer.scene as unknown as { fxaa?: boolean }
    if ('fxaa' in sceneAny) sceneAny.fxaa = false
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true

    const credit = viewer.cesiumWidget.creditContainer
    if (credit instanceof HTMLElement) credit.style.display = 'none'

    // Primitives are far cheaper than thousands of Entity points
    const pointsCol = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.OPAQUE })
    viewer.scene.primitives.add(pointsCol)
    pointsCollectionRef.current = pointsCol

    const heatDs = new Cesium.CustomDataSource('heat')
    viewer.dataSources.add(heatDs)
    heatDataSourceRef.current = heatDs

    // Request renders while the camera moves; report height for heat bin sizing
    const reportHeight = () => {
      const h = viewer.camera.positionCartographic?.height
      if (Number.isFinite(h)) setCameraHeight(h as number)
    }
    const removeMove = viewer.camera.changed.addEventListener(() => {
      viewer.scene.requestRender()
    })
    const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
      reportHeight()
      viewer.scene.requestRender()
    })
    reportHeight()

    // Lightweight pick → overlay (no Cesium InfoBox iframe)
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      const picked = viewer.scene.pick(movement.position)
      if (Cesium.defined(picked) && picked.id && typeof picked.id === 'object' && 'name' in picked.id) {
        const meta = picked.id as { name: string; description: string }
        setPickInfo({ title: meta.name, html: meta.description })
      } else if (Cesium.defined(picked) && picked.id instanceof Cesium.Entity) {
        const ent = picked.id
        const title = String(ent.name ?? 'Selected')
        const desc = ent.description?.getValue?.(viewer.clock.currentTime)
        setPickInfo({ title, html: typeof desc === 'string' ? desc : title })
      } else {
        setPickInfo(null)
      }
      viewer.scene.requestRender()
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    handlerRef.current = handler

    viewerRef.current = viewer
    setViewerReady(true)
    viewer.resize()
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(20, 15, 18_000_000),
    })
    viewer.scene.requestRender()

    return () => {
      removeMove()
      removeMoveEnd()
      handler.destroy()
      handlerRef.current = null
      pointsCollectionRef.current = null
      heatDataSourceRef.current = null
      theaterEntityRef.current = null
      viewerRef.current = null
      setViewerReady(false)
      setPickInfo(null)
      viewer.destroy()
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const viewer = viewerRef.current
    if (!viewer) return
    const id = requestAnimationFrame(() => {
      viewer.resize()
      viewer.scene.requestRender()
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  // Pause Cesium render loop while the other view is showing
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.useDefaultRenderLoop = active
    if (active) viewer.scene.requestRender()
  }, [active])

  // Sync point primitives (batched) + equal-area heat ellipses
  useEffect(() => {
    const viewer = viewerRef.current
    const pointsCol = pointsCollectionRef.current
    const heatDs = heatDataSourceRef.current
    if (!viewer || !pointsCol || !heatDs || !active) return

    pointsCol.removeAll()
    heatDs.entities.removeAll()

    const battleColor = Cesium.Color.fromCssColorString('#f0c36a')
    const midColor = Cesium.Color.fromCssColorString('#5aa8ff')
    const centroidColor = Cesium.Color.fromCssColorString('#a78bfa')
    const outline = Cesium.Color.fromCssColorString('#070d18')

    for (const p of points) {
      if (p.kind === 'heat') {
        const style = heatFill(p.t ?? 0.5)
        const m = style.fill.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)
        const color = m
          ? Cesium.Color.fromBytes(Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4]) * 255))
          : Cesium.Color.RED.withAlpha(0.35)
        const radiusM = heatDrawRadiusM(p.cellKm ?? debouncedHeatCellKm)
        heatDs.entities.add({
          name: 'Heat cell',
          description: p.name || 'Battle density',
          position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat),
          ellipse: {
            semiMajorAxis: radiusM,
            semiMinorAxis: radiusM,
            material: color,
            outline: true,
            outlineColor: color.withAlpha(Math.min(1, color.alpha + 0.15)),
            height: 0,
          },
        })
        continue
      }
      const color =
        p.kind === 'midloc' ? midColor : p.kind === 'centroid' ? centroidColor : battleColor
      pointsCol.add({
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 80),
        pixelSize: p.kind === 'centroid' ? 9 : p.kind === 'midloc' ? 7 : 8,
        color,
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: 0,
        scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.2, 1.4e7, 0.45),
        id: {
          name: p.name || p.kind,
          description: `${escapeHtml(p.name || p.kind)}<br/>${escapeHtml(p.year ?? '')}${p.war_id ? `<br/>${escapeHtml(p.war_id)}` : ''}`,
        },
      })
    }

    // Theater as single entity
    if (theaterEntityRef.current) {
      viewer.entities.remove(theaterEntityRef.current)
      theaterEntityRef.current = null
    }
    if (theaterRing && theaterRing.length >= 3) {
      const hierarchy = theaterRing.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat))
      theaterEntityRef.current = viewer.entities.add({
        name: 'Theater (approximate)',
        polygon: {
          hierarchy,
          material: Cesium.Color.fromCssColorString('#3ecfbf').withAlpha(0.14),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#3ecfbf'),
          height: 0,
        },
      })
    }

    viewer.scene.requestRender()
  }, [points, theaterRing, active, debouncedHeatCellKm])

  const lastFlownIdRef = useRef<string | null>(null)
  const lastFlownYearsRef = useRef<string | null>(null)
  const prevActiveRef = useRef(active)

  // One-shot fly to ?lat=&lng= (parity with Map FocusFromNumbers)
  useEffect(() => {
    if (!active) {
      setPendingFocus(false)
      return
    }
    const fromUrl =
      parseMapFocusSearch(search) ?? parseMapFocusSearch(window.location.search)
    if (!fromUrl) {
      clearMapFocusConsumed()
      flownFocusKeyRef.current = null
      setPendingFocus(false)
      return
    }
    const key = focusKey(fromUrl.lat, fromUrl.lng)
    const stripIfNeeded = () => {
      const stripped = stripMapFocusSearch(window.location.search)
      const nextSearch = stripped ? `?${stripped}` : ''
      const cur = `${window.location.pathname}${window.location.search}`
      const next = `${location.pathname}${nextSearch}`
      if (next !== cur) {
        navigate({ pathname: location.pathname, search: nextSearch }, { replace: true })
      }
    }
    if (flownFocusKeyRef.current === key) {
      markMapFocusConsumed(key)
      stripIfNeeded()
      setPendingFocus(false)
      return
    }
    if (!viewerReady || !viewerRef.current) {
      setPendingFocus(true)
      return
    }
    const viewer = viewerRef.current
    setPendingFocus(true)
    let cancelled = false
    let flyStarted = false
    let pendingTimer: number | undefined
    const fly = () => {
      if (cancelled || !viewerRef.current) return
      flyStarted = true
      flownFocusKeyRef.current = key
      markMapFocusConsumed(key)
      skipFlyAfterFocusRef.current = true
      try {
        viewer.camera.cancelFlight()
      } catch {
        /* ignore */
      }
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(fromUrl.lng, fromUrl.lat, 1_200_000),
        duration: 1.05,
      })
      stripIfNeeded()
      pendingTimer = window.setTimeout(() => {
        if (!cancelled) setPendingFocus(false)
      }, 1100)
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(fly)
    })
    return () => {
      cancelled = true
      if (pendingTimer != null) window.clearTimeout(pendingTimer)
      if (!flyStarted) {
        try {
          viewer.camera.cancelFlight()
        } catch {
          /* ignore */
        }
        setPendingFocus(false)
      }
    }
  }, [active, search, navigate, location.pathname, viewerReady])

  useEffect(() => {
    const viewer = viewerRef.current
    const becameActive = active && !prevActiveRef.current
    prevActiveRef.current = active
    const yearKey = `${dyFrom}:${dyTo}`

    if (!viewer || !active) return
    if (pendingFocus) return
    if (skipFlyAfterFocusRef.current) {
      skipFlyAfterFocusRef.current = false
      if (selectedId) {
        lastFlownIdRef.current = selectedId
        lastFlownYearsRef.current = yearKey
      }
      return
    }
    if (!selectedId) {
      lastFlownIdRef.current = null
      lastFlownYearsRef.current = null
      return
    }

    // Years changed for the same war — allow a re-fly (Map refits on year change)
    if (lastFlownYearsRef.current != null && lastFlownYearsRef.current !== yearKey) {
      lastFlownIdRef.current = null
    }

    // Map↔Globe switch with same war + same years — keep the user's camera
    if (
      becameActive &&
      lastFlownIdRef.current === selectedId &&
      lastFlownYearsRef.current === yearKey
    ) {
      return
    }

    const positions: Cesium.Cartesian3[] = []
    let first: [number, number] | null = null
    let west = 180
    let east = -180
    let south = 90
    let north = -90
    let used = 0

    const seenLngs: number[] = []
    const addLngLat = (lng: number, lat: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
      if (!first) first = [lng, lat]
      seenLngs.push(lng)
      west = Math.min(west, lng)
      east = Math.max(east, lng)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
      positions.push(Cesium.Cartesian3.fromDegrees(lng, lat))
      used++
    }

    const yearScoped = filterPointFeatures(battles, {
      yearFrom: dyFrom,
      yearTo: dyTo,
      selectedId,
      requireWarMatch: true,
      limit: 4000,
    })
    for (const f of yearScoped?.features ?? []) {
      const ll = pointLngLat(f.geometry)
      if (!ll) continue
      addLngLat(ll[0], ll[1])
    }

    // Include theater with battles (Map Fit parity) when theaters layer is on
    if (theaterRing) {
      for (const [lng, lat] of theaterRing) addLngLat(lng, lat)
    }

    // Proxy-only wars: centroid fallback
    if (!used) {
      const cents = filterPointFeatures(warCentroids, {
        yearFrom: dyFrom,
        yearTo: dyTo,
        selectedId,
        requireWarMatch: true,
        yearMode: 'war_span',
        limit: 1,
      })
      for (const f of cents?.features ?? []) {
        const ll = pointLngLat(f.geometry)
        if (!ll) continue
        addLngLat(ll[0], ll[1])
      }
    }

    // No geometry yet (battles/theaters still loading) — do not mark as flown
    if (!used || !first) return

    lastFlownIdRef.current = selectedId
    lastFlownYearsRef.current = yearKey

    try {
      viewer.camera.cancelFlight()
    } catch {
      /* older Cesium builds */
    }

    const lonSpan = east - west
    // west/east from Math.min/max so lonSpan is always >= 0; >180 means Pacific wrap
    const crossesDateline = lonSpan > 180
    const tooWide = crossesDateline || lonSpan > 120 || north - south > 80

    if (tooWide) {
      // Centre on the circular mean of all points (not just the first one) and
      // pull back far enough to see a continent- or ocean-spanning war whole.
      const midLng = circularMeanLng(seenLngs) ?? first[0]
      const midLat = Math.max(-60, Math.min(60, (south + north) / 2))
      const altitude = crossesDateline || lonSpan > 120 ? 14_000_000 : 6_000_000
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(midLng, midLat, altitude),
        duration: 1.0,
      })
    } else if (positions.length >= 2) {
      try {
        const sphere = Cesium.BoundingSphere.fromPoints(positions)
        viewer.camera.flyToBoundingSphere(sphere, {
          duration: 1.0,
          offset: new Cesium.HeadingPitchRange(0, -0.55, sphere.radius * 2.8),
        })
      } catch {
        const pad = 1.5
        try {
          viewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(west - pad, south - pad, east + pad, north + pad),
            duration: 1.0,
          })
        } catch {
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(first[0], first[1], 2_500_000),
            duration: 1.0,
          })
        }
      }
    } else {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(first[0], first[1], 2_500_000),
        duration: 1.0,
      })
    }

    return () => {
      try {
        viewer.camera.cancelFlight()
      } catch {
        /* ignore */
      }
    }
  }, [selectedId, battles, warCentroids, active, theaterRing, dyFrom, dyTo, pendingFocus])

  const zoomBy = (direction: 'in' | 'out') => {
    const viewer = viewerRef.current
    if (!viewer) return
    const height = viewer.camera.positionCartographic.height
    const step = Math.max(height * 0.32, 800)
    if (direction === 'in') {
      const min = viewer.scene.screenSpaceCameraController.minimumZoomDistance
      if (height <= min * 1.2) return
      viewer.camera.zoomIn(step)
    } else {
      const max = viewer.scene.screenSpaceCameraController.maximumZoomDistance
      if (height >= max * 0.95) return
      viewer.camera.zoomOut(step)
    }
    viewer.scene.requestRender()
  }

  return (
    <div className="globe-shell" aria-hidden={!active} style={{ visibility: active ? 'visible' : 'hidden' }}>
      <div className="globe-root" ref={containerRef} />
      {pickInfo && (
        <div className="globe-pick" role="status">
          <div className="globe-pick-head">
            <strong className="globe-pick-title">{pickInfo.title}</strong>
            <button
              type="button"
              className="icon-btn globe-pick-close"
              onClick={() => setPickInfo(null)}
              aria-label="Dismiss selection"
            >
              ×
            </button>
          </div>
          <div
            className="globe-pick-body"
            dangerouslySetInnerHTML={{ __html: pickInfo.html }}
          />
        </div>
      )}
      <div className="globe-zoom" role="group" aria-label="Globe zoom">
        <button type="button" className="globe-zoom-btn" onClick={() => zoomBy('in')} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button type="button" className="globe-zoom-btn" onClick={() => zoomBy('out')} title="Zoom out" aria-label="Zoom out">
          −
        </button>
      </div>
      {battleTruncated && displayMode !== 'heatmap' && (
        <div className="perf-badge" title="Points load in stages; select a war for a denser sample">
          Loading denser battle sample…
        </div>
      )}
      {displayMode === 'heatmap' && (
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
    </div>
  )
}
