/// <reference types="node" />
/**
 * Checks the shipped catalog in public/data (what GitHub Pages serves).
 * Runs in CI, so a regenerated catalog with a regression fails the deploy.
 * The ETL's scripts/validate_exports.py does deeper checks at build time.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CatalogMeta, GeoJSONFeatureCollection, War } from '../types'

const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
const read = <T,>(name: string): T => JSON.parse(readFileSync(dataDir + name, 'utf-8')) as T

const wars = read<War[]>('wars.json')
const battles = read<GeoJSONFeatureCollection>('battles.geojson')
const meta = read<CatalogMeta>('catalog_meta.json')
const byId = new Map(wars.map((w) => [w.war_id, w]))

describe('shipped catalog', () => {
  it('has unique war ids and sane year spans', () => {
    expect(byId.size).toBe(wars.length)
    const bad = wars.filter((w) => w.start_year != null && w.end_year != null && w.end_year < w.start_year)
    expect(bad.map((w) => w.war_id)).toEqual([])
  })

  it('every event belongs to an existing war and battle_count matches', () => {
    const counts = new Map<string, number>()
    for (const f of battles.features) {
      const wid = String(f.properties.war_id)
      expect(byId.has(wid)).toBe(true)
      counts.set(wid, (counts.get(wid) ?? 0) + 1)
    }
    const mismatched = wars.filter((w) => (counts.get(w.war_id) ?? 0) !== w.battle_count)
    expect(mismatched.map((w) => w.war_id)).toEqual([])
  })

  it('keeps world-war battles on the world wars (cluster-routing regression)', () => {
    expect(byId.get('cow:139')?.title).toBe('World War II')
    expect(byId.get('cow:139')!.battle_count).toBeGreaterThan(400)
    expect(byId.get('cow:106')!.battle_count).toBeGreaterThan(300)
    // Fake one-battle "World War II (1835–1835)" style records must not exist
    expect(wars.some((w) => /^hced:world_war_i{1,2}:/.test(w.war_id))).toBe(false)
  })

  it('keeps nearly all events inside their war span', () => {
    let outside = 0
    for (const f of battles.features) {
      const w = byId.get(String(f.properties.war_id))!
      const y = f.properties.year as number | null
      if (y == null || w.start_year == null) continue
      const end = w.end_year ?? w.start_year
      if (y < w.start_year - 5 || y > end + 5) outside++
    }
    expect(outside / battles.features.length).toBeLessThan(0.003)
  })

  it('keeps COW "ongoing at source end" wars (code -7) inside real years', () => {
    const ongoing = wars.filter((w) => w.ongoing_at_source_end)
    expect(ongoing.length).toBeGreaterThanOrEqual(10)
    for (const w of ongoing) {
      expect(w.end_year).toBeGreaterThanOrEqual(2007)
      expect(w.end_year!).toBeGreaterThanOrEqual(w.start_year!)
    }
  })

  it('ongoing War Atlas wars are not stuck at a one-year placeholder', () => {
    const ru = byId.get('wa:russo_ukrainian_war')
    expect(ru?.span_from_battles).toBe(true)
    expect(ru!.end_year!).toBeGreaterThanOrEqual(2022)
  })

  it('uses the per-calendar-year UCDP war rule', () => {
    expect(meta.ucdp_war_rule).toMatch(/calendar year/)
    for (const w of wars.filter((x) => x.definition_tier === 'ucdp_warlike')) {
      expect(w.ucdp_peak_year_deaths ?? 0).toBeGreaterThanOrEqual(1000)
    }
  })
})
