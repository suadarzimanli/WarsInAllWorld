import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { buildCatalogDigest, formatYearShort } from '../lib/digest'
import {
  buildInsightsSearch,
  eraExplorerSearch,
  eraYearBounds,
  mapWarPath,
  readInsightsUrl,
  type InsightsEra,
} from '../lib/insightsUrl'
import { tierCoverageLabel } from '../lib/geoLabels'
import type { CatalogMeta, CitationDataset, GeoJSONFeatureCollection, War } from '../types'

type Props = {
  wars: War[]
  battles: GeoJSONFeatureCollection | null
  catalogMeta: CatalogMeta | null
  citations: CitationDataset[]
}

function BarRow({
  label,
  value,
  max,
  note,
}: {
  label: string
  value: number
  max: number
  note?: string
}) {
  const pct = max > 0 ? Math.max(2, (100 * value) / max) : 0
  return (
    <div className="lens-bar-row">
      <div className="lens-bar-meta">
        <span className="lens-bar-label">{label}</span>
        <span className="lens-bar-value">
          {value.toLocaleString()}
          {note ? ` · ${note}` : ''}
        </span>
      </div>
      <div className="lens-bar-track" aria-hidden>
        <div className="lens-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const ERA_OPTIONS: { id: InsightsEra; label: string }[] = [
  { id: 'all', label: 'All years' },
  { id: 'pre1900', label: 'Before 1900' },
  { id: 'from1900', label: '1900 and after' },
]

export function InsightsPage({ wars, battles, catalogMeta, citations }: Props) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const era: InsightsEra =
    readInsightsUrl(searchParams.toString() ? `?${searchParams.toString()}` : '').era ?? 'all'

  const setEra = (next: InsightsEra) => {
    const q = buildInsightsSearch({ era: next })
    if (q === searchParams.toString()) return
    navigate({ pathname: '/insights', search: q ? `?${q}` : '' }, { replace: true })
  }

  const digest = useMemo(
    () => buildCatalogDigest(wars, battles, catalogMeta, eraYearBounds(era)),
    [wars, battles, catalogMeta, era],
  )

  const maxEra = Math.max(1, ...digest.eras.map((e) => e.wars))
  const maxTier = Math.max(1, ...digest.tiers.map((t) => t.total))
  const maxRegion = digest.regions[0]?.battlePoints ?? 1
  const maxTop = digest.topWars[0]?.battle_count ?? 1

  const mappedPct =
    digest.totalWars > 0 ? Math.round((100 * digest.withBattles) / digest.totalWars) : 0
  const battlesMissing = battles == null || battles.features.length === 0
  const eraSearch = eraExplorerSearch(era)
  const openExplorer = (pathname: '/map' | '/globe') =>
    eraSearch ? { pathname, search: `?${eraSearch}` } : { pathname }

  return (
    <div className="lens-page">
      <div className="lens-inner">
        <header className="lens-hero">
          <p className="lens-eyebrow">Numbers</p>
          <h1 className="lens-title">The map, counted</h1>
          <div className="lens-purpose">
            <p>
              Same data as Map and Globe — just totaled up so you can see the shape of the catalog
              without squinting at every point.
            </p>
          </div>

          <div className="lens-actions">
            <Link to={openExplorer('/map')} className="btn primary">
              Open map
            </Link>
            <Link to={openExplorer('/globe')} className="btn ghost">
              Open globe
            </Link>
          </div>

          <div className="lens-era" role="group" aria-label="Year filter">
            {ERA_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`lens-era-btn${era === opt.id ? ' is-active' : ''}`}
                aria-pressed={era === opt.id}
                onClick={() => setEra(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {era !== 'all' && (
            <p className="field-hint lens-era-hint">
              Only wars that touch this range, and battle points with a year in range.
            </p>
          )}
        </header>

        <section className="lens-stat-strip" aria-label="Catalog snapshot">
          <div className="lens-stat">
            <span className="lens-stat-n">{digest.totalWars.toLocaleString()}</span>
            <span className="lens-stat-l">wars</span>
          </div>
          <div className="lens-stat">
            <span className="lens-stat-n">{digest.withBattles.toLocaleString()}</span>
            <span className="lens-stat-l">have battle points ({mappedPct}%)</span>
          </div>
          <div className="lens-stat">
            <span className="lens-stat-n">{digest.battlePoints.toLocaleString()}</span>
            <span className="lens-stat-l">battle points plotted</span>
          </div>
          <div className="lens-stat">
            <span className="lens-stat-n">{digest.proxyOnly.toLocaleString()}</span>
            <span className="lens-stat-l">rough location only</span>
          </div>
          <div className="lens-stat">
            <span className="lens-stat-n">{digest.unmapped.toLocaleString()}</span>
            <span className="lens-stat-l">nowhere on the map</span>
          </div>
        </section>

        {battlesMissing && (
          <p className="field-hint" role="status">
            No battle points loaded (missing or empty battles.geojson). War totals still show; map
            dots will be empty until you run the ETL.
          </p>
        )}

        {digest.totalWars === 0 && (
          <p className="field-hint" role="status">
            No wars match this year filter.
          </p>
        )}

        {(digest.yearMin != null || digest.yearMax != null) && (
          <p className="lens-year-range">
            Years covered here: {formatYearShort(digest.yearMin)} –{' '}
            {formatYearShort(digest.yearMax)}
          </p>
        )}

        <section className="lens-compare">
          <h2 className="lens-section-title">Quick map legend</h2>
          <ul className="lens-foot-list">
            {digest.readTips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>

        <section className="lens-charts">
          <div className="lens-chart">
            <h2 className="lens-section-title">By period</h2>
            <p className="lens-section-sub">
              How many wars sit in each era. “With battles” = at least one mapped fight.
            </p>
            <div className="lens-bars">
              {digest.eras.map((e) => (
                <BarRow
                  key={e.id}
                  label={e.label}
                  value={e.wars}
                  max={maxEra}
                  note={`${e.withBattles.toLocaleString()} with battles`}
                />
              ))}
            </div>
          </div>

          <div className="lens-chart">
            <h2 className="lens-section-title">By source</h2>
            <p className="lens-section-sub">
              We stitch several lists together. COW is the big formal war list. HCED and the War
              Atlas are where a lot of the battle dots come from. UCDP is mostly recent fighting.
            </p>
            <div className="lens-bars">
              {digest.tiers.map((t) => (
                <BarRow
                  key={t.tier}
                  label={t.label}
                  value={t.total}
                  max={maxTier}
                  note={`${t.withBattles.toLocaleString()} with battles · ${t.unmapped.toLocaleString()} unmapped`}
                />
              ))}
            </div>
          </div>

          <div className="lens-chart">
            <h2 className="lens-section-title">Where the dots land</h2>
            <p className="lens-section-sub">
              Battle points grouped into rough world regions. This is “where we plotted fights,” not
              a scoreboard of who fought most. Switch to Before 1900 if the modern pile is too loud.
            </p>
            <div className="lens-bars">
              {digest.regions.map((r) => (
                <BarRow
                  key={r.region}
                  label={r.label}
                  value={r.battlePoints}
                  max={maxRegion}
                  note={`${(100 * r.share).toFixed(0)}%`}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="lens-table-wrap">
          <h2 className="lens-section-title">Most dots on one war</h2>
          <p className="lens-section-sub">
            Click Show on map to jump there. A huge count usually means lots of recorded points (or
            modern event data) — not that the war was “the biggest.”
          </p>
          {digest.topWars.length === 0 ? (
            <p className="field-hint">No wars with mapped battles in this filter.</p>
          ) : (
          <div className="lens-table-scroll">
            <table className="lens-table">
              <thead>
                <tr>
                  <th>War</th>
                  <th>Years</th>
                  <th>Battles</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {digest.topWars.map((w) => (
                  <tr key={w.war_id}>
                    <td>{w.title}</td>
                    <td>
                      {formatYearShort(w.start_year)}–{formatYearShort(w.end_year)}
                    </td>
                    <td>{w.battle_count.toLocaleString()}</td>
                    <td>{tierCoverageLabel(w.definition_tier)}</td>
                    <td>
                      <Link className="lens-hot-link" to={mapWarPath(w)}>
                        Show on map
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          {digest.topWars.length > 0 && (
            <div className="lens-bars" style={{ marginTop: '1rem' }}>
              {digest.topWars.slice(0, 8).map((w) => (
                <BarRow key={w.war_id} label={w.title} value={w.battle_count} max={maxTop} />
              ))}
            </div>
          )}
        </section>

        <section className="lens-method">
          <h2 className="lens-section-title">Sources</h2>
          <p className="lens-section-sub">Same ones the map uses:</p>
          {citations.length > 0 ? (
            <ul className="lens-cite-list">
              {citations.map((c) => (
                <li key={c.id}>
                  <span className="lens-cite-id">{c.id}</span> — {c.citation}
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">No citation file loaded yet — run the ETL.</p>
          )}
        </section>
      </div>
    </div>
  )
}
