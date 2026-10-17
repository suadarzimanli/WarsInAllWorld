import type { GeoJSONFeatureCollection } from '../types'
import { pointLngLat } from './geoSafe'

/** Mean Earth km per degree of latitude (WGS84 approx). */
const KM_PER_DEG_LAT = 111.32

/** Discrete bin sizes so zoom tweaks do not thrash recomputation. */
const CELL_KM_STEPS = [40, 55, 75, 100, 140, 200, 280, 400, 550, 750, 1000, 1400] as const

export type HeatCell = {
  lat: number
  lng: number
  count: number
  /** Events per 1 000 km² in this bin. */
  densityPer1000Km2: number
  /** 0..1 intensity within the current filtered set (log density). */
  t: number
  /** Equal-area bin edge length (km). */
  cellKm: number
}

function snapHeatCellKm(km: number): number {
  const target = Math.max(CELL_KM_STEPS[0], Math.min(CELL_KM_STEPS[CELL_KM_STEPS.length - 1], km))
  let best: number = CELL_KM_STEPS[0]
  let bestDist = Math.abs(best - target)
  for (const s of CELL_KM_STEPS) {
    const d = Math.abs(s - target)
    if (d < bestDist) {
      best = s
      bestDist = d
    }
  }
  return best
}

/**
 * Bin size from Leaflet zoom: coarse when zoomed out, fine when zoomed in.
 * At world view (z≈2) cells are ~continental; at regional zoom they shrink.
 */
export function heatCellKmForMapZoom(zoom: number, focused = false): number {
  const z = Math.max(1, Math.min(14, zoom))
  // Larger edge when far out so blobs stay visible on a world view
  let km = 2800 / Math.pow(2, Math.max(0, z - 1))
  if (focused) km *= 0.7
  return snapHeatCellKm(km)
}

/**
 * Bin size from Cesium camera height (meters above ellipsoid).
 * Maps height → equivalent map zoom, then reuses the Leaflet ladder.
 */
export function heatCellKmForCameraHeight(heightM: number, focused = false): number {
  const h = Math.max(40_000, Math.min(45_000_000, heightM))
  // World view ~2e7 m ≈ zoom 2; closer camera → higher zoom
  const z = Math.log2(45_000_000 / h)
  return heatCellKmForMapZoom(z, focused)
}

/** Draw radius (meters) so blobs roughly cover their equal-area bin. */
export function heatDrawRadiusM(cellKm: number): number {
  return cellKm * 550
}

/** Transparent cool → warm → red (does not wipe the basemap). */
export function heatFill(t: number): { fill: string; stroke: string; alpha: number } {
  const x = Math.max(0, Math.min(1, t))
  let r: number
  let g: number
  let b: number
  if (x < 0.33) {
    const u = x / 0.33
    r = Math.round(30 + u * 200)
    g = Math.round(180 - u * 40)
    b = Math.round(200 - u * 180)
  } else if (x < 0.66) {
    const u = (x - 0.33) / 0.33
    r = Math.round(230 + u * 25)
    g = Math.round(140 - u * 90)
    b = Math.round(20 + u * 10)
  } else {
    const u = (x - 0.66) / 0.34
    r = Math.round(255)
    g = Math.round(50 - u * 40)
    b = Math.round(30 - u * 20)
  }
  const alpha = 0.16 + x * 0.46
  return {
    fill: `rgba(${r},${g},${b},${alpha})`,
    stroke: `rgba(${r},${g},${b},${Math.min(0.55, alpha + 0.12)})`,
    alpha,
  }
}

/**
 * Equal-area density of battle points.
 *
 * - Bins use a ~constant km edge (lat step fixed; lng step grows toward the poles
 *   via cosφ) so high latitudes are not overstated vs the equator.
 * - Intensity is log-scaled density (events / km²), relative to the max bin in
 *   this filtered set — comparable within one filter state.
 * - Soft-dedupes near-identical multi-source copies (war + year + ~100 m + name stem)
 *   in addition to exact `event_id` matches.
 */
export function buildHeatCells(
  fc: GeoJSONFeatureCollection | null,
  opts?: {
    cellKm?: number
    /** relative = scale within this set; absolute = vs absoluteMaxDensity */
    scaleMode?: 'relative' | 'absolute'
    /** Reference max density (events/km²) for absolute coloring */
    absoluteMaxDensity?: number
  },
): HeatCell[] {
  if (!fc?.features.length) return []
  const cellKm = opts?.cellKm ?? heatCellKmForMapZoom(3, false)
  const dLat = cellKm / KM_PER_DEG_LAT
  const areaKm2 = cellKm * cellKm
  const scaleMode = opts?.scaleMode ?? 'relative'

  type Bucket = { latSum: number; lngSum: number; n: number }
  const buckets = new Map<string, Bucket>()
  const seenIds = new Set<string>()
  const seenSoft = new Set<string>()

  for (const f of fc.features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue
    const eid = f.properties?.event_id
    if (eid != null && eid !== '') {
      const id = String(eid)
      if (seenIds.has(id)) continue
      seenIds.add(id)
    }
    const ll = pointLngLat(f.geometry)
    if (!ll) continue
    const [lng, lat] = ll

    const wid = String(f.properties?.war_id ?? '')
    const year = f.properties?.year ?? ''
    const name = String(f.properties?.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24)
    const soft = `${wid}|${year}|${lat.toFixed(3)}|${lng.toFixed(3)}|${name}`
    if (seenSoft.has(soft)) continue
    seenSoft.add(soft)

    const iy = Math.floor((lat + 90) / dLat)
    const latCenter = (iy + 0.5) * dLat - 90
    const cos = Math.max(0.05, Math.cos((latCenter * Math.PI) / 180))
    const dLng = cellKm / (KM_PER_DEG_LAT * cos)
    // Note: bins near ±180° can split across the antimeridian (known limitation).
    const ix = Math.floor((lng + 180) / dLng)
    const key = `${iy}:${ix}`

    const b = buckets.get(key)
    if (b) {
      b.latSum += lat
      b.lngSum += lng
      b.n += 1
    } else {
      buckets.set(key, { latSum: lat, lngSum: lng, n: 1 })
    }
  }

  if (!buckets.size) return []

  let maxDensity = 0
  const raw: Array<{ lat: number; lng: number; count: number; density: number }> = []
  for (const b of buckets.values()) {
    const density = b.n / areaKm2
    maxDensity = Math.max(maxDensity, density)
    raw.push({
      lat: b.latSum / b.n,
      lng: b.lngSum / b.n,
      count: b.n,
      density,
    })
  }

  const refMax =
    scaleMode === 'absolute' && opts?.absoluteMaxDensity != null && opts.absoluteMaxDensity > 0
      ? opts.absoluteMaxDensity
      : maxDensity
  const logMax = Math.log1p(refMax)
  const cells: HeatCell[] = raw.map((r) => ({
    lat: r.lat,
    lng: r.lng,
    count: r.count,
    densityPer1000Km2: r.density * 1000,
    t: logMax > 0 ? Math.min(1, Math.log1p(r.density) / logMax) : 0,
    cellKm,
  }))

  cells.sort((a, b) => a.t - b.t)
  return cells
}

/** Peak density (events/km²) for absolute heat scaling at a given cell size. */
const peakDensityCache = new WeakMap<object, Map<number, number>>()

export function peakHeatDensity(
  fc: GeoJSONFeatureCollection | null,
  cellKm: number,
): number {
  if (!fc) return 0
  const km = Math.round(cellKm)
  let byKm = peakDensityCache.get(fc)
  if (!byKm) {
    byKm = new Map()
    peakDensityCache.set(fc, byKm)
  }
  const hit = byKm.get(km)
  if (hit != null) return hit
  const cells = buildHeatCells(fc, { cellKm: km, scaleMode: 'relative' })
  const peak = cells.length ? Math.max(...cells.map((c) => c.densityPer1000Km2 / 1000)) : 0
  byKm.set(km, peak)
  return peak
}
