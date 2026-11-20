import { describe, expect, it } from 'vitest'
import type { GeoJSONFeatureCollection, War } from '../types'
import { parseYearQuery, searchWars } from './search'
import { indexWarBattles, yearBins } from './warStats'

const war = (war_id: string, title: string, battle_count = 0) => ({ war_id, title, battle_count }) as unknown as War

describe('search', () => {
  const wars = [war('a', 'Second Punic War', 20), war('b', 'First Punic War', 30), war('c', 'Napoléonic Wars', 200), war('d', 'Korean War', 50)]

  it('matches all terms, ignores accents and case', () => {
    expect(searchWars(wars, 'napoleonic').map((w) => w.war_id)).toEqual(['c'])
    expect(searchWars(wars, 'PUNIC second').map((w) => w.war_id)).toEqual(['a'])
  })

  it('ranks title-prefix matches first, then by battles', () => {
    expect(searchWars(wars, 'punic').map((w) => w.war_id)).toEqual(['b', 'a'])
    expect(searchWars(wars, 'kor').map((w) => w.war_id)).toEqual(['d'])
  })

  it('parses years including BCE', () => {
    expect(parseYearQuery('1944')).toBe(1944)
    expect(parseYearQuery('480 BCE')).toBe(-480)
    expect(parseYearQuery('480bc')).toBe(-480)
    expect(parseYearQuery('-216')).toBe(-216)
    expect(parseYearQuery('korea')).toBeNull()
  })
})

describe('war battle stats', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: null, properties: { war_id: 'w', year: 1940, source: 'hced' } },
      { type: 'Feature', geometry: null, properties: { war_id: 'w', year: 1940, source: 'war_atlas' } },
      { type: 'Feature', geometry: null, properties: { war_id: 'w', year: 1944, source: 'hced' } },
      { type: 'Feature', geometry: null, properties: { war_id: 'x', year: 1800, source: 'hced' } },
    ],
  } as unknown as GeoJSONFeatureCollection

  it('counts battles per year and per source', () => {
    const s = indexWarBattles(fc).get('w')!
    expect(s.total).toBe(3)
    expect(s.byYear.get(1940)).toBe(2)
    expect(s.bySource.get('hced')).toBe(2)
  })

  it('uses one bar per year for short wars', () => {
    const bins = yearBins(indexWarBattles(fc).get('w')!.byYear, 1939, 1945)
    expect(bins).toHaveLength(7)
    expect(bins.map((b) => b.count)).toEqual([0, 2, 0, 0, 0, 1, 0])
  })

  it('uses wider, round bins for long wars and keeps every battle', () => {
    const by = new Map([[1337, 3], [1400, 1], [1453, 2]])
    const bins = yearBins(by, 1337, 1453, 24)
    expect(bins.length).toBeLessThanOrEqual(24)
    expect(bins[0]!.from % 5).toBe(0)
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(6)
  })
})

describe('search with generic words', () => {
  const wars = [war('k', 'Korean', 50), war('s', 'Sino-Korean Wars (660–668)', 2), war('g', 'Gulf War', 30)]
  it('finds titles that omit "war"', () => {
    expect(searchWars(wars, 'korean war')[0]!.war_id).toBe('k')
    expect(searchWars(wars, 'the gulf war')[0]!.war_id).toBe('g')
  })
  it('still searches a query made only of generic words', () => {
    expect(searchWars(wars, 'war').length).toBeGreaterThan(0)
  })
})
