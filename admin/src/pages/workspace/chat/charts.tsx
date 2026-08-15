/**
 * The three chart shapes a run can return.
 *
 * Drawn by hand in SVG rather than pulled from a charting library. Three
 * reasons, in order of how much they mattered: the palette has to come from
 * the same tokens as everything else so a chart reads as part of the answer
 * and not as an embed; a chart inside a chat message is 170px tall and needs
 * no axes machinery; and the one library these components were written against
 * is a pre-1.0 package that has no business in the admin bundle.
 *
 * All three animate in once, on the beat that delivers them, and then hold
 * still. A chart that keeps moving after it has arrived is decoration.
 */
import { useMemo, useState } from 'react'
import type { ChartBlock } from './beats'

/* Indian grouping, because every figure in these runs is INR. */
const money = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`
const count = (v: number) => Math.round(v).toLocaleString('en-IN')

function fmt(unit: 'money' | 'count', v: number) {
  return unit === 'money' ? money(v) : count(v)
}

/** Compact axis labels — ₹9.4L reads faster than ₹9,41,000 at 10px. */
function short(unit: 'money' | 'count', v: number) {
  if (unit === 'count') return count(v)
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`
  if (v >= 1000) return `₹${Math.round(v / 1000)}k`
  return `₹${Math.round(v)}`
}

function Frame({ caption, right, children }: {
  caption: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <figure className="overflow-hidden rounded-control bg-inset shadow-hairline">
      <figcaption className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
        <span className="text-[11px] text-ink-3">{caption}</span>
        {right}
      </figcaption>
      {children}
    </figure>
  )
}

function Tip({ rows }: { rows: { label: string; value: string; color: string }[] }) {
  return (
    <div className="bui-chart-tip">
      {rows.map((r) => (
        <div key={r.label} className="bui-chart-tip-row">
          <span>
            <span className="bui-chart-tip-dot" style={{ background: r.color }} />
            {r.label}
          </span>
          <strong>{r.value}</strong>
        </div>
      ))}
    </div>
  )
}

/* ── Line ─────────────────────────────────────────────────
   Multi-series trend. The paths draw themselves left to right on arrival,
   which is the only moment the chart is allowed to move. */
function LineChart({ block }: { block: Extract<ChartBlock, { variant: 'line' }> }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 300
  const H = 128
  const PAD = 10
  const n = block.labels.length

  const { paths, scale } = useMemo(() => {
    const all = block.series.flatMap((s) => s.values)
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    /* A flat series would divide by zero; give it a band to sit in. */
    const span = hi - lo || Math.abs(hi) || 1
    const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2)
    const x = (i: number) => (i / (n - 1)) * W
    return {
      scale: { lo, hi },
      paths: block.series.map((s) => ({
        ...s,
        d: s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
        pts: s.values.map((v, i) => ({ x: x(i), y: y(v) })),
      })),
    }
  }, [block, n])

  const pick = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const p = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    setHover(Math.round(p * (n - 1)))
  }

  return (
    <Frame
      caption={block.caption}
      right={
        <span className="flex items-center gap-2.5">
          {block.series.map((s) => (
            <span key={s.label} className="flex items-center gap-1 text-[10.5px] text-ink-2">
              <span className="size-1.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </span>
      }
    >
      <div
        className="relative h-[150px] px-2 pt-2"
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[118px] w-full overflow-visible">
          {/* two reference lines, no full grid — the shape is the point */}
          {[0.25, 0.75].map((f) => (
            <line
              key={f}
              x1={0} x2={W} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)}
              stroke="var(--bui-line)" strokeWidth={1} vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Faded in, not drawn in.
              The left-to-right draw was a `stroke-dasharray` / `dashoffset`
              trick, and it left both series stranded part-drawn — a chart
              showing three of its five weeks, which is not a slower truth but
              a different and wrong one. A chart is either the data or it is
              nothing; the arrival can be a fade. */}
          {paths.map((s, si) => (
            <path
              key={s.label}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ animation: `bui-fade-in 420ms ease-out ${si * 120}ms both` }}
            />
          ))}
          {hover !== null &&
            paths.map((s) => (
              <circle
                key={s.label}
                cx={s.pts[hover].x}
                cy={s.pts[hover].y}
                r={3}
                fill="var(--bui-surface)"
                stroke={s.color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>

        <div className="flex justify-between px-0.5 pb-1.5 text-[10px] text-ink-3">
          {block.labels.map((l) => <span key={l}>{l}</span>)}
        </div>

        {hover !== null && (
          <>
            <span className="bui-chart-cursor" style={{ left: `${8 + (hover / (n - 1)) * (100 - 3)}%` }} />
            <span
              className="pointer-events-none absolute top-0"
              style={{ left: `${Math.min(Math.max((hover / (n - 1)) * 100, 24), 76)}%` }}
            >
              <Tip
                rows={block.series.map((s) => ({
                  label: s.label,
                  value: fmt(block.unit, s.values[hover]),
                  color: s.color,
                }))}
              />
            </span>
          </>
        )}
      </div>
      <div className="flex items-baseline justify-between border-t border-line px-2.5 py-1.5">
        <span className="text-[10.5px] text-ink-3">low {short(block.unit, scale.lo)}</span>
        <span className="text-[10.5px] text-ink-3">high {short(block.unit, scale.hi)}</span>
      </div>
    </Frame>
  )
}

/* ── Bars ─────────────────────────────────────────────────
   Buckets. Tone carries the reading — the oldest money is drawn in the
   destructive token, so the chart says which end is the problem. */
function BarChart({ block }: { block: Extract<ChartBlock, { variant: 'bars' }> }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...block.bars.map((b) => b.value))
  const total = block.bars.reduce((n, b) => n + b.value, 0)

  /* Only the worst bucket takes colour. Giving every "warn" bar an amber fill
     turned the whole chart into a block of orange, which said nothing about
     which bucket to worry about and clashed with a surface that is otherwise
     grey. Neutral is the default; red is the exception, and it is the point. */
  const toneColor = (tone?: 'bad' | 'warn') =>
    tone === 'bad' ? 'var(--bui-red)' : 'var(--bui-line-strong)'

  return (
    <Frame
      caption={block.caption}
      right={<span className="text-[10.5px] text-ink-2 tabular-nums">{fmt(block.unit, total)} total</span>}
    >
      <div className="flex h-[124px] items-end gap-3 px-3 pt-3 pb-2">
        {block.bars.map((b, i) => (
          <button
            key={b.label}
            type="button"
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            className="group relative flex h-full flex-1 flex-col justify-end gap-1"
            aria-label={`${b.label}: ${fmt(block.unit, b.value)}`}
          >
            <span
              className="text-center text-[10px] tabular-nums transition-colors duration-150"
              style={{ color: hover === i ? 'var(--bui-ink)' : 'var(--bui-ink-3)' }}
            >
              {short(block.unit, b.value)}
            </span>
            <span
              className="mx-auto w-full max-w-[46px] rounded-[3px] transition-opacity duration-150"
              style={{
                /* Scaled against the plot area, not the card, so the tallest
                   bar leaves room for its own label instead of hitting the
                   frame. */
                height: `${(b.value / max) * 74}%`,
                background: toneColor(b.tone),
                opacity: hover === null || hover === i ? 1 : 0.45,
                transformOrigin: 'bottom',
                animation: `bui-grow-y 620ms cubic-bezier(0.23,1,0.32,1) ${i * 90}ms both`,
              }}
            />
            <span className="text-center text-[10px] text-ink-3">{b.label}</span>
          </button>
        ))}
      </div>
    </Frame>
  )
}

/* ── Split ────────────────────────────────────────────────
   One bar, several claims on it. Selecting a segment changes what the note
   below explains without moving anything — the card holds its height. */
function SplitChart({ block }: { block: Extract<ChartBlock, { variant: 'split' }> }) {
  const [picked, setPicked] = useState(0)
  const total = block.segments.reduce((n, s) => n + s.value, 0)
  const active = block.segments[picked]

  return (
    <Frame
      caption={block.caption}
      right={<span className="text-[10.5px] text-ink-2 tabular-nums">{total.toFixed(2).replace(/\.00$/, '')}h</span>}
    >
      <div className="p-2.5">
        <div className="flex h-8 gap-0.5 overflow-hidden rounded-full bg-field p-0.5" role="group">
          {block.segments.map((s, i) => (
            <button
              key={s.label}
              type="button"
              aria-pressed={picked === i}
              aria-label={`${s.label}: ${s.value} hours`}
              onClick={() => setPicked(i)}
              className="h-full rounded-full transition-[opacity,transform] duration-300 active:scale-[0.98]"
              style={{
                width: `${(s.value / total) * 100}%`,
                background: s.color,
                opacity: picked === i ? 1 : 0.5,
                boxShadow: picked === i ? 'inset 0 0 0 1px rgb(255 255 255 / 0.24)' : undefined,
                transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)',
                animation: `bui-fade-in 400ms ease-out ${i * 90}ms both`,
              }}
            />
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {block.segments.map((s, i) => (
            <button
              key={s.label}
              type="button"
              aria-pressed={picked === i}
              onClick={() => setPicked(i)}
              className={`flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] transition-colors duration-150 ${
                picked === i ? 'bg-field text-ink' : 'text-ink-2 hover:bg-fill hover:text-ink'
              }`}
            >
              <span className="size-1.5 rounded-full" style={{ background: s.color }} />
              {s.label}
              <span className="tabular-nums text-ink-3">{s.value}h</span>
            </button>
          ))}
        </div>

        <p className="mt-2 min-h-[34px] rounded-control bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-2 shadow-hairline">
          {active.hint}
        </p>
      </div>
    </Frame>
  )
}

export function Chart({ block }: { block: ChartBlock }) {
  if (block.variant === 'line') return <LineChart block={block} />
  if (block.variant === 'bars') return <BarChart block={block} />
  return <SplitChart block={block} />
}
