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
