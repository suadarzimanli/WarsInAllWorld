/** Safe point extraction from GeoJSON-like features. */
export function pointLngLat(
  geometry: { type?: string; coordinates?: unknown } | null | undefined,
): [number, number] | null {
  if (!geometry || geometry.type !== 'Point') return null
  const c = geometry.coordinates
  if (!Array.isArray(c) || c.length < 2) return null
  // Reject null/undefined before Number() — Number(null) === 0 (Null Island)
  if (typeof c[0] !== 'number' || typeof c[1] !== 'number') return null
  const lng = c[0]
  const lat = c[1]
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return [lng, lat]
}

/** Escape text before interpolating into Leaflet/Cesium HTML popups. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Express longitudes on the shortest continuous arc containing them all
 * (same rule as the ETL's `unwrap_lngs`). Cuts the circle at the largest
 * empty gap; points west of the cut get +360. Unchanged when the largest gap
 * already spans the antimeridian. Lets a Pacific war's points sit on the same
 * Leaflet world copy as its theater outline.
 */
export function unwrapLngs(lngs: number[]): number[] {
  const xs = [...new Set(lngs.filter(Number.isFinite))].sort((a, b) => a - b)
  if (xs.length < 2) return [...lngs]
  let bestGap = 360 - (xs[xs.length - 1]! - xs[0]!)
  let cutAfter: number | null = null
  for (let i = 0; i < xs.length - 1; i++) {
    const gap = xs[i + 1]! - xs[i]!
    if (gap > bestGap) {
      bestGap = gap
      cutAfter = xs[i]!
    }
  }
  if (cutAfter === null) return [...lngs]
  const cut = cutAfter
  const out = lngs.map((v) => (v <= cut ? v + 360 : v))
  // Keep the arc's midpoint on the main world copy (same rule as the ETL).
  const mid = (Math.min(...out) + Math.max(...out)) / 2
  return mid > 180 ? out.map((v) => v - 360) : out
}

/** Centre longitude of a set of points on its shortest continuous arc. */
export function arcCenterLng(lngs: number[]): number | null {
  const vals = lngs.filter(Number.isFinite)
  if (!vals.length) return null
  const u = unwrapLngs(vals)
  return (Math.min(...u) + Math.max(...u)) / 2
}

type PointFC = {
  type: 'FeatureCollection'
  features: Array<{ type: 'Feature'; geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }>
}

/** Copy of a point collection with longitudes unwrapped (non-points untouched). */
export function unwrapPointCollection<T extends PointFC>(fc: T): T {
  const idx: number[] = []
  const lngs: number[] = []
  fc.features.forEach((f, i) => {
    const ll = pointLngLat(f.geometry)
    if (ll) {
      idx.push(i)
      lngs.push(ll[0])
    }
  })
  const out = unwrapLngs(lngs)
  if (out.every((v, k) => v === lngs[k])) return fc
  const features = fc.features.slice()
  idx.forEach((fi, k) => {
    const f = features[fi]!
    const [, lat] = f.geometry!.coordinates as [number, number]
    features[fi] = { ...f, geometry: { type: 'Point', coordinates: [out[k], lat] } }
  })
  return { ...fc, features }
}

/** Mean longitude on the circle (antimeridian-safe), in [-180, 180]; null if empty. */
export function circularMeanLng(lngs: number[]): number | null {
  const vals = lngs.filter(Number.isFinite)
  if (!vals.length) return null
  let sx = 0
  let sy = 0
  for (const v of vals) {
    const r = (v * Math.PI) / 180
    sx += Math.cos(r)
    sy += Math.sin(r)
  }
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) return vals.reduce((a, b) => a + b, 0) / vals.length
  return (Math.atan2(sy, sx) * 180) / Math.PI
}
