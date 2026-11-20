import type { DisplayMode, HeatScaleMode } from '../types'
import { HudPortal } from './Hud'

type Props = {
  mode: DisplayMode
  onMode: (m: DisplayMode) => void
  heatScale: HeatScaleMode
  onHeatScale: (m: HeatScaleMode) => void
}

/** Centered Points | Heat map switch (sits on the map surface, under the topbar). */
export function DisplayModeSwitch({ mode, onMode, heatScale, onHeatScale }: Props) {
  return (
    <HudPortal slot="top-center">
    <div className="display-mode-wrap" role="group" aria-label="Display mode">
      <div className="display-mode-switch nav-switch">
        <button
          type="button"
          className={mode === 'points' ? 'active' : ''}
          aria-pressed={mode === 'points'}
          onClick={() => onMode('points')}
          title="Show individual battle points"
        >
          Points
        </button>
        <button
          type="button"
          className={mode === 'heatmap' ? 'active' : ''}
          aria-pressed={mode === 'heatmap'}
          onClick={() => onMode('heatmap')}
          title="Density of mapped battle events (not intensity of war)"
        >
          <span className="mode-label-full">Heat map</span>
          <span className="mode-label-short">Heat</span>
        </button>
      </div>
      {mode === 'heatmap' && (
        <div className="display-mode-switch nav-switch heat-scale-switch" role="group" aria-label="Heat scale">
          <button
            type="button"
            className={heatScale === 'relative' ? 'active' : ''}
            aria-pressed={heatScale === 'relative'}
            onClick={() => onHeatScale('relative')}
            title="Hottest cell in the current filter set is full red"
          >
            <span className="mode-label-full">Relative</span>
            <span className="mode-label-short">Rel</span>
          </button>
          <button
            type="button"
            className={heatScale === 'absolute' ? 'active' : ''}
            aria-pressed={heatScale === 'absolute'}
            onClick={() => onHeatScale('absolute')}
            title="Scaled against the catalog peak density at this zoom"
          >
            <span className="mode-label-full">Absolute</span>
            <span className="mode-label-short">Abs</span>
          </button>
        </div>
      )}
      <p className="display-mode-hint">
        {mode === 'points'
          ? 'Gold pins = individual battles & combat events.'
          : heatScale === 'absolute'
            ? 'Mapped battle density (events/km²) vs catalog peak at this zoom — not casualties or “intensity of war.” Point layers hidden.'
            : 'Mapped battle density under your filters (redder = denser in this view). Not intensity of war. Point layers hidden.'}
      </p>
    </div>
    </HudPortal>
  )
}
