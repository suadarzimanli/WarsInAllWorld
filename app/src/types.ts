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
  battle_count: number
  event_deaths: number | null
  /** battles | ucdp_centroid | midloc_dyadic | participant_centroid */
  geo_source?: string | null
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
