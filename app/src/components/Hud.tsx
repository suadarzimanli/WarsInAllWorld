import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Zoned layout for everything drawn over the map / globe.
 *
 * The map fills the stage; on top sits one grid ("HUD") with fixed zones:
 *
 *   ┌────────┬──────────────────────────────┬────────┐
 *   │        │ top-left   top-center  top-r │        │
 *   │  dock  │                              │  dock  │
 *   │  left  │        (free map area)       │ right  │
 *   │        │ bottom-left bottom-c bottom-r│        │
 *   ├────────┴──────────────────────────────┴────────┤
 *   │                 bar (time scrubber)              │
 *   └──────────────────────────────────────────────────┘
 *
 * On phones the docks become a bottom sheet row under the map area.
 * Every control lives in exactly one zone and zones are normal-flow flex/grid
 * boxes, so controls push each other aside (or wrap) instead of overlapping.
 * Components anywhere in the tree render into a zone with <HudPortal slot=…>.
 */
export type HudSlot =
  | 'dock-left'
  | 'dock-right'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'bar'

type Slots = Partial<Record<HudSlot, HTMLElement>>
const HudContext = createContext<Slots>({})

export function HudPortal({ slot, children }: { slot: HudSlot; children: ReactNode }) {
  const el = useContext(HudContext)[slot]
  return el ? createPortal(children, el) : null
}

/** Stage = map surface + HUD zones. `surface` is the map/globe; `children` may use HudPortal. */
export function HudStage({ surface, children }: { surface: ReactNode; children?: ReactNode }) {
  const [slots, setSlots] = useState<Slots>({})
  const reg = useCallback(
    (name: HudSlot) => (node: HTMLElement | null) => {
      setSlots((s) => {
        if (node ? s[name] === node : !s[name]) return s
        const next = { ...s }
        if (node) next[name] = node
        else delete next[name]
        return next
      })
    },
    [],
  )
  // Stable ref callbacks so React does not detach/reattach slots every render
  const refs = useMemo(
    () =>
      Object.fromEntries(
        (
          ['dock-left', 'dock-right', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'bar'] as HudSlot[]
        ).map((n) => [n, reg(n)]),
      ) as Record<HudSlot, (node: HTMLElement | null) => void>,
    [reg],
  )

  return (
    <HudContext.Provider value={slots}>
      <div className="stage-surface">{surface}</div>
      <div className="hud">
        <div className="hud-dock hud-dock-left" ref={refs['dock-left']} />
        <div className="hud-main">
          <div className="hud-row hud-top">
            <div className="hud-slot hud-tl" ref={refs['top-left']} />
            <div className="hud-slot hud-tc" ref={refs['top-center']} />
            <div className="hud-slot hud-tr" ref={refs['top-right']} />
          </div>
          <div className="hud-row hud-bottom">
            <div className="hud-slot hud-bl" ref={refs['bottom-left']} />
            <div className="hud-slot hud-bc" ref={refs['bottom-center']} />
            <div className="hud-slot hud-br" ref={refs['bottom-right']} />
          </div>
        </div>
        <div className="hud-dock hud-dock-right" ref={refs['dock-right']} />
        <div className="hud-bar" ref={refs['bar']} />
      </div>
      {children}
    </HudContext.Provider>
  )
}
