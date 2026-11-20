import { describe, expect, it } from 'vitest'
import { filterWars, formatYear } from './data'
import { deathEstimateLabel, ucdpSampleNote, warSpanLabel } from './geoLabels'
import { arcCenterLng, circularMeanLng, unwrapLngs, unwrapPointCollection } from './geoSafe'
import type { War } from '../types'

function war(partial: Partial<War>): War {
  return {
    war_id: 'x',
    title: 'X',
    start_year: 2000,
    end_year: 2000,
    era_bucket: '2000_present',
    definition_tier: 'cow_war',
    war_class: 'intrastate',
    sources: 'cow',
    cow_warnum: null,
    wa_slug: null,
    ucdp_conflict_id: null,
    wikidata_qid: null,
    participant_summary: null,
    death_estimate: null,
    battle_count: 0,
    event_deaths: null,
    ...partial,
  }
}

describe('unwrapLngs (matches ETL unwrap_lngs)', () => {
  it('leaves ordinary sets alone', () => {
    expect(unwrapLngs([10, 20])).toEqual([10, 20])
    expect(unwrapLngs([-120, -60, 30])).toEqual([-120, -60, 30])
  })

  it('makes a Pacific pair continuous', () => {
    expect(unwrapLngs([170, -170])).toEqual([170, 190])
  })

  it('recentres onto the main world copy (Spanish-American War)', () => {
    expect(unwrapLngs([-82, -65, 120, 145])).toEqual([-82, -65, -240, -215])
    expect(arcCenterLng([-82, -65, 120, 145])).toBeCloseTo(-152.5)
  })

  it('cuts at the largest gap', () => {
    const out = unwrapLngs([-10, 10, 175, -175])
    expect(Math.max(...out) - Math.min(...out)).toBeCloseTo(195)
  })
})

describe('unwrapPointCollection', () => {
  it('shifts points but keeps properties and non-point features', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature' as const, geometry: { type: 'Point', coordinates: [170, 10] }, properties: { a: 1 } },
        { type: 'Feature' as const, geometry: { type: 'Point', coordinates: [-170, 12] }, properties: { a: 2 } },
        { type: 'Feature' as const, geometry: null, properties: { a: 3 } },
      ],
    }
    const out = unwrapPointCollection(fc)
    expect(out.features[1]!.geometry!.coordinates).toEqual([190, 12])
    expect(out.features[1]!.properties).toEqual({ a: 2 })
    expect(out.features[2]!.geometry).toBeNull()
    // Input is not mutated
    expect(fc.features[1]!.geometry!.coordinates).toEqual([-170, 12])
  })

  it('returns the same object when nothing needs shifting', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [{ type: 'Feature' as const, geometry: { type: 'Point', coordinates: [5, 5] }, properties: {} }],
    }
    expect(unwrapPointCollection(fc)).toBe(fc)
  })
})

describe('COW ongoing wars (end code -7)', () => {
  it('a censored war shows up inside its real active years', () => {
    // Before the fix this war had end_year -7 and never matched any year filter.
    const w = war({ war_id: 'cow:481', title: 'Afghan Resistance', start_year: 2001, end_year: 2007, ongoing_at_source_end: true })
    const hits = filterWars([w], { yearFrom: 2004, yearTo: 2005, query: '', mode: 'all' })
    expect(hits.map((h) => h.war_id)).toEqual(['cow:481'])
  })

  it('labels the span as ongoing at the source end', () => {
    const w = war({ start_year: 2001, end_year: 2007, ongoing_at_source_end: true })
    expect(warSpanLabel(w, formatYear)).toBe('2001 – 2007 (ongoing when source ends)')
    expect(warSpanLabel({ ...w, ongoing_at_source_end: false }, formatYear)).toBe('2001 – 2007')
    expect(warSpanLabel({ ...w, ongoing_at_source_end: false, span_from_battles: true }, formatYear)).toMatch(/from its battles/)
  })
})

describe('death and sample labels', () => {
  it('names the measure behind each death figure', () => {
    expect(deathEstimateLabel('cow_battle_deaths')).toBe('Battle deaths (COW)')
    expect(deathEstimateLabel('ucdp_best_total')).toMatch(/UCDP/)
    expect(deathEstimateLabel(null)).toBe('Death estimate')
  })

  it('explains UCDP sampling only when the map shows a subset', () => {
    expect(ucdpSampleNote({ ucdp_events_total: 5000, ucdp_events_shown: 400 })).toMatch(/400 of 5,000/)
    expect(ucdpSampleNote({ ucdp_events_total: 120, ucdp_events_shown: 120 })).toBeNull()
    expect(ucdpSampleNote({ ucdp_events_total: null, ucdp_events_shown: null })).toBeNull()
  })
})

describe('circularMeanLng', () => {
  it('averages across the antimeridian correctly', () => {
    expect(Math.abs(circularMeanLng([179, -179])!)).toBeCloseTo(180)
    expect(circularMeanLng([10, 20])).toBeCloseTo(15)
    expect(circularMeanLng([])).toBeNull()
  })
})
