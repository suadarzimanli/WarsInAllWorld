import { useEffect, useId, useRef } from 'react'
import type { CatalogMeta, ProgressSnapshot } from '../types'
import type { CoverageStats } from '../lib/geoLabels'
import { tierCoverageLabel } from '../lib/geoLabels'
import { yearLabel as yearText } from '../lib/data'

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
                <span className="swatch battle" aria-hidden />
                <span>
                  <strong>Gold</strong> — one battle or combat event
                </span>
              </li>
              <li>
                <span className="swatch heat-inline" aria-hidden />
                <span>
                  <strong>Heat map</strong> — equal-area density of those mapped events (redder = denser). Hides all point layers.
                </span>
              </li>
              <li>
                <span className="swatch centroid" aria-hidden />
                <span>
                  <strong>Purple</strong> — one summary pin per war (average of battles, or a weaker proxy)
                </span>
              </li>
              <li>
                <span className="swatch midloc" aria-hidden />
                <span>
                  <strong>Blue</strong> — militarized dispute (MIDLOC), not a war
                </span>
              </li>
              <li>
                <span className="swatch theater" aria-hidden />
                <span>
                  <strong>Dashed outline</strong> — approximate theater for the <em>selected</em> war
                  only
                </span>
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
            <h3>What counts as a “war” here</h3>
            <p>
              Each source defines war differently, so <strong>totals under “All sources” mix
              different things</strong>. Use the definition filter to compare like with like.
            </p>
            <ul className="about-list plain">
              <li>
                <strong>COW</strong> — formal wars with ≥1,000 battle deaths (Correlates of War).
              </li>
              <li>
                <strong>UCDP warlike</strong> —{' '}
                {catalogMeta?.ucdp_war_rule ?? '≥1,000 battle-related deaths in at least one calendar year'}
                , state-based violence only.
                {catalogMeta?.ucdp_cumulative_only_excluded ? (
                  <>
                    {' '}
                    {catalogMeta.ucdp_cumulative_only_excluded} conflicts that only pass 1,000 deaths
                    when all years are added up are <em>not</em> counted as wars.
                  </>
                ) : null}
              </li>
              <li>
                <strong>HCED / Atlas</strong> — named wars from encyclopedia-style battle lists; no
                fixed death threshold.
              </li>
            </ul>
          </section>
          {catalogMeta?.source_coverage && catalogMeta.source_coverage.length > 0 && (
            <section>
              <h3>Time coverage by source</h3>
              <p>
                Sources stop at different years. Changes near those years partly reflect which
                datasets exist, not only real changes in warfare.
              </p>
              <ul className="about-list plain">
                {catalogMeta.source_coverage.map((row) => (
                  <li key={row.id}>
                    <strong>{row.label}</strong>: {row.from == null ? '?' : yearText(row.from)}–
                    {row.to == null ? '?' : yearText(row.to)}
                    {row.note ? ` — ${row.note}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3>Time bar and search</h3>
            <p>
              The bar along the bottom sets the years shown. Drag its edges or the window, pick an
              era, or press ▶ to play through time. Its histogram shows <strong>mapped battles per
              year</strong> on a square-root scale, and its time axis is <strong>uneven</strong>: recent
              centuries get more width because they have far more records. Compare heights, not
              widths.
            </p>
            <p>
              Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (or the search button) to find a war by name or jump
              to a year, e.g. “Korean”, “Punic”, “1944”, “480 BCE”.
            </p>
          </section>
          <section>
            <h3>Heat map</h3>
            <p>
              Heat shows <strong>density of mapped battle events</strong> (events per km²), not
              casualties or true intensity of war. Use Relative (within current filters) or Absolute
              (vs catalog peak at this zoom).
            </p>
            {catalogMeta?.ucdp_event_cap ? (
              <p>
                For modern conflicts the map carries at most{' '}
                <strong>{catalogMeta.ucdp_event_cap.toLocaleString()}</strong> UCDP events per
                conflict (deadliest first)
                {catalogMeta.ucdp_events_linked_total
                  ? ` — ${(catalogMeta.ucdp_events_shown ?? 0).toLocaleString()} of ${catalogMeta.ucdp_events_linked_total.toLocaleString()} linked events`
                  : ''}
                . Heat for large post-1989 wars is therefore a <em>sample</em>; death totals in each
                war’s detail panel use all events.
              </p>
            ) : null}
          </section>
          <section>
            <h3>Derived geometry</h3>
            <p>
              Purple pins and dashed theater outlines are computed by this atlas, not taken from a
              source: outlines are hulls or 75 km buffers around battle points, and some pins are
              the average of participant capitals. Pacific-spanning outlines are drawn as one
              continuous shape across the date line.
            </p>
          </section>
          {catalogMeta?.source_corrections_applied ? (
            <section>
              <h3>Source corrections</h3>
              <p>
                {catalogMeta.source_corrections_applied} individual source records with clear errors
                (wrong year, wrong war label, or a geocode on the wrong continent) are corrected at
                build time.
                {catalogMeta.spans_widened_from_battles
                  ? ` ${catalogMeta.spans_widened_from_battles} War Atlas wars whose source gives a one-year placeholder span (e.g. an ongoing war) have that span widened to cover their own battles, and are labelled so.`
                  : ''}{' '}
                Each fix and its reason is listed in{' '}
                <code>data/processed/review/source_corrections.json</code>; the raw files are not
                edited.
              </p>
            </section>
          ) : null}
          {catalogMeta?.build_provenance?.inputs?.length ? (
            <section>
              <h3>Build record</h3>
              <p>
                This catalog was built from exactly these files (SHA-256, first 12 characters). The
                full checksums and software versions are in <code>catalog_meta.json</code>; CI
                re-checks them on every deploy.
              </p>
              <ul className="about-list plain provenance-list">
                {catalogMeta.build_provenance.inputs.map((f) => (
                  <li key={f.path}>
                    <code>{f.sha256 ? f.sha256.slice(0, 12) : 'missing'}</code>{' '}
                    {f.path.split('/').slice(-1)[0]}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
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
