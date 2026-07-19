import { cn } from '@/lib/utils'

/**
 * The app's running indicator — a 2x3 grid of dots (keyframes in `index.css`).
 *
 * Two rhythms, chosen by what the row actually means:
 *
 *   `wave`    — the work log. Dots fade on a diagonal stagger. Says "busy"
 *               without claiming progress, which is the honest reading for a
 *               step that may sit unchanged for a minute.
 *   `scatter` — the sidebar thread list. Three of the six lit at any instant,
 *               with the trio jumping around the grid. Busier than the wave on
 *               purpose: it has to catch the eye from the rail, across a list
 *               of otherwise-static rows.
 *
 * Use this only where the row has NO identity of its own — burst headers,
 * subagent children, a thread in the rail. A running call to a real tool shows
 * that TOOL'S icon plus a shimmering label instead: "Gmail is working" beats
 * "something is working", and swapping the icon out for dots throws away the
 * most useful thing on the row.
 *
 * The outer box is a TEXT LINE BOX, not a square: `h-5` is exactly `text-sm`'s
 * 20px line height, `h-4` matches the sidebar's smaller rows. That is what
 * keeps the glyph optically centred on its label in `items-center` rows AND
 * aligned to the first line in `items-start` rows (the subagent card), with no
 * per-caller margin nudges. Don't swap these for `size-*` — a square box is
 * shorter than the line it sits in and rides visibly high.
 */

/**
 * Phase offsets, by grid index. The grid is 2 columns x 3 rows, row-major:
 *
 *     0  1
 *     2  3
 *     4  5
 *
 * All values are NEGATIVE: a negative `animation-delay` starts the animation
 * already in progress, so every dot is at its correct phase on the very first
 * frame. Positive delays would leave dots sitting at their unanimated opacity
 * until their turn came round, which flashes on mount.
 *
 * `wave` runs the diagonal — offset is `-(row * 70 + col * 105)`, so brightness
 * travels top-left to bottom-right rather than row by row.
 *
 * `scatter` keeps exactly three of six lit at all times. The animation is a
 * 1.8s cycle lit for half of it, and these six offsets are the six even 300ms
 * phases — so three are always in their lit half. The ORDER is deliberately
 * jumbled (cell 1 gets phase 3, cell 2 gets phase 4, cell 3 gets phase 1…) so
 * the lit trio scatters across the grid instead of sweeping down it. Sorting
 * these into index order would keep the count correct and destroy the effect.
 */
const DELAYS: Record<'wave' | 'scatter', number[]> = {
  wave: [-0, -105, -70, -175, -140, -245],
  scatter: [-0, -900, -1200, -300, -600, -1500],
}

/**
 * The BOX is a text line box (`h-5` = `text-sm`'s 20px); the GRID inside it is
 * sized to the text's cap height, ~10px, so the glyph reads as a peer of the
 * letters beside it rather than as an oversized badge. Growing the dots is the
 * wrong lever if it looks weak — raise the contrast in `index.css` instead.
 *
 * Dot-to-gap ratio carries most of the character: at 2.5:1 the six dots read as
 * one cluster, which is what you want. Widen the gap much past that and they
 * stop being a glyph and start looking like six loose specks.
 */
const SIZES = {
  md: { box: 'h-5 w-4', dot: 2.5, gap: 1 },
  sm: { box: 'h-4 w-3', dot: 2, gap: 1 },
} as const

export function DotsLoader({
  className,
  idle = false,
  variant = 'wave',
  size = 'md',
}: {
  className?: string
  idle?: boolean
  variant?: 'wave' | 'scatter'
  size?: 'sm' | 'md'
}) {
  const { box, dot, gap } = SIZES[size]

  return (
    <span
      aria-hidden
      data-dots-loader={variant}
      className={cn(
        'grid shrink-0 grid-cols-2 grid-rows-3 place-content-center',
        box,
        className
      )}
      style={{ gap: `${gap}px` }}
    >
      {DELAYS[variant].map((delay, i) => (
        <span
          key={i}
          className={cn(
            'rounded-full bg-current',
            idle
              ? 'opacity-30'
              : variant === 'scatter'
                ? 'dot-scatter-cell'
                : 'dot-wave-cell'
          )}
          style={{
            width: `${dot}px`,
            height: `${dot}px`,
            animationDelay: idle ? undefined : `${delay}ms`,
          }}
        />
      ))}
    </span>
  )
}
