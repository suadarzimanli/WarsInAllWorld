type Props = {
  displayMode: 'points' | 'heatmap'
  layers: { battles: boolean; theaters: boolean; midloc: boolean; centroids: boolean }
  selectedId?: string | null
}

/** Compact always-on legend so gold / purple / blue / heat stay unambiguous. */
import { HudPortal } from './Hud'

export function AtlasLegend({ displayMode, layers, selectedId = null }: Props) {
  const heat = displayMode === 'heatmap'
  const showBattles = !heat && layers.battles
  const showCentroids = !heat && layers.centroids
  const showMidloc = !heat && layers.midloc
  const showTheater = layers.theaters && Boolean(selectedId)
  const hasVisibleRow = heat || showBattles || showCentroids || showMidloc || showTheater
  const theatersWaiting = layers.theaters && !selectedId && !heat

  return (
    <HudPortal slot="bottom-left">
    <aside className="atlas-legend" aria-label="Map legend">
      <strong className="atlas-legend-title">Legend</strong>
      {heat ? (
        <div className="atlas-legend-row">
          <span className="atlas-legend-swatch heat" aria-hidden />
          <span>
            Heat = density of <em>mapped battles</em> (events/km²), not all wars
          </span>
        </div>
      ) : (
        <>
          {showBattles && (
            <div className="atlas-legend-row">
              <span className="atlas-legend-swatch battle" aria-hidden />
              <span>Gold = one battle / combat event</span>
            </div>
          )}
          {showCentroids && (
            <div className="atlas-legend-row">
              <span className="atlas-legend-swatch centroid" aria-hidden />
              <span>Purple = one summary pin per war</span>
            </div>
          )}
          {showMidloc && (
            <div className="atlas-legend-row">
              <span className="atlas-legend-swatch midloc" aria-hidden />
              <span>Blue = militarized dispute (not a war)</span>
            </div>
          )}
        </>
      )}
      {showTheater && (
        <div className="atlas-legend-row">
          <span className="atlas-legend-swatch theater" aria-hidden />
          <span>Dashed = approximate theater (selected war)</span>
        </div>
      )}
      {!hasVisibleRow && theatersWaiting && (
        <div className="atlas-legend-row muted">Select a war for theater outline</div>
      )}
      {!hasVisibleRow && !theatersWaiting && (
        <div className="atlas-legend-row muted">No layers on — open Layers to enable.</div>
      )}
    </aside>
    </HudPortal>
  )
}
