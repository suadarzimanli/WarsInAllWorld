import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { War } from '../types'
import { yearText } from '../lib/timeScale'
import { parseYearQuery, searchWars } from '../lib/search'

type Result =
  | { kind: 'war'; war: War }
  | { kind: 'year'; year: number }

type Props = {
  wars: War[]
  open: boolean
  onClose: () => void
  onPickWar: (war: War) => void
  onPickYear: (year: number) => void
}

/** Ctrl/⌘+K search across wars, plus "jump to year". */
export function SearchPalette({ wars, open, onClose, onPickWar, onPickYear }: Props) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const [minYear, maxYear] = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const w of wars) {
      if (w.start_year != null) lo = Math.min(lo, w.start_year)
      const e = w.end_year ?? w.start_year
      if (e != null) hi = Math.max(hi, e)
    }
    return [lo, hi]
  }, [wars])

  const results: Result[] = useMemo(() => {
    const out: Result[] = []
    const y = parseYearQuery(q)
    if (y != null && y >= minYear && y <= maxYear) out.push({ kind: 'year', year: y })
    for (const war of searchWars(wars, q)) out.push({ kind: 'war', war })
    return out
  }, [wars, q, minYear, maxYear])

  useEffect(() => {
    if (!open) return
    setQ('')
    setIdx(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])
  useEffect(() => setIdx(0), [q])

  if (!open) return null
  const pick = (r: Result | undefined) => {
    if (!r) return
    if (r.kind === 'war') onPickWar(r.war)
    else onPickYear(r.year)
    onClose()
  }
  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search wars and years">
        <div className="palette-input">
          <svg viewBox="0 0 16 16" aria-hidden>
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <input
            ref={inputRef}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- dialog input must take typing immediately
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a war, or type a year (1944, 480 BCE)…"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={results.length ? `${listId}-${idx}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault() // the input is the dialog's only control
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => Math.min(i + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(results[idx])
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id={listId} role="listbox">
          {results.map((r, i) => (
            <li
              key={r.kind === 'war' ? r.war.war_id : `y${r.year}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === idx}
              className={i === idx ? 'on' : ''}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(r)
              }}
            >
              {r.kind === 'year' ? (
                <>
                  <span className="palette-title">Show the year {yearText(r.year)}</span>
                  <span className="palette-meta">time range</span>
                </>
              ) : (
                <>
                  <span className="palette-title">{r.war.title}</span>
                  <span className="palette-meta">
                    {r.war.start_year != null ? yearText(r.war.start_year) : '?'}–
                    {r.war.end_year != null ? yearText(r.war.end_year) : '?'} ·{' '}
                    {r.war.battle_count ? `${r.war.battle_count.toLocaleString()} battle${r.war.battle_count === 1 ? '' : 's'}` : 'no battles'}
                  </span>
                </>
              )}
            </li>
          ))}
          {q.trim() && !results.length && (
            <li className="palette-empty">
              {parseYearQuery(q) != null
                ? `No records for that year — the catalogue covers ${minYear < 0 ? `${-minYear} BCE` : minYear}–${maxYear}.`
                : `No war matches “${q}”.`}
            </li>
          )}
          {!q.trim() && <li className="palette-empty">Try “Napoleonic”, “Korea”, “Punic”, or a year.</li>}
        </ul>
      </div>
    </div>
  )
}
