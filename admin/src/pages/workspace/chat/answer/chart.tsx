/**
 * The chart a table can become.
 *
 * Two marks, because a table only ever has two stories: how big each thing is
 * (bars) and how something moved (a line). There is no pie, no second y-axis,
 * and no third mark waiting to be added — a chart inside a chat message is 150
 * pixels tall and every extra option is a way to be harder to read.
 *
 * The series colours are a validated categorical set: they clear the lightness
 * band, the chroma floor and the colour-blind separation floor against both the
 * light and the dark surface, so one set serves both themes. Text never wears a
 * series colour; the mark beside it carries the identity.
 */
import { useState } from 'react'
import type { Plot, Series } from './table'

/** Fixed order, never cycled. A fifth series is not drawn — it stays in the table. */
const SERIES_COLORS = ['#3b82f6', '#d97706', '#8b5cf6', '#db2777']

/** Full value, in the model's own units. */
export function formatValue(value: number, prefix: string, suffix: string): string {
  const locale = prefix === '₹' ? 'en-IN' : 'en-US'
  const rounded = Math.abs(value) < 10 ? Math.round(value * 100) / 100 : Math.round(value)
  return `${prefix}${rounded.toLocaleString(locale)}${suffix}`
}

/** Axis-sized. `₹9.4L` reads in the space `₹9,41,000` needs to be squinted at. */
export function formatCompact(value: number, prefix: string, suffix: string): string {
  const size = Math.abs(value)
  if (prefix === '₹') {
    if (size >= 1e7) return `₹${+(value / 1e7).toFixed(1)}Cr`
    if (size >= 1e5) return `₹${+(value / 1e5).toFixed(1)}L`
    if (size >= 1e3) return `₹${Math.round(value / 1e3)}k`
    return `₹${Math.round(value)}`
  }
  if (size >= 1e9) return `${prefix}${+(value / 1e9).toFixed(1)}B${suffix}`
  if (size >= 1e6) return `${prefix}${+(value / 1e6).toFixed(1)}M${suffix}`
  if (size >= 1e4) return `${prefix}${Math.round(value / 1e3)}k${suffix}`
  return formatValue(value, prefix, suffix)
}

function Legend({ series }: { series: Series[] }) {
  // One series is named by the column it came from; a box saying so twice is noise.
  if (series.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2.5">
      {series.map((one, index) => (
        <span key={one.name} className="flex items-center gap-1.5 text-[11px] text-ink-2">
          <span
            className="size-2 rounded-[2px]"
            style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
          />
          {one.name}
        </span>
      ))}
    </div>
  )
}

function Tooltip({ label, rows }: { label: string; rows: { name: string; value: string; color: string }[] }) {
  return (
    <div className="bui-chart-tip">
      <div className="bui-chart-tip-row">
        <span>{label}</span>
      </div>
      {rows.map(row => (
        <div key={row.name} className="bui-chart-tip-row">
          <span>
            <span className="bui-chart-tip-dot" style={{ background: row.color }} />
            {row.name}
          </span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  )
}

/** Which x labels get printed, so they never collide. */
function labelStride(count: number, room: number): number {
  return Math.max(1, Math.ceil(count / room))
}

/* ── Bars ─────────────────────────────────────────────────
   Magnitude by category. Laid out in flex rather than an SVG viewBox so the
   chart is responsive without doing arithmetic about how wide it is. */
function Bars({ plot }: { plot: Plot }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...plot.series.flatMap(s => s.values.map(v => Math.abs(v ?? 0))), 0)
  const stride = labelStride(plot.labels.length, 8)

  return (
    <div className="relative flex h-[132px] items-end gap-1.5 px-3 pt-4">
      {plot.labels.map((label, index) => (
        <div
          key={`${label}-${index}`}
          className="group relative flex h-full flex-1 flex-col justify-end"
          onPointerEnter={() => setHover(index)}
          onPointerLeave={() => setHover(null)}
        >
          {hover === index && (
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 -translate-x-1/2 pb-1">
              <Tooltip
                label={label}
                rows={plot.series.map((one, si) => ({
                  name: one.name,
                  value: one.values[index] === null ? '—' : formatValue(one.values[index]!, plot.prefix, plot.suffix),
                  color: SERIES_COLORS[si % SERIES_COLORS.length]!,
                }))}
              />
            </div>
          )}
          {/* A 2px gap between adjacent fills, so two series read as two. */}
          <div className="flex h-full items-end justify-center gap-[2px]">
            {plot.series.map((one, si) => (
              <span
                key={one.name}
                className="w-full max-w-[26px] rounded-t-[4px] transition-opacity duration-150"
                style={{
                  height: `${max > 0 ? (Math.abs(one.values[index] ?? 0) / max) * 100 : 0}%`,
                  background: SERIES_COLORS[si % SERIES_COLORS.length],
                  opacity: hover === null || hover === index ? 1 : 0.4,
                  transformOrigin: 'bottom',
                  animation: `bui-grow-y 560ms cubic-bezier(0.23,1,0.32,1) ${index * 45}ms both`,
                }}
              />
            ))}
          </div>
          <span className="mt-1.5 truncate text-center text-[10px] text-ink-3">
            {index % stride === 0 ? label : ' '}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── Line ─────────────────────────────────────────────────
   Change over time. Drawn in a viewBox that scales as a whole, so the stroke
   and the markers keep their proportions at any width. */
function Line({ plot }: { plot: Plot }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 520
  const H = 150
  const PAD = { top: 12, right: 10, bottom: 22, left: 10 }

  const all = plot.series.flatMap(s => s.values.filter((v): v is number => v !== null))
  const max = Math.max(...all, 0)
  const min = Math.min(...all, 0)
  const span = max - min || 1

  const x = (index: number) =>
    PAD.left + (index / Math.max(1, plot.labels.length - 1)) * (W - PAD.left - PAD.right)
  const y = (value: number) =>
    PAD.top + (1 - (value - min) / span) * (H - PAD.top - PAD.bottom)

  const stride = labelStride(plot.labels.length, 7)

  return (
    <div className="relative px-3 pt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Trend">
        {/* Recessive grid: three rules, no box, no ticks. */}
        {[0, 0.5, 1].map(step => (
          <line
            key={step}
            x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + step * (H - PAD.top - PAD.bottom)}
            y2={PAD.top + step * (H - PAD.top - PAD.bottom)}
            stroke="var(--bui-line)" strokeWidth={1}
          />
        ))}

        {plot.series.map((one, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length]!
          const points = one.values
            .map((value, index) => (value === null ? null : `${x(index)},${y(value)}`))
            .filter(Boolean)
            .join(' ')
          return (
            <g key={one.name}>
              <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ animation: 'bui-fade-in 520ms ease-out both' }}
              />
              {one.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={index}
                    cx={x(index)} cy={y(value)}
                    r={hover === index ? 4.5 : 3}
                    fill={color}
                    /* A ring in the surface colour, so crossing series stay apart. */
                    stroke="var(--bui-surface)" strokeWidth={2}
                  />
                ),
              )}
            </g>
          )
        })}

        {plot.labels.map((label, index) =>
          index % stride === 0 ? (
            <text
              key={`${label}-${index}`}
              x={x(index)} y={H - 6}
              textAnchor={index === 0 ? 'start' : index === plot.labels.length - 1 ? 'end' : 'middle'}
              fontSize={10} fill="var(--bui-ink-3)"
            >
              {label}
            </text>
          ) : null,
        )}

        {/* Hit bands, wider than the markers, so hovering is not a game of skill. */}
        {plot.labels.map((label, index) => (
          <rect
            key={`hit-${label}-${index}`}
            x={x(index) - (W / plot.labels.length) / 2}
            y={0}
            width={W / plot.labels.length}
            height={H}
            fill="transparent"
            onPointerEnter={() => setHover(index)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2"
          style={{ left: `${(x(hover) / W) * 100}%` }}
        >
          <Tooltip
            label={plot.labels[hover]!}
            rows={plot.series.map((one, si) => ({
              name: one.name,
              value: one.values[hover] === null ? '—' : formatValue(one.values[hover]!, plot.prefix, plot.suffix),
              color: SERIES_COLORS[si % SERIES_COLORS.length]!,
            }))}
          />
        </div>
      )}
    </div>
  )
}

export function PlotView({ plot }: { plot: Plot }) {
  return (
    <div>
      {plot.mark === 'line' ? <Line plot={plot} /> : <Bars plot={plot} />}
      <Legend series={plot.series} />
    </div>
  )
}
