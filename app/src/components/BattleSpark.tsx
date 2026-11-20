import type { YearBin } from '../lib/warStats'
import { yearText } from '../lib/timeScale'

/** Small bar chart of mapped battles per year (or per wider bin) for one war. */
export function BattleSpark({ bins }: { bins: YearBin[] }) {
  if (!bins.length) return null
  const max = Math.max(1, ...bins.map((b) => b.count))
  const W = 100
  const H = 40
  const bw = W / bins.length
  const label = (b: YearBin) => (b.from === b.to ? yearText(b.from) : `${yearText(b.from)}–${yearText(b.to)}`)
  const first = bins[0]!
  const last = bins[bins.length - 1]!
  const peak = bins.reduce((p, b) => (b.count > p.count ? b : p), first)
  return (
    <figure className="spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Mapped battles over time; peak ${peak.count} in ${label(peak)}`}>
        <line x1="0" x2={W} y1={H - 0.25} y2={H - 0.25} className="spark-base" />
        {bins.map((b, i) => {
          const h = b.count ? Math.max(1.2, (b.count / max) * (H - 2)) : 0
          return (
            <rect key={b.from} x={i * bw + bw * 0.12} width={bw * 0.76} y={H - h} height={h} className={b === peak ? 'spark-bar peak' : 'spark-bar'}>
              <title>
                {label(b)}: {b.count} mapped battle{b.count === 1 ? '' : 's'}
              </title>
            </rect>
          )
        })}
      </svg>
      <figcaption className="spark-axis">
        <span>{yearText(first.from)}</span>
        <span className="spark-peak">
          peak {peak.count} · {label(peak)}
        </span>
        <span>{yearText(last.to)}</span>
      </figcaption>
    </figure>
  )
}
