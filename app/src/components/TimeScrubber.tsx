import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { GeoJSONFeatureCollection } from '../types'
import { countInRange, densityPerYear, histogram, makeTimeScale, sortedYears, yearText } from '../lib/timeScale'

type Props = {
  battles: GeoJSONFeatureCollection | null
  yearFrom: number
  yearTo: number
  yearMin: number
  yearMax: number
  onRange: (from: number, to: number) => void
  /** Wars passing the current non-year filters (source, coverage, search); null = all */
  warIds?: Set<string> | null
  /** Span of the selected war, marked in gold on the track */
  selectedSpan?: [number, number] | null
}

const ERAS: Array<{ label: string; from: number; to: number }> = [
  { label: 'Ancient', from: -Infinity, to: 499 },
  { label: 'Medieval', from: 500, to: 1499 },
  { label: '1500–1799', from: 1500, to: 1799 },
  { label: '1800s', from: 1800, to: 1899 },
  { label: '1900–1945', from: 1900, to: 1945 },
  { label: 'Cold War', from: 1946, to: 1991 },
  { label: 'Since 1992', from: 1992, to: Infinity },
  { label: 'All', from: -Infinity, to: Infinity },
]
/** Years per second while playing */
const SPEEDS = [
  { label: '1×', yps: 2 },
  { label: '5×', yps: 10 },
  { label: '25×', yps: 50 },
]
const BINS = 160
const COMMIT_MS = 140

type Drag = { kind: 'from' | 'to' | 'move'; grabYear: number; from0: number; to0: number }

/**
 * Time scrubber: battle histogram on a warped time axis, a draggable range
 * brush, era presets and playback. Drives the shared year filter.
 */
export function TimeScrubber({ battles, yearFrom, yearTo, yearMin, yearMax, onRange, warIds = null, selectedSpan }: Props) {
  const scale = useMemo(() => makeTimeScale(yearMin, yearMax), [yearMin, yearMax])
  const years = useMemo(
    () =>
      sortedYears(
        (battles?.features ?? [])
          .filter((f) => !warIds || warIds.has(String(f.properties?.war_id ?? '')))
          .map((f) => f.properties?.year as number | null),
      ),
    [battles, warIds],
  )
  // Bar height = mapped battles per year (bins span unequal years on the warped axis)
  const bins = useMemo(() => densityPerYear(histogram(years, scale, BINS), scale), [years, scale])

  const clampYear = useCallback((y: number) => Math.min(yearMax, Math.max(yearMin, Math.round(y))), [yearMin, yearMax])
  const committed: [number, number] = [
    Number.isFinite(yearFrom) ? clampYear(yearFrom) : yearMin,
    Number.isFinite(yearTo) ? clampYear(yearTo) : yearMax,
  ]
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)
  playingRef.current = playing
  const [speed, setSpeed] = useState(1)

  // Local draft while dragging/playing so the brush follows the pointer at 60fps
  const [draft, setDraft] = useState<[number, number] | null>(null)
  const [from, to] = draft ?? committed
  const isAll = from <= yearMin && to >= yearMax

  const commitTimer = useRef<number | null>(null)
  const pending = useRef<[number, number] | null>(null)
  const commit = useCallback(
    (f: number, t: number, now = false) => {
      pending.current = [f, t]
      const flush = () => {
        commitTimer.current = null
        const p = pending.current
        if (!p) return
        pending.current = null
        onRange(p[0] <= yearMin ? -Infinity : p[0], p[1] >= yearMax ? Infinity : p[1])
      }
      if (now) {
        if (commitTimer.current != null) window.clearTimeout(commitTimer.current)
        flush()
      } else if (commitTimer.current == null) {
        commitTimer.current = window.setTimeout(flush, COMMIT_MS)
      }
    },
    [onRange, yearMin, yearMax],
  )
  useEffect(() => () => {
    if (commitTimer.current != null) window.clearTimeout(commitTimer.current)
  }, [])

  const setRange = useCallback(
    (f: number, t: number, now = false) => {
      let a = clampYear(f)
      let b = clampYear(t)
      if (a > b) [a, b] = [b, a]
      setDraft([a, b])
      commit(a, b, now)
    },
    [clampYear, commit],
  )

  // ——— canvas histogram ———
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !width) return
    const h = c.clientHeight
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(width * dpr)
    c.height = Math.round(h * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, h)
    const max = Math.max(1e-9, ...bins)
    const bw = width / BINS
    const x0 = scale.x(from) * width
    const x1 = scale.x(to) * width
    for (let i = 0; i < BINS; i++) {
      if (!bins[i]) continue
      const v = Math.max(1.5, Math.sqrt(bins[i]! / max) * (h - 2))
      const cx = i * bw + bw / 2
      g.fillStyle = cx >= x0 && cx <= x1 ? 'rgba(90, 209, 230, 0.9)' : 'rgba(148, 170, 200, 0.26)'
      g.fillRect(i * bw + 0.5, h - v, Math.max(1, bw - 1), v)
    }
  }, [bins, width, scale, from, to])

  // ——— pointer interaction ———
  const drag = useRef<Drag | null>(null)
  const yearAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return scale.year(Math.min(1, Math.max(0, (clientX - r.left) / r.width)))
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const y = yearAt(e.clientX)
    const kind = target.dataset.handle as 'from' | 'to' | undefined
    if (kind) {
      drag.current = { kind, grabYear: y, from0: from, to0: to }
    } else if (target.closest('.scrub-brush') && !isAll) {
      drag.current = { kind: 'move', grabYear: y, from0: from, to0: to }
    } else {
      // Click on the track: centre a window there (keep width; 50 years from "All")
      const span = isAll ? 50 : to - from
      const a = clampYear(y - span / 2)
      const b = Math.min(yearMax, a + span)
      setRange(b - span, b)
      drag.current = { kind: 'move', grabYear: y, from0: b - span, to0: b }
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setPlaying(false)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const y = yearAt(e.clientX)
    if (d.kind === 'from') setRange(Math.min(y, d.to0), d.to0)
    else if (d.kind === 'to') setRange(d.from0, Math.max(y, d.from0))
    else {
      // Move in warped space so the brush tracks the pointer, keep year span
      const span = d.to0 - d.from0
      let a = d.from0 + (y - d.grabYear)
      a = Math.min(Math.max(a, yearMin), yearMax - span)
      setRange(a, a + span)
    }
  }
  const endDrag = () => {
    if (!drag.current) return
    drag.current = null
    if (pending.current) commit(pending.current[0], pending.current[1], true)
  }
  // Drop the draft once the committed props catch up
  useEffect(() => {
    if (!drag.current && !playingRef.current) setDraft(null)
  }, [yearFrom, yearTo])

  const onHandleKey = (which: 'from' | 'to') => (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.shiftKey ? 10 : 1
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0
    if (!d) return
    e.preventDefault()
    if (which === 'from') setRange(Math.min(from + d, to), to, true)
    else setRange(from, Math.max(to + d, from), true)
  }

  // ——— playback ———
  const rangeRef = useRef<[number, number]>([from, to])
  rangeRef.current = [from, to]
  useEffect(() => {
    if (!playing) return
    let [a, b] = rangeRef.current
    if (a <= yearMin && b >= yearMax) {
      a = 1500
      b = 1525
    }
    if (b >= yearMax) {
      // restart from the beginning of the modern record with the same span
      const span = b - a
      a = 1500
      b = 1500 + span
    }
    let pos = a
    const span = b - a
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      pos += (SPEEDS[speed]!.yps * (now - last)) / 1000
      last = now
      const na = Math.round(pos)
      const nb = na + span
      if (nb >= yearMax) {
        setRange(yearMax - span, yearMax, true)
        setPlaying(false)
        return
      }
      setRange(na, nb, true)
    }, 200)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed])

  const count = countInRange(years, from, to)
  const xFrom = scale.x(from) * 100
  const xTo = scale.x(to) * 100
  const ticks = width ? scale.ticks(width, width < 420 ? 38 : 48) : []
  const eraActive = (e: (typeof ERAS)[number]) =>
    (Number.isFinite(e.from) ? e.from : yearMin) === from && (Number.isFinite(e.to) ? e.to : yearMax) === to

  return (
    <div className="scrub" role="group" aria-label="Time range">
      <button
        type="button"
        className={`scrub-play${playing ? ' on' : ''}`}
        onClick={() => setPlaying((p) => !p)}
        aria-label={playing ? 'Pause timeline' : 'Play timeline'}
        aria-pressed={playing}
        title={playing ? 'Pause' : 'Play through time'}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" aria-hidden>
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M4.5 2.5v11l9-5.5z" fill="currentColor" />
          </svg>
        )}
      </button>

      <div className="scrub-main">
        <div className="scrub-top">
          <span className="scrub-kicker">Time</span>
          {/* Announce range changes, but not every playback tick */}
          <span className="scrub-readout" aria-live={playing ? 'off' : 'polite'}>
            {isAll ? (
              'All years'
            ) : (
              <>
                {yearText(from)} <span className="scrub-arrow">→</span> {yearText(to)}
              </>
            )}
          </span>
          <span className="scrub-count">
            {battles ? `${count.toLocaleString()} mapped battle${count === 1 ? '' : 's'}` : 'Loading battles…'}
          </span>
          <span
            className="scrub-scale-note"
            title="Bar height = mapped battles per year (square-root scale). The time axis gives more width to recent centuries, which have far more records."
          >
            battles / year · uneven time axis
          </span>
          <div className="scrub-eras" role="group" aria-label="Era presets">
            {ERAS.map((e) => (
              <button
                key={e.label}
                type="button"
                className={eraActive(e) ? 'on' : ''}
                aria-pressed={eraActive(e)}
                onClick={() => {
                  setPlaying(false)
                  setRange(Number.isFinite(e.from) ? e.from : yearMin, Number.isFinite(e.to) ? e.to : yearMax, true)
                }}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>

        <div
          className="scrub-track"
          ref={trackRef}
          title="Bar height = mapped battles per year (square-root scale). Earlier centuries are compressed on this axis."

          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <canvas ref={canvasRef} className="scrub-hist" aria-hidden />
          {selectedSpan && (
            <span
              className="scrub-war"
              style={{ left: `${scale.x(selectedSpan[0]) * 100}%`, width: `${Math.max(0.4, (scale.x(selectedSpan[1]) - scale.x(selectedSpan[0])) * 100)}%` }}
              title="Selected war"
              aria-hidden
            />
          )}
          <div className={`scrub-brush${isAll ? ' all' : ''}`} style={{ left: `${xFrom}%`, width: `${Math.max(0, xTo - xFrom)}%` }}>
            <span
              className="scrub-handle from"
              data-handle="from"
              role="slider"
              tabIndex={0}
              aria-label="Start year"
              aria-valuemin={yearMin}
              aria-valuemax={to}
              aria-valuenow={from}
              aria-valuetext={yearText(from)}
              onKeyDown={onHandleKey('from')}
            />
            <span
              className="scrub-handle to"
              data-handle="to"
              role="slider"
              tabIndex={0}
              aria-label="End year"
              aria-valuemin={from}
              aria-valuemax={yearMax}
              aria-valuenow={to}
              aria-valuetext={yearText(to)}
              onKeyDown={onHandleKey('to')}
            />
          </div>
          <div className="scrub-axis" aria-hidden>
            {ticks.map((y) => (
              <span key={y} style={{ left: `${scale.x(y) * 100}%` }}>
                {y < 0 ? `${-y} BCE` : y}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="scrub-speed" role="group" aria-label="Playback speed">
        <span className="scrub-kicker">Speed</span>
        <div className="scrub-seg">
          {SPEEDS.map((s, i) => (
            <button key={s.label} type="button" className={speed === i ? 'on' : ''} aria-pressed={speed === i} onClick={() => setSpeed(i)} title={`${s.yps} years per second`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
