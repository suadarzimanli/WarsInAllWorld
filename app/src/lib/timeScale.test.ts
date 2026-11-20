import { describe, expect, it } from 'vitest'
import { countInRange, histogram, makeTimeScale, sortedYears, yearText } from './timeScale'

describe('warped time scale', () => {
  const s = makeTimeScale(-1500, 2025)

  it('maps the domain ends to 0 and 1 and clamps outside', () => {
    expect(s.x(-1500)).toBe(0)
    expect(s.x(2025)).toBe(1)
    expect(s.x(-5000)).toBe(0)
    expect(s.x(3000)).toBe(1)
  })

  it('is monotonic and invertible', () => {
    let prev = -1
    for (let y = -1500; y <= 2025; y += 7) {
      const v = s.x(y)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
      expect(s.year(v)).toBeCloseTo(y, 6)
    }
  })

  it('gives the modern era much more room than a linear axis', () => {
    const modern = s.x(2025) - s.x(1900)
    expect(modern).toBeGreaterThan(0.3) // linear would be 125/3525 ≈ 0.035
  })

  it('works when the data starts after year 0', () => {
    const t = makeTimeScale(1700, 2000)
    expect(t.x(1700)).toBe(0)
    expect(t.x(2000)).toBe(1)
    expect(t.year(t.x(1850))).toBeCloseTo(1850, 6)
  })

  it('picks ticks that do not crowd', () => {
    const ticks = s.ticks(300, 44)
    const px = ticks.map((y) => s.x(y) * 300)
    for (let i = 1; i < px.length; i++) expect(px[i]! - px[i - 1]!).toBeGreaterThanOrEqual(44)
  })
})

describe('range counts and histogram', () => {
  const ys = sortedYears([1944, 1914, 1944, null, 1815, 1945, undefined, -480])

  it('counts inclusive ranges', () => {
    expect(countInRange(ys, 1939, 1945)).toBe(3)
    expect(countInRange(ys, 1944, 1944)).toBe(2)
    expect(countInRange(ys, -1000, 0)).toBe(1)
    expect(countInRange(ys, 2000, 1900)).toBe(0)
  })

  it('histogram bins add up to all years in the domain', () => {
    const s = makeTimeScale(-500, 2000)
    const h = histogram(ys, s, 50)
    expect(h.reduce((a, b) => a + b, 0)).toBe(6)
  })

  it('labels BCE years', () => {
    expect(yearText(-480)).toBe('480 BCE')
    expect(yearText(1944.4)).toBe('1944')
  })
})

describe('histogram density', () => {
  it('turns bin counts into battles per year so wide ancient bins are not inflated', async () => {
    const { densityPerYear } = await import('./timeScale')
    const s = makeTimeScale(-1468, 2025)
    const n = 160
    // the same 10 battles in an ancient bin vs a 1940s bin
    const counts = new Array(n).fill(0)
    counts[2] = 10
    counts[150] = 10
    const d = densityPerYear(counts, s)
    expect(d[150]! / d[2]!).toBeGreaterThan(20) // ~92 vs ~2.2 years per bin
  })
})
