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
import { useId } from 'react'
import '@/styles/beautiful.css'

/* A 3×3 pixel grid with a chevron wavefront running through it. The cycle is
   shorter than the sweep, so two fronts are always in flight and the thing
   never appears to stall — which is the whole job of a loader on a run that can
   legitimately take thirty seconds. */
const WAVE = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3)
  const col = i % 3
  return (col + Math.abs(row - 1)) * 90
})

export function PixelGrid() {
  return (
    <span aria-hidden className="bui-pixels">
      {WAVE.map((delay, i) => (
        <i key={i} style={{ animationDelay: `${delay}ms` }} />
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
 * Phase offsets are all NEGATIVE, which starts each dot already in progress so
 * the grid is at its correct phase on the very first frame. Positive delays
 * would leave dots sitting unanimated until their turn came round, which
 * flashes on mount.
 *
 * The box is a TEXT LINE BOX, not a square: 20px is `text-[13px]`'s line height,
 * which is what keeps the glyph optically centred on the label beside it with
 * no per-caller nudging. A square box is shorter than the line it sits in and
 * rides visibly high.
 */
const WAVE_DELAYS = [-0, -105, -70, -175, -140, -245]

export function DotsLoader({ className }: { className?: string }) {
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
      {WAVE_DELAYS.map((delay, i) => (
        <span
          key={i}
          className="bui-dot size-[2.5px] rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}

/**
 * Divo's mark — the desktop's, glyph for glyph.
 *
 * A `D` drawn as an open stroke with a diagonal cut through it. Ported rather
 * than approximated: this signs the run log on both surfaces, and two marks
 * that are nearly the same read as two products.
 *
 * Drawn in `currentColor`, so it takes the weight of whatever row it sits in
 * and brightens with it on hover. The mask id is per-instance — two of these on
 * one page sharing an id means the second one erases through the first.
 */
export function DivoMark({ className }: { className?: string }) {
  const maskId = useId().replace(/:/g, '')
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={`shrink-0 ${className ?? ''}`}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect width="64" height="64" fill="#fff" />
          <path d="M5 59 59 5" stroke="#000" strokeWidth="9.5" />
        </mask>
      </defs>
      <path
        d="M17 10h9a22 22 0 0 1 0 44h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinejoin="round"
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}
