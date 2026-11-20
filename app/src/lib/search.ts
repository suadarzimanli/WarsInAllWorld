import type { War } from '../types'

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** "1944", "480 bc", "-480", "480 bce" → year number */
export function parseYearQuery(q: string): number | null {
  const m = q.trim().toLowerCase().match(/^(-?\d{1,4})\s*(bc|bce)?$/)
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? -Math.abs(n) : n
}

/**
 * Words many catalogue titles omit (COW calls the Korean War just "Korean"),
 * so they are optional: they only improve the ranking.
 */
const GENERIC = new Set(['war', 'wars', 'the', 'of', 'and', 'battle', 'battles', 'conflict', 'campaign'])

/** Rank wars for a query: title prefix > word prefix > substring; ties by battle count. */
export function searchWars(wars: War[], q: string, limit = 8): War[] {
  const terms = fold(q).split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const specific = terms.filter((x) => !GENERIC.has(x))
  const must = specific.length ? specific : terms
  const optional = specific.length ? terms.filter((x) => GENERIC.has(x)) : []
  const first = must[0]!
  const firstWord = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  const scored: Array<[number, War]> = []
  for (const w of wars) {
    const t = fold(w.title)
    if (!must.every((x) => t.includes(x))) continue
    const score = (t.startsWith(first) ? 3 : firstWord.test(t) ? 2 : 1) * 10 + optional.filter((x) => t.includes(x)).length
    scored.push([score * 1e6 + (w.battle_count || 0), w])
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1])
}
