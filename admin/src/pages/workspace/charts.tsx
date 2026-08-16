/**
 * The workspace's charts.
 *
 * Each takes the numbers it draws and nothing else — no width, no scale, no
 * tick count, no formatter for the axis it owns. Everything about where a mark
 * lands is decided inside, by the same geometry the artifact documents use, so
 * a chart on this dashboard and the same chart in a document Divo wrote cannot
 * disagree about what the data looks like.
 *
 * Each returns `null` when it has nothing to draw, rather than an empty state.
 * A caller should be able to render one unconditionally and have the page
 * simply not contain it — an empty chart card is worse than no card, and
 * pushing that decision outward means every caller re-deciding it.
 *
 * `Heatmap`, `TrendChart` and `Spark` still live in `ui.tsx` for now. They
 * belong here — four chart exports in a 34-export grab-bag is the seam asking
 * to be moved — but that is churn across four screens and a file another
 * session is working in, so it is a follow-up rather than a detour.
 */
import { dotColumns, hexCells, niceScale, shareAssignment } from '@/lib/chart-geometry'

/**
 * Hues that classify rather than mean.
 *
 * The same nine the artifact documents use, and deliberately identical in light
 * and dark: a category that is violet on one theme and lavender on the other is
 * two different categories to anyone comparing two screenshots. They stay
 * legible in both because nothing here renders them larger than a tile or
 * smaller than a dot, and never as text.
 */
export const CHART_HUES = [
  '#f09a2f', '#16a6c7', '#25a878', '#92b72d', '#3f78ff',
  '#9a5cff', '#ee6572', '#c84f9d', '#7f858d',
] as const

/**
 * The box every chart draws into.
 *
 * Fixed here rather than left to each chart's own proportions, because two
 * charts sitting in one row are read as a pair: a cluster at 2:1 beside a field
 * at 3:1 looks like one of them went wrong, whatever either says on its own.
 * Each scales to fit inside this and centres, so they occupy the same rectangle
 * and their cards come out the same height.
 */
const CHART_BOX = { width: '100%', height: 176, display: 'block' } as const

/** The hue a category keeps everywhere it appears, by its rank in the list. */
export const hueAt = (index: number): string =>
  CHART_HUES[index % CHART_HUES.length] ?? '#7f858d'

export type Slice = { label: string; value: number; color?: string }

/**
 * Share of a whole, as a cluster of proportional tiles.
 *
 * Reads at a glance the way a pie is supposed to and does not, and it stays
 * legible past four categories where a pie's small wedges stop being
 * distinguishable from one another.
 */
export function HexShare({ slices, density = 0.58 }: {
  slices: Slice[]
  /** How much of the field the shares fill. Lower reads as sparser, not smaller. */
  density?: number
}) {
  const values = slices.map((slice) => Math.max(0, slice.value))
  if (values.reduce((sum, one) => sum + one, 0) <= 0) return null

  const COLS = 26
  const ROWS = 15
  const RADIUS = 10
  const cells = hexCells(COLS, ROWS, RADIUS)
  const owner = shareAssignment(values, cells.length, density)
  const box = cells[0]
  if (!box) return null

  const corners = (x: number, y: number) => Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 90)
    const r = RADIUS - 1.2
    return `${(x + r * Math.cos(angle)).toFixed(1)},${(y + r * Math.sin(angle)).toFixed(1)}`
  }).join(' ')

  return (
    <svg
      viewBox={`0 0 ${box.width.toFixed(0)} ${box.height.toFixed(0)}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={slices.map((s) => s.label).join(', ')}
      style={CHART_BOX}
    >
      {cells.map((cell, index) => (
        <polygon
          key={index}
          points={corners(cell.x, cell.y)}
          fill={owner[index]! >= 0
            ? slices[owner[index]!]?.color ?? hueAt(owner[index]!)
            : 'var(--cur-hairline)'}
        />
      ))}
    </svg>
  )
}

/**
 * One series over time, stippled onto a field of dots.
 *
 * The dots above the line are drawn rather than left out, so the empty space
 * still reads as part of the same measured field — which is what stops a quiet
 * fortnight from looking like missing data.
 */
export function DotField({ points, color = CHART_HUES[0], format = (n) => String(n) }: {
  points: { date: string; value: number }[]
  color?: string
  format?: (value: number) => string
}) {
  if (points.length === 0) return null
  const values = points.map((point) => point.value)
  if (Math.max(...values) <= 0) return null

  const W = 600
  const H = 200
  const padL = 46
  const padR = 6
  const padT = 8
  const padB = 22
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  // Zero is always in view: a field cropped to its own range turns a modest
  // week into a cliff.
  const bounds = niceScale(Math.min(...values, 0), Math.max(...values, 0), 5)
  const COLS = 56
  const ROWS = 20
  const lit = dotColumns(values, bounds.min, bounds.max, COLS, ROWS)
  const colW = plotW / COLS
  const rowH = plotH / ROWS
  const y = (value: number) =>
    padT + plotH - ((value - bounds.min) / (bounds.max - bounds.min || 1)) * plotH

  const ticks: number[] = []
  for (let t = bounds.min; t <= bounds.max + 1e-9; t += bounds.step) ticks.push(t)

  const edges = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${format(values[values.length - 1] ?? 0)} most recent`}
      style={CHART_BOX}
    >
      {ticks.map((tick) => (
        <text
          key={tick} x={padL - 8} y={y(tick) + 3.5} textAnchor="end"
          fill="var(--cur-muted)" fontSize={10}
        >
          {format(tick)}
        </text>
      ))}
      {Array.from({ length: COLS }, (_, col) =>
        Array.from({ length: ROWS }, (_, row) => (
          <circle
            key={`${col}-${row}`}
            cx={(padL + colW * (col + 0.5)).toFixed(1)}
            cy={(padT + plotH - rowH * (row + 0.5)).toFixed(1)}
            r={1.7}
            fill={row < (lit[col] ?? 0) ? color : 'var(--cur-hairline)'}
          />
        )))}
      {edges.map((point, index) => point ? (
        <text
          key={point.date}
          x={padL + (plotW / 2) * index}
          y={H - 6}
          textAnchor={index === 0 ? 'start' : index === 2 ? 'end' : 'middle'}
          fill="var(--cur-muted)"
          fontSize={10}
        >
          {new Date(`${point.date}T00:00:00`)
            .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
        </text>
      ) : null)}
    </svg>
  )
}
