import { describe, expect, it, beforeEach } from 'vitest'
import { filterWars, isAllYearsRange, parseYearInput } from './data'
import { buildCatalogDigest } from './digest'
import { escapeHtml, pointLngLat } from './geoSafe'
import { buildHeatCells } from './heatmap'
import {
  clearMapFocusConsumed,
  eraExplorerSearch,
  mapWarPath,
  markMapFocusConsumed,
  mergeExplorerSearchWithFocus,
  parseMapFocusSearch,
  focusKey,
} from './insightsUrl'
import { filterPointFeatures } from './perf'
import { buildExplorerSearch, fullExplorerStateFromSearch, readExplorerUrl } from './urlState'
import type { AppLayers, GeoJSONFeatureCollection, War } from '../types'

const layers: AppLayers = {
  battles: true,
  theaters: true,
  midloc: false,
  centroids: false,
}

describe('parseYearInput', () => {
  it('keeps ±Infinity when the field shows ellipsis', () => {
    expect(parseYearInput('…', Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY)
    expect(parseYearInput('...', Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(parseYearInput('', Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('does not treat stripped non-digits as year 0', () => {
    expect(parseYearInput('…', 1800)).toBe(1800)
    expect(parseYearInput('abc', 1900)).toBe(1900)
  })

  it('parses CE and BCE years', () => {
    expect(parseYearInput('1945', 0)).toBe(1945)
    expect(parseYearInput('44 BCE', 0)).toBe(-44)
    expect(parseYearInput('44 BC', 0)).toBe(-44)
  })

  it('does not treat strings ending in BC letters as BCE', () => {
    expect(parseYearInput('1945CBC', 0)).toBe(1945)
    expect(parseYearInput('12ABC', 0)).toBe(12)
  })
})

describe('isAllYearsRange', () => {
  it('requires both ends open, not one-sided', () => {
    expect(isAllYearsRange(Number.NEGATIVE_INFINITY, 1499, -1500, 2025)).toBe(false)
    expect(isAllYearsRange(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, -1500, 2025)).toBe(
      true,
    )
    expect(isAllYearsRange(-1500, 2025, -1500, 2025)).toBe(true)
  })
})

describe('parseMapFocusSearch', () => {
  it('does not invent 0,0 from missing params', () => {
    expect(parseMapFocusSearch('')).toBeNull()
    expect(parseMapFocusSearch('?war=cow:1')).toBeNull()
    expect(parseMapFocusSearch('?lat=&lng=')).toBeNull()
  })

  it('rejects exact 0,0 and out-of-range coords', () => {
    expect(parseMapFocusSearch('?lat=0&lng=0')).toBeNull()
    expect(parseMapFocusSearch('?lat=0.000&lng=0.000')).toBeNull()
    expect(parseMapFocusSearch('?lat=99&lng=10')).toBeNull()
  })

  it('accepts valid focus', () => {
    expect(parseMapFocusSearch('?lat=48.856&lng=2.352')).toEqual({
      lat: 48.856,
      lng: 2.352,
    })
  })
})

describe('mergeExplorerSearchWithFocus', () => {
  beforeEach(() => clearMapFocusConsumed())

  it('preserves live lat/lng onto explorer query', () => {
    const merged = mergeExplorerSearchWithFocus('war=cow%3A1&from=1800', '?lat=48.856&lng=2.352')
    const p = new URLSearchParams(merged)
    expect(p.get('war')).toBe('cow:1')
    expect(p.get('lat')).toBe('48.856')
    expect(p.get('lng')).toBe('2.352')
  })

  it('skips consumed focus keys', () => {
    markMapFocusConsumed(focusKey(48.856, 2.352))
    const merged = mergeExplorerSearchWithFocus('war=x', '?lat=48.856&lng=2.352')
    expect(merged).toBe('war=x')
  })

  it('preserves focus on globe pathname', () => {
    const merged = mergeExplorerSearchWithFocus('war=x', '?lat=48.856&lng=2.352', {
      pathname: '/globe',
    })
    const p = new URLSearchParams(merged)
    expect(p.get('war')).toBe('x')
    expect(p.get('lat')).toBe('48.856')
    expect(p.get('lng')).toBe('2.352')
  })

  it('leaves explorer query alone when no focus', () => {
    expect(mergeExplorerSearchWithFocus('war=x', '?war=x')).toBe('war=x')
  })
})

describe('eraExplorerSearch', () => {
  it('maps era chips to explorer from/to params', () => {
    expect(eraExplorerSearch('all')).toBe('years=all')
    expect(eraExplorerSearch('pre1900')).toBe('to=1899')
    expect(eraExplorerSearch('from1900')).toBe('from=1900')
  })
})

describe('mapWarPath / explorer URL', () => {
  it('includes war years so selection survives session filters', () => {
    const path = mapWarPath({
      war_id: 'cow:572',
      start_year: 1861,
      end_year: 1865,
    })
    expect(path).toBe('/map?war=cow%3A572&from=1861&to=1865')
    const state = readExplorerUrl(path.slice(path.indexOf('?')))
    expect(state?.selectedId).toBe('cow:572')
    expect(state?.yearFrom).toBe(1861)
    expect(state?.yearTo).toBe(1865)
  })

  it('years=all opens the full year span', () => {
    const state = readExplorerUrl('?years=all')
    expect(state?.yearsAll).toBe(true)
    expect(state?.yearFromOpen).toBe(true)
    expect(state?.yearToOpen).toBe(true)
    expect(state?.yearFrom).toBeUndefined()
    expect(state?.yearTo).toBeUndefined()
    const snap = fullExplorerStateFromSearch('?years=all')
    expect(snap.yearFrom).toBe(Number.NEGATIVE_INFINITY)
    expect(snap.yearTo).toBe(Number.POSITIVE_INFINITY)
  })

  it('years=all ignores conflicting from/to params', () => {
    const state = readExplorerUrl('?years=all&from=1900&to=2000')
    expect(state?.yearsAll).toBe(true)
    expect(state?.yearFrom).toBeUndefined()
    expect(state?.yearTo).toBeUndefined()
  })

  it('round-trips one-sided open years', () => {
    const q = buildExplorerSearch({
      yearFrom: Number.NEGATIVE_INFINITY,
      yearTo: 1499,
      yearMin: -1500,
      yearMax: 2025,
      query: '',
      mode: 'all',
      coverage: 'all',
      displayMode: 'points',
      heatScale: 'relative',
      selectedId: null,
      layers,
    })
    expect(q).toBe('to=1499')
    const state = readExplorerUrl(`?${q}`)
    expect(state?.yearTo).toBe(1499)
    expect(state?.yearFromOpen).toBe(true)
    expect(state?.yearFrom).toBeUndefined()
  })

  it('emits years=all when both year ends are open', () => {
    const q = buildExplorerSearch({
      yearFrom: Number.NEGATIVE_INFINITY,
      yearTo: Number.POSITIVE_INFINITY,
      yearMin: -1500,
      yearMax: 2025,
      query: '',
      mode: 'all',
      coverage: 'all',
      displayMode: 'points',
      heatScale: 'relative',
      selectedId: null,
      layers,
    })
    expect(q).toBe('years=all')
  })

  it('treats invalid/empty from= as open when to= is valid', () => {
    expect(readExplorerUrl('?from=&to=2000')?.yearFromOpen).toBe(true)
    expect(readExplorerUrl('?from=abc&to=2000')?.yearFromOpen).toBe(true)
    expect(readExplorerUrl('?from=abc&to=2000')?.yearTo).toBe(2000)
  })

  it('fullExplorerStateFromSearch resets empty search to defaults', () => {
    const snap = fullExplorerStateFromSearch('')
    expect(snap.mode).toBe('all')
    expect(snap.query).toBe('')
    expect(snap.selectedId).toBeNull()
    expect(snap.yearFrom).toBe(Number.NEGATIVE_INFINITY)
    expect(snap.yearTo).toBe(Number.POSITIVE_INFINITY)
  })

  it('fullExplorerStateFromSearch applies sparse URL with defaults for missing keys', () => {
    const snap = fullExplorerStateFromSearch('?q=foo')
    expect(snap.query).toBe('foo')
    expect(snap.mode).toBe('all')
    expect(snap.selectedId).toBeNull()
  })
})

describe('heatmap / geoSafe', () => {
  it('buildHeatCells skips null coordinates without throwing', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { event_id: 'bad' },
          geometry: { type: 'Point', coordinates: null as unknown as number[] },
        },
        {
          type: 'Feature',
          properties: { event_id: 'ok' },
          geometry: { type: 'Point', coordinates: [2.35, 48.85] },
        },
      ],
    }
    expect(() => buildHeatCells(fc, { cellKm: 100 })).not.toThrow()
    const cells = buildHeatCells(fc, { cellKm: 100 })
    expect(cells.length).toBe(1)
  })

  it('pointLngLat rejects non-array coordinates', () => {
    expect(pointLngLat({ type: 'Point', coordinates: null })).toBeNull()
    expect(pointLngLat({ type: 'Point', coordinates: [1, 2] })).toEqual([1, 2])
  })

  it('pointLngLat rejects null/undefined numeric slots (Null Island)', () => {
    expect(pointLngLat({ type: 'Point', coordinates: [null, null] as unknown as number[] })).toBeNull()
    expect(pointLngLat({ type: 'Point', coordinates: [undefined, 1] as unknown as number[] })).toBeNull()
    expect(pointLngLat({ type: 'Point', coordinates: ['1', '2'] as unknown as number[] })).toBeNull()
  })

  it('buildCatalogDigest skips null coordinates without throwing', () => {
    const wars: War[] = [
      {
        war_id: 'w1',
        title: 'W',
        start_year: 1900,
        end_year: 1901,
        era_bucket: '1900_1999',
        definition_tier: 'cow_war',
        war_class: 'inter-state',
        sources: 'cow',
        cow_warnum: null,
        wa_slug: null,
        ucdp_conflict_id: null,
        wikidata_qid: null,
        participant_summary: null,
        death_estimate: null,
        battle_count: 1,
        event_deaths: null,
        geo_source: 'battles',
      },
    ]
    const battles: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { event_id: 'bad', war_id: 'w1', year: 1900 },
          geometry: { type: 'Point', coordinates: null as unknown as number[] },
        },
        {
          type: 'Feature',
          properties: { event_id: 'ok', war_id: 'w1', year: 1900 },
          geometry: { type: 'Point', coordinates: [10, 50] },
        },
      ],
    }
    expect(() => buildCatalogDigest(wars, battles, null)).not.toThrow()
    expect(buildCatalogDigest(wars, battles, null).battlePoints).toBe(1)
  })
})

describe('buildCatalogDigest era-scoped battles', () => {
  const wars: War[] = [
    {
      war_id: 'old',
      title: 'Old War',
      start_year: 1800,
      end_year: 1805,
      era_bucket: '1800_1899',
      definition_tier: 'cow_war',
      war_class: 'inter-state',
      sources: 'hced',
      cow_warnum: null,
      wa_slug: null,
      ucdp_conflict_id: null,
      wikidata_qid: null,
      participant_summary: null,
      death_estimate: null,
      battle_count: 2,
      event_deaths: null,
      geo_source: 'battles',
    },
    {
      war_id: 'span',
      title: 'Long War',
      start_year: 1850,
      end_year: 1950,
      era_bucket: '1800_1899',
      definition_tier: 'ucdp_warlike',
      war_class: 'intra-state',
      sources: 'ucdp',
      cow_warnum: null,
      wa_slug: null,
      ucdp_conflict_id: null,
      wikidata_qid: null,
      participant_summary: null,
      death_estimate: null,
      battle_count: 100,
      event_deaths: null,
      geo_source: 'ucdp',
    },
    {
      war_id: 'proxy',
      title: 'Proxy Only',
      start_year: 1800,
      end_year: 1801,
      era_bucket: '1800_1899',
      definition_tier: 'cow_war',
      war_class: 'inter-state',
      sources: 'cow',
      cow_warnum: null,
      wa_slug: null,
      ucdp_conflict_id: null,
      wikidata_qid: null,
      participant_summary: null,
      death_estimate: null,
      battle_count: 0,
      event_deaths: null,
      geo_source: 'midloc_dyadic',
    },
    {
      war_id: 'modern_only',
      title: 'Modern Points Only',
      start_year: 1800,
      end_year: 1950,
      era_bucket: '1800_1899',
      definition_tier: 'ucdp_warlike',
      war_class: 'intra-state',
      sources: 'ucdp',
      cow_warnum: null,
      wa_slug: null,
      ucdp_conflict_id: null,
      wikidata_qid: null,
      participant_summary: null,
      death_estimate: null,
      battle_count: 5,
      event_deaths: null,
      geo_source: 'battles',
    },
  ]

  const battles: GeoJSONFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { event_id: 'a', war_id: 'old', year: 1801 },
        geometry: { type: 'Point', coordinates: [10, 50] },
      },
      {
        type: 'Feature',
        properties: { event_id: 'b', war_id: 'old', year: 1802 },
        geometry: { type: 'Point', coordinates: [11, 50] },
      },
      {
        type: 'Feature',
        properties: { event_id: 'c', war_id: 'span', year: 1855 },
        geometry: { type: 'Point', coordinates: [12, 50] },
      },
      {
        type: 'Feature',
        properties: { event_id: 'd', war_id: 'span', year: 1940 },
        geometry: { type: 'Point', coordinates: [13, 50] },
      },
      {
        type: 'Feature',
        properties: { event_id: 'e', war_id: 'modern_only', year: 1945 },
        geometry: { type: 'Point', coordinates: [14, 50] },
      },
    ],
  }

  it('ranks by era-window points, not full-catalog battle_count', () => {
    const digest = buildCatalogDigest(wars, battles, null, { yearTo: 1899 })
    expect(digest.topWars[0]?.war_id).toBe('old')
    expect(digest.topWars[0]?.battle_count).toBe(2)
    const span = digest.topWars.find((w) => w.war_id === 'span')
    expect(span?.battle_count).toBe(1)
    expect(digest.battlePoints).toBe(3)
  })

  it('keeps withBattles + proxyOnly + unmapped === totalWars when era-scoped', () => {
    const digest = buildCatalogDigest(wars, battles, null, { yearTo: 1899 })
    expect(digest.withBattles + digest.proxyOnly + digest.unmapped).toBe(digest.totalWars)
    expect(digest.withBattles).toBe(2)
    expect(digest.proxyOnly).toBe(1)
  })

  it('does not count out-of-window battle wars as proxy', () => {
    const digest = buildCatalogDigest(wars, battles, null, { yearTo: 1899 })
    // modern_only has catalog battles but only 1945 points → unmapped in pre-1900, not proxy
    expect(digest.unmapped).toBeGreaterThanOrEqual(1)
    expect(digest.proxyOnly).toBe(1)
  })
})

describe('escapeHtml', () => {
  it('escapes markup characters for popups', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    )
    expect(escapeHtml(`a & b`)).toBe('a &amp; b')
  })
})

describe('filterWars', () => {
  const wars: War[] = [
    {
      war_id: 'a',
      title: 'Alpha War',
      start_year: 1800,
      end_year: 1805,
      era_bucket: 'modern',
      definition_tier: 'cow_war',
      war_class: 'inter-state',
      sources: 'cow',
      cow_warnum: 1,
      wa_slug: null,
      ucdp_conflict_id: null,
      wikidata_qid: null,
      participant_summary: null,
      death_estimate: null,
      battle_count: 2,
      event_deaths: null,
    },
    {
      war_id: 'b',
      title: 'Beta Conflict',
      start_year: 1950,
      end_year: 1952,
      era_bucket: 'modern',
      definition_tier: 'ucdp_warlike',
      war_class: 'intra-state',
      sources: 'ucdp',
      cow_warnum: null,
      wa_slug: null,
      ucdp_conflict_id: '1',
      wikidata_qid: null,
      participant_summary: null,
      death_estimate: null,
      battle_count: 0,
      event_deaths: null,
    },
  ]

  it('filters by query and year overlap', () => {
    const hit = filterWars(wars, {
      yearFrom: 1790,
      yearTo: 1810,
      query: 'alpha',
      mode: 'all',
    })
    expect(hit.map((w) => w.war_id)).toEqual(['a'])
    const miss = filterWars(wars, {
      yearFrom: 1900,
      yearTo: 2000,
      query: 'alpha',
      mode: 'all',
    })
    expect(miss).toEqual([])
  })
})

describe('filterPointFeatures', () => {
  const fc: GeoJSONFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { war_id: 'w1', year: 1800 },
        geometry: { type: 'Point', coordinates: [2, 48] },
      },
      {
        type: 'Feature',
        properties: { war_id: 'w2', year: 1950 },
        geometry: { type: 'Point', coordinates: [10, 50] },
      },
    ],
  }

  it('keeps all years when both ends are open Infinity', () => {
    const out = filterPointFeatures(fc, {
      yearFrom: Number.NEGATIVE_INFINITY,
      yearTo: Number.POSITIVE_INFINITY,
    })
    expect(out?.features).toHaveLength(2)
  })

  it('requireWarMatch keeps only the selected war', () => {
    const out = filterPointFeatures(fc, {
      yearFrom: Number.NEGATIVE_INFINITY,
      yearTo: Number.POSITIVE_INFINITY,
      selectedId: 'w1',
      requireWarMatch: true,
    })
    expect(out?.features).toHaveLength(1)
    expect(out?.features[0]?.properties?.war_id).toBe('w1')
  })
})
