import { describe, expect, it } from 'vitest'
import { clearShift, type Box } from './chromeAvoid'

const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h })
const hit = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const moved = (b: Box, s: { dx: number; dy: number }) => box(b.left + s.dx, b.top + s.dy, b.right - b.left, b.bottom - b.top)

const map = box(0, 0, 1366, 700)
// Points/Heat switch + hint, top centre (the reported overlap)
const toggle = box(560, 10, 250, 44)
const hint = box(540, 58, 290, 22)

describe('clearShift (popups vs floating UI)', () => {
  it('moves a popup that opens under the Points/Heat switch to below it', () => {
    const popup = box(600, 20, 160, 70)
    const s = clearShift(popup, [toggle, hint], map)
    const after = moved(popup, s)
    expect(hit(after, toggle)).toBe(false)
    expect(hit(after, hint)).toBe(false)
    expect(after.top).toBeGreaterThanOrEqual(hint.bottom)
  })

  it('leaves a popup that is already clear alone', () => {
    expect(clearShift(box(100, 300, 160, 70), [toggle, hint], map)).toEqual({ dx: 0, dy: 0 })
  })

  it('keeps the popup inside the map edges', () => {
    const s = clearShift(box(1300, -30, 160, 70), [], map)
    const after = moved(box(1300, -30, 160, 70), s)
    expect(after.right).toBeLessThanOrEqual(map.right)
    expect(after.top).toBeGreaterThanOrEqual(map.top)
  })

  it('steps out from under an open side panel', () => {
    const panel = box(966, 0, 400, 700)
    const popup = box(1000, 300, 160, 70)
    const after = moved(popup, clearShift(popup, [panel, toggle], map))
    expect(hit(after, panel)).toBe(false)
  })

  it('does not jump onto another control while avoiding one', () => {
    const zoom = box(10, 10, 34, 70)
    const legend = box(10, 600, 220, 90)
    const popup = box(20, 40, 160, 70)
    const after = moved(popup, clearShift(popup, [zoom, legend, toggle, hint], map))
    for (const o of [zoom, legend, toggle, hint]) expect(hit(after, o)).toBe(false)
  })
})
