export type DefinitionTier =
  | 'cow_war'
  | 'atlas_curated'
  | 'hced_war_string'
  | 'ucdp_warlike'
  | 'ucdp_conflict'
  | 'named_encyclopedia'
  | string

export type War = {
  war_id: string
  title: string
  start_year: number | null
  end_year: number | null
  era_bucket: string
  definition_tier: DefinitionTier
  war_class: string
  sources: string
  cow_warnum: number | null
  wa_slug: string | null
  ucdp_conflict_id: string | null
  wikidata_qid: string | null
  participant_summary: string | null
  death_estimate: number | null
  /** cow_battle_deaths | ucdp_best_total — different measures, never compare directly */
  death_source?: string | null
  battle_count: number
  /** UCDP battle-related deaths summed over ALL linked events (not the map sample) */
  event_deaths: number | null
  /** All UCDP events linked to this war */
  ucdp_events_total?: number | null
  /** UCDP events actually shipped to the map (capped per conflict) */
  ucdp_events_shown?: number | null
  /** Highest single-calendar-year UCDP death total */
  ucdp_peak_year_deaths?: number | null
  /** Calendar years with ≥1,000 UCDP battle-related deaths */
  ucdp_war_years?: number | null
  /** COW code -7: war still ongoing when the source dataset ends (end year censored) */
  ongoing_at_source_end?: boolean
  /** War Atlas gave a one-year placeholder span; widened to cover its own battles */
  span_from_battles?: boolean
  /** battles | ucdp_centroid | midloc_dyadic | participant_centroid */
  geo_source?: string | null
}

export type SourceCoverageRow = {
  id: string
  label: string
  from: number | null
  to: number | null
  note: string
}

export type GeoJSONFeatureCollection = {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    geometry: { type: string; coordinates: unknown } | null
    properties: Record<string, unknown>
  }>
}

export type AppLayers = {
  battles: boolean
  theaters: boolean
  midloc: boolean
  centroids: boolean
}

export type DefinitionMode = 'all' | 'cow_strict' | 'named' | 'warlike_ucdp'

/** Spatial coverage filter for the war list / map filters */
export type CoverageMode = 'all' | 'has_battles' | 'proxy_only' | 'unmapped'

/** How the map/globe draws battle activity */
export type DisplayMode = 'points' | 'heatmap'

/** Heat color scaling */
export type HeatScaleMode = 'relative' | 'absolute'

export type CitationDataset = {
  id: string
  citation: string
}

export type CatalogMeta = {
  wars_total: number
  wars_with_battles?: number
  wars_proxy_only?: number
  wars_unmapped?: number
  crosswalk_ambiguous?: number
  crosswalk_rejected?: number
  crosswalk_accepted_decisions?: number
  tier_coverage?: Record<string, { total: number; battles: number; proxy: number; unmapped: number }>
  geo_source_counts?: Record<string, number>
  ucdp_war_rule?: string
  ucdp_event_cap?: number | null
  ucdp_events_shown?: number
  ucdp_events_linked_total?: number
  ucdp_cumulative_only_excluded?: number | null
  source_corrections_applied?: number
  spans_widened_from_battles?: number
  theaters_antimeridian?: number
  source_coverage?: SourceCoverageRow[]
  build_provenance?: {
    inputs: Array<{ path: string; bytes?: number; sha256?: string; missing?: boolean }>
    software: Record<string, string | null>
  }
}

export type ProgressSnapshot = {
  at: string
  wars_total?: number
  wars_with_battles?: number
  wars_unmapped?: number
  cow_total?: number
  cow_with_battles?: number
  cow_proxy?: number
  cow_unmapped?: number
  cow_pct_with_battles?: number | null
  crosswalk_accepted_decisions?: number
  crosswalk_ambiguous?: number
}
