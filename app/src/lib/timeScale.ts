/**
 * Piecewise-linear "warped" time axis for the scrubber.
 *
 * Mapped battles are extremely uneven over time (a handful per century in
 * antiquity, thousands per decade after 1900). A linear axis would squeeze the
 * modern era into a sliver, so each era gets a fixed share of the width.
 * Year → x is monotonic and invertible; ticks and histogram bins use it.
 */

/** [era start year, share of width] — shares are renormalised to the data domain. */
const ERA_WEIGHTS: Array<[number, number]> = [
  [-Infinity, 0.1], // antiquity
  [0, 0.09],
  [1000, 0.1],
  [1500, 0.19],
  [1800, 0.17],
  [1900, 0.35],
]

export type TimeScale = {
  min: number
  max: number
  /** year → 0..1 */
  x: (year: number) => number
  /** 0..1 → year (fractional) */
  year: (x: number) => number
  /** Tick years that fit at `widthPx` with at least `minGapPx` between labels */
  ticks: (widthPx: number, minGapPx?: number) => number[]
}

export function makeTimeScale(min: number, max: number): TimeScale {
  if (!(max > min)) max = min + 1
  // Segment boundaries inside [min, max]
  const knots: number[] = [min]
  const weights: number[] = []
  for (let i = 0; i < ERA_WEIGHTS.length; i++) {
    const [start, w] = ERA_WEIGHTS[i]!
    const end = i + 1 < ERA_WEIGHTS.length ? ERA_WEIGHTS[i + 1]![0] : Infinity
    const a = Math.max(start, min)
    const b = Math.min(end, max)
    if (b <= a) continue
    if (a !== knots[knots.length - 1]) knots.push(a)
    knots.push(b)
    weights.push(w)
  }
  // knots now has weights.length + 1 entries
  const total = weights.reduce((s, w) => s + w, 0)
  const xs = [0]
  for (const w of weights) xs.push(xs[xs.length - 1]! + w / total)
  xs[xs.length - 1] = 1

  const x = (year: number) => {
    if (year <= min) return 0
    if (year >= max) return 1
    for (let i = 0; i < weights.length; i++) {
      const a = knots[i]!
      const b = knots[i + 1]!
      if (year <= b) return xs[i]! + ((year - a) / (b - a)) * (xs[i + 1]! - xs[i]!)
    }
    return 1
  }
  const year = (t: number) => {
    if (t <= 0) return min
    if (t >= 1) return max
    for (let i = 0; i < weights.length; i++) {
      if (t <= xs[i + 1]!) {
        const f = (t - xs[i]!) / (xs[i + 1]! - xs[i]!)
        return knots[i]! + f * (knots[i + 1]! - knots[i]!)
      }
    }
    return max
  }
  const CANDIDATES = [-3000, -2000, -1000, -500, 0, 500, 1000, 1250, 1500, 1600, 1700, 1750, 1800, 1850, 1900, 1925, 1950, 1975, 2000]
  const ticks = (widthPx: number, minGapPx = 44) => {
    const out: number[] = []
    let lastPx = -Infinity
    for (const y of CANDIDATES) {
      if (y <= min || y >= max) continue
      const px = x(y) * widthPx
      if (px - lastPx < minGapPx || px < minGapPx / 2 || px > widthPx - minGapPx / 2) continue
      out.push(y)
      lastPx = px
    }
    return out
  }
  return { min, max, x, year, ticks }
}

/** Sorted copy of all battle years (for fast range counts). */
export function sortedYears(years: Iterable<number | null | undefined>): Float64Array {
  const arr: number[] = []
  for (const y of years) if (y != null && Number.isFinite(y)) arr.push(y)
  return Float64Array.from(arr).sort()
}

/** Number of values v with lo <= v <= hi in a sorted array. */
export function countInRange(sorted: Float64Array, lo: number, hi: number): number {
  const lower = (v: number) => {
    let a = 0
    let b = sorted.length
    while (a < b) {
      const m = (a + b) >> 1
      if (sorted[m]! < v) a = m + 1
      else b = m
    }
    return a
  }
  const upper = (v: number) => {
    let a = 0
    let b = sorted.length
    while (a < b) {
      const m = (a + b) >> 1
      if (sorted[m]! <= v) a = m + 1
      else b = m
    }
    return a
  }
  if (hi < lo) return 0
  return upper(hi) - lower(lo)
}

/**
 * Battles per year in each bin. Bins on the warped axis cover very different
 * spans (≈90 years each in antiquity, ≈2 after 1900), so raw counts would
 * inflate early eras; dividing by the span keeps bar heights comparable.
 */
export function densityPerYear(counts: number[], scale: TimeScale): number[] {
  const n = counts.length
  return counts.map((c, i) => {
    const span = scale.year((i + 1) / n) - scale.year(i / n)
    return span > 0 ? c / span : 0
  })
}

/** Counts per equal-width bin on the warped axis. */
export function histogram(sorted: Float64Array, scale: TimeScale, bins: number): number[] {
  const out = new Array<number>(bins).fill(0)
  for (let i = 0; i < bins; i++) {
    const lo = scale.year(i / bins)
    const hi = scale.year((i + 1) / bins)
    // half-open bins, last one closed
    out[i] = countInRange(sorted, lo, i === bins - 1 ? hi : hi - 1e-9)
  }
  return out
}

/** Human year label: 1944, 480 BCE. */
export function yearText(y: number): string {
  const r = Math.round(y)
  return r < 0 ? `${-r} BCE` : String(r)
}
