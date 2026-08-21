/**
 * The two marks that say "this is happening".
 *
 * They lived in `parts.tsx` until the sidebar needed one. `parts.tsx` pulls in
 * the markdown renderer and every vendor logo, which is the right weight for a
 * thread and absurd for a 6px loader on a rail row — so the two smallest things
 * in it moved here, where anything can import them for the cost of a class name.
 *
 * Both draw from `beautiful.css`, whose tokens hang off `.cur`. That is the
 * workspace root, so they theme correctly anywhere inside the app and would
 * render as invisible ink outside it.
 */
import '@/styles/beautiful.css'

/**
 * A chevron wavefront, driving right.
 *
 * Delay rises with the column and with distance from the middle row, so the
 * light arrives as a slanted front rather than a column at a time. The cycle is
 * shorter than the sweep, which means a second front enters before the first
 * has left and the mark never appears to stall — the whole job of a loader on a
 * run that can legitimately take a minute.
 */
const DRIVE = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3)
  const col = i % 3
  return (col + Math.abs(row - 1)) * 90
})

/**
 * The perimeter of the same grid, clockwise from the top-left.
 *
 *     0 1 2
 *     3 4 5      →  0 1 2 5 8 7 6 3
 *     6 7 8
 *
 * Ring order, not reading order, and that is the whole pattern: cell 3 lights
 * LAST, after 6, because it is the step before the lap closes. Sorted into
 * index order the light would sweep down the grid in rows, which is `drive`
 * with extra steps.
 *
 * The centre is `null` — off the path, never lit. It is what makes this read as
 * one thing travelling rather than as eight cells blinking: a still middle is
 * the reference the movement is measured against.
 *
 * 110ms apart across a 950ms cycle, so eight steps span 880ms and the comet
 * laps with a short dark beat before coming round. Spacing them to fill the
 * cycle exactly would put the head back on cell 0 as the tail left it, and an
 * unbroken ring of light is a spinner, not a comet.
 */
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const step = ORBIT_ORDER.indexOf(i)
  return step === -1 ? null : step * 110
})

const PATTERNS = { drive: DRIVE, orbit: ORBIT } as const

/**
 * The mark for "Divo itself is working" — one 3×3 grid, two patterns.
 *
 * Used in exactly two places, and the pattern is how they differ:
 *
 *   `drive` — the head of the run log. You are looking straight at this one
 *             while it works, so it gets the busier read.
 *   `orbit` — a thread in the rail. It sits in a list of otherwise static rows
 *             and has to say "this one is live" from the corner of the eye,
 *             which a lap round a still centre does at 15px and a wavefront
 *             does not.
 *
 * Not for a row inside the log — a step there shows its own tool's mark, and a
 * burst or an agent shows `DotsLoader`.
 *
 * The source this is taken from carries a third pattern, `dots`: the `drive`
 * wavefront with the cells rounded off. Nothing selects it, so it is not here.
 */
export function PixelGrid({ pattern = 'drive' }: { pattern?: keyof typeof PATTERNS }) {
  return (
    <span aria-hidden data-pattern={pattern} className="bui-pixels">
      {PATTERNS[pattern].map((delay, i) => (
        <i key={i} {...(delay === null ? {} : { style: { animationDelay: `${delay}ms` } })} />
      ))}
    </span>
  )
}

/** The label that says work is happening — the text itself shimmers. */
export function Shimmer({ children }: { children: React.ReactNode }) {
  return <span className="bui-shimmer text-[13px] font-medium whitespace-nowrap">{children}</span>
}

/**
 * The running indicator for a row with no identity of its own — ported from the
 * desktop's `DotsLoader`, dot for dot.
 *
 * The rule that comes with it matters more than the glyph: **use this only
 * where the row has nothing better to show.** A burst header qualifies, because
 * a burst is several tools at once and has no single mark. A running call to a
 * real tool does NOT — it shows that tool's own mark and shimmers its label,
 * because "Gmail is working" beats "something is working", and swapping the
 * mark for dots throws away the most useful thing on the row.
 *
 * Two rhythms, chosen by what the row means:
 *
 *   `wave`    — the work log. Dots fade on a diagonal stagger. Says "busy"
 *               without claiming progress, which is the honest reading for a
 *               step that may sit unchanged for a minute.
 *   `scatter` — an agent, and the header over a group of them. Three of the six
 *               lit at any instant, with the trio jumping around the grid.
 *               Busier on purpose: several of these sit stacked in one card,
 *               and on the calmer wave a column of them reads as a static list
 *               of labels rather than as four agents actually working.
 *
 * Phase offsets are all NEGATIVE, which starts each dot already in progress so
 * the grid is at its correct phase on the very first frame. Positive delays
 * would leave dots sitting unanimated until their turn came round, which
 * flashes on mount.
 *
 * `wave` runs the diagonal — brightness travels top-left to bottom-right rather
 * than row by row. `scatter` keeps exactly three of six lit: each dot is lit
 * for half of a 1.8s cycle and these are the six even 300ms phases, so one
 * switches off exactly as another switches on. The ORDER is deliberately
 * jumbled so the lit trio scatters across the grid instead of sweeping down it
 * — sorting them into index order keeps the count and destroys the effect.
 *
 * The box is a TEXT LINE BOX, not a square: 20px is `text-[13px]`'s line height,
 * which is what keeps the glyph optically centred on the label beside it with
 * no per-caller nudging, and aligned to the first line in a row whose text runs
 * to three. A square box is shorter than the line it sits in and rides visibly
 * high.
 */
const DELAYS: Record<DotsRhythm, number[]> = {
  wave: [-0, -105, -70, -175, -140, -245],
  scatter: [-0, -900, -1200, -300, -600, -1500],
}

type DotsRhythm = 'wave' | 'scatter'

export function DotsLoader({
  className, variant = 'wave',
}: {
  className?: string
  variant?: DotsRhythm
}) {
  return (
    <span
      aria-hidden
      className={`grid h-5 w-4 shrink-0 place-content-center ${className ?? ''}`}
      /* Tracks in px, not `grid-cols-2` — that expands to `repeat(n, minmax(0,
         1fr))`, which stretches the tracks across the whole box and scatters
         the dots into its corners whatever the gap says. */
      style={{
        gridTemplateColumns: 'repeat(2, 2.5px)',
        gridTemplateRows: 'repeat(3, 2.5px)',
        gap: '1.5px',
      }}
    >
      {DELAYS[variant].map((delay, i) => (
        <span
          key={i}
          className={`size-[2.5px] rounded-full bg-current ${
            variant === 'scatter' ? 'bui-dot-scatter' : 'bui-dot'
          }`}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}

/*
 * Divo's mark moved out.
 *
 * It was ported here first, because the work-log was the first surface that
 * needed it, and then five shells drew a lucide `Diamond` instead because this
 * was not where anybody would look for it. It lives in
 * `components/admin/divo-mark` now and is re-exported so the trace's import
 * keeps working. Same drawing, one copy.
 */
export { DivoMark } from '@/components/admin/divo-mark'
