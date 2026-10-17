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
