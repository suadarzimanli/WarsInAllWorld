import { useEffect, useId, useRef } from 'react'
import type { CatalogMeta, ProgressSnapshot } from '../types'
import type { CoverageStats } from '../lib/geoLabels'
import { tierCoverageLabel } from '../lib/geoLabels'

type Props = {
  open: boolean
  onClose: () => void
  coverage: CoverageStats
  catalogMeta: CatalogMeta | null
  progressHistory: ProgressSnapshot[]
}

/**
 * First-run / on-demand “read this first” for what the atlas is and is not.
 */
export function AboutAtlas({ open, onClose, coverage, catalogMeta, progressHistory }: Props) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const t = window.setTimeout(() => closeRef.current?.focus(), 0)
    const main = document.querySelector('.app-main') as HTMLElement | null
    const topbar = document.querySelector('.topbar') as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (main) main.inert = true
    if (topbar) topbar.inert = true

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !closeRef.current) return
      // Minimal focus trap: keep Tab cycling on dialog actions
      const root = closeRef.current.closest('.about-card')
      if (!root) return
      const focusable = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (main) main.inert = false
      if (topbar) topbar.inert = false
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  if (!open) return null
  return (
    <div
      className="about-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="about-card">
        <div className="about-head">
          <h2 id={titleId}>Read this first</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn ghost"
            onClick={onClose}
            aria-label="Close about dialog"
          >
            Close
          </button>
        </div>
        <div className="about-body">
          <section>
            <h3>What this is</h3>
            <p>
              A research atlas of wars and <strong>mapped</strong> battle/combat events from public
              datasets (HCED, COW, War Atlas, UCDP, MIDLOC). Map and Globe share the same filters.
            </p>
          </section>
          <section>
            <h3>What this is not</h3>
            <p>
              Not a complete history of all fighting, not live conflict monitoring, and not proof
              that empty regions were peaceful. Empty map ≠ no war — often just no geocoded events.
            </p>
          </section>
          <section>
            <h3>Legend</h3>
            <ul className="about-list">
              <li>
                <span className="swatch battle" aria-hidden /> <strong>Gold</strong> — one battle or
                combat event
              </li>
              <li>
                <span className="swatch heat-inline" aria-hidden /> <strong>Heat map</strong> —
                equal-area density of those mapped events (redder = denser). Hides all point layers.
              </li>
              <li>
                <span className="swatch centroid" aria-hidden /> <strong>Purple</strong> — one summary
                pin per war (average of battles, or a weaker proxy)
              </li>
              <li>
                <span className="swatch midloc" aria-hidden /> <strong>Blue</strong> — militarized
                dispute (MIDLOC), not a war
              </li>
              <li>
                <span className="swatch theater" aria-hidden /> <strong>Dashed outline</strong> —
                approximate theater for the <em>selected</em> war only
              </li>
            </ul>
          </section>
          <section>
            <h3>Coverage (honest)</h3>
            <p>
              <strong>{coverage.withBattlePoints.toLocaleString()}</strong> of{' '}
              <strong>{coverage.total.toLocaleString()}</strong> wars have battle/combat points on
              the map.
              {coverage.proxyOnly > 0 && (
                <>
                  {' '}
                  Another <strong>{coverage.proxyOnly.toLocaleString()}</strong> have only a weak
                  location proxy (no battles).
                </>
              )}{' '}
              <strong>{coverage.noMapLocation.toLocaleString()}</strong> have no map location yet
              (many COW-only wars).
            </p>
            {catalogMeta?.tier_coverage && (
              <ul className="about-list plain">
                {Object.entries(catalogMeta.tier_coverage).map(([tier, row]) => (
                  <li key={tier}>
                    {tierCoverageLabel(tier)}: {row.battles}/{row.total} with battles
                    {row.unmapped ? `, ${row.unmapped} unmapped` : ''}
                    {row.proxy ? `, ${row.proxy} proxy` : ''}
                  </li>
                ))}
              </ul>
            )}
            {(catalogMeta?.crosswalk_ambiguous != null ||
              catalogMeta?.crosswalk_rejected != null ||
              catalogMeta?.crosswalk_accepted_decisions != null) && (
              <p>
                Crosswalk: {catalogMeta?.crosswalk_accepted_decisions ?? 0} accepted ·{' '}
                {catalogMeta?.crosswalk_ambiguous ?? 0} ambiguous · {catalogMeta?.crosswalk_rejected ?? 0}{' '}
                rejected.
              </p>
            )}
            {progressHistory.length > 0 && (
              <ul className="about-list plain">
                {progressHistory.slice(-5).map((snap) => (
                  <li key={snap.at}>
                    {new Date(snap.at).toLocaleString()}: COW{' '}
                    {snap.cow_with_battles ?? '?'}/{snap.cow_total ?? '?'} with battles
                    {snap.cow_pct_with_battles != null ? ` (${snap.cow_pct_with_battles}%)` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>Heat map</h3>
            <p>
              Heat shows <strong>density of mapped battle events</strong> (events per km²), not
              casualties or true intensity of war. Use Relative (within current filters) or Absolute
              (vs catalog peak at this zoom).
            </p>
          </section>
          <section>
            <h3>Still thin / later work</h3>
            <ul className="about-list plain">
              <li>COW wars without linked battles stay hard to place accurately</li>
              <li>Crosswalk merges between sources still need human review</li>
              <li>Participant-centroid pins are weak guesses — never used in heat</li>
              <li>No full narratives or outcomes beyond catalog fields</li>
            </ul>
          </section>
        </div>
        <div className="about-foot">
          <button type="button" className="btn primary" onClick={onClose}>
            Got it — explore
          </button>
        </div>
      </div>
    </div>
  )
}
