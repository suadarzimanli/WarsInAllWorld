/**
 * Keep transient boxes (map popups, globe pick card) clear of the floating UI
 * that sits on top of the map: Points/Heat switch, legend, side panels, zoom
 * buttons, badges. Leaflet only keeps popups inside the map edge; it does not
 * know about this chrome, so popups near the top used to open underneath the
 * Points/Heat switch.
 */

/** Every floating control drawn over the map/globe surface. */
export const FLOATING_CHROME_SELECTOR = [
  '.display-mode-wrap > *',
  '.atlas-legend',
  '.panel-left',
  '.panel-right',
  '.explorer-toggle',
  '.mobile-detail-fab',
  '.leaflet-control-zoom',
  '.globe-zoom',
  '.perf-badge',
  '.heat-legend',
  '.map-credit',
  '.scrub',
].join(', ')

export type Box = { left: number; top: number; right: number; bottom: number }

const overlaps = (a: Box, b: Box, m: number) =>
  a.left < b.right + m && a.right > b.left - m && a.top < b.bottom + m && a.bottom > b.top - m

const move = (b: Box, dx: number, dy: number): Box => ({
  left: b.left + dx,
  right: b.right + dx,
  top: b.top + dy,
  bottom: b.bottom + dy,
})

const inside = (b: Box, bounds: Box) =>
  b.left >= bounds.left - 0.5 && b.right <= bounds.right + 0.5 && b.top >= bounds.top - 0.5 && b.bottom <= bounds.bottom + 0.5

/**
 * Smallest shift (dx, dy) that keeps `target` inside `bounds` and off every
 * obstacle (with `margin` px of air). Best effort: if no clear spot exists
 * (tiny screen, panel covering most of the map), it returns the shift that
 * clears the most obstacles while staying in bounds.
 */
export function clearShift(target: Box, obstacles: Box[], bounds: Box, margin = 8): { dx: number; dy: number } {
  // 1) Into bounds (pin the top/left edge if the box is larger than the bounds)
  let dx = 0
  let dy = 0
  if (target.right > bounds.right - margin) dx = bounds.right - margin - target.right
  if (target.left + dx < bounds.left + margin) dx = bounds.left + margin - target.left
  if (target.bottom > bounds.bottom - margin) dy = bounds.bottom - margin - target.bottom
  if (target.top + dy < bounds.top + margin) dy = bounds.top + margin - target.top

  const inner: Box = {
    left: bounds.left + margin,
    top: bounds.top + margin,
    right: bounds.right - margin,
    bottom: bounds.bottom - margin,
  }
  const hits = (b: Box) => obstacles.filter((o) => overlaps(b, o, margin)).length

  // 2) Step off obstacles, one at a time, choosing the shortest move that
  //    stays in bounds and does not land on more obstacles.
  for (let i = 0; i < 8; i++) {
    const cur = move(target, dx, dy)
    const hit = obstacles.find((o) => overlaps(cur, o, margin))
    if (!hit) break
    const cands: [number, number][] = [
      [0, hit.bottom + margin - cur.top], // below it
      [0, hit.top - margin - cur.bottom], // above it
      [hit.right + margin - cur.left, 0], // right of it
      [hit.left - margin - cur.right, 0], // left of it
    ]
    const scored = cands
      .map(([x, y]) => {
        const b = move(cur, x, y)
        return { x, y, ok: inside(b, inner), n: hits(b), cost: Math.abs(x) + Math.abs(y) }
      })
      .filter((c) => c.ok)
      .sort((a, b) => a.n - b.n || a.cost - b.cost)
    const best = scored[0]
    if (!best || best.n >= hits(cur)) break // nowhere better to go
    dx += best.x
    dy += best.y
  }
  return { dx: Math.round(dx), dy: Math.round(dy) }
}

const toBox = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

/** Visible floating-chrome rectangles under `root` (viewport coordinates). */
export function chromeBoxes(root: ParentNode, exclude?: Element | null): Box[] {
  const out: Box[] = []
  root.querySelectorAll(FLOATING_CHROME_SELECTOR).forEach((el) => {
    if (exclude && (el === exclude || el.contains(exclude) || exclude.contains(el))) return
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    out.push(toBox(r))
  })
  return out
}

/** Shift needed for `el` to sit clear of the chrome in its view, within `boundsEl`. */
export function elementClearShift(el: Element, boundsEl: Element, margin = 8) {
  const root = el.closest('.view-body') ?? document
  return clearShift(toBox(el.getBoundingClientRect()), chromeBoxes(root, el), toBox(boundsEl.getBoundingClientRect()), margin)
}
