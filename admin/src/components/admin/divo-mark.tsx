/**
 * Divo's own mark: a monoline capital D cut by a clean 45-degree diagonal.
 *
 * The drawing comes from `jan/brand/divo/`, which is what the desktop app's
 * icon is generated from, so the web console and the desktop app wear the same
 * mark rather than two drawings of roughly the same idea. It replaces a lucide
 * `Diamond` that stood in for it in five shells.
 *
 * The chat work-log had already ported it, correctly, into `chat/loader.tsx`.
 * That copy now re-exports this one: the mark belongs to the product, not to
 * the trace renderer, and two drawings of it is exactly one too many.
 *
 * Two variants, and the difference matters. The cut is the signature gesture,
 * and at menu-bar and favicon sizes a 9.5-wide slice through a 7-wide stroke
 * closes into a smudge. The small variant thickens both so the gap survives.
 * The brand's own threshold is 20px, and that is the number below.
 *
 * `currentColor`, so it takes the ink of whatever it sits in: white inside the
 * orange tile the shells use, body ink anywhere it stands on its own.
 *
 * The cut is a mask rather than a second stroke in the background colour, which
 * is what the app-icon source does. A painted-over slice only works when you
 * know what is behind the mark; a mask works on the tile, on the page, and over
 * whatever a future surface puts behind it.
 */
import { useId } from 'react'

/** Below this, the cut closes up and the heavier variant takes over. */
const SMALL_BELOW = 20

export function DivoMark({ size = 16, className, title }: {
  /**
   * Drawn at this many pixels, and the variant is chosen from it.
   *
   * A caller sizing the mark from CSS instead can pass `className` and leave
   * this alone; the attribute is only a default for the box.
   */
  size?: number
  className?: string
  /** Give it one only where the mark is the sole thing naming Divo. */
  title?: string
}) {
  const small = size < SMALL_BELOW
  /*
   * Per instance, and this is not tidiness.
   *
   * `url(#id)` resolves to the first element in the document carrying that id.
   * With a shared id, every mark on the page points at whichever one mounted
   * first — and the moment that one unmounts, the rest lose their mask and
   * redraw as an uncut D. The shells and the work-log put several of these on
   * screen at once, so it would happen.
   */
  const mask = useId().replace(/:/g, '')

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`shrink-0 ${className ?? ''}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      /* The global `.cur svg { stroke-width: 1.5 }` rule would otherwise
         overwrite the mark's weight and leave a hairline D. */
      style={{ strokeWidth: 'initial' }}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect width="64" height="64" fill="#fff" />
          <path
            d={small ? 'M4 60 60 4' : 'M5 59 59 5'}
            stroke="#000"
            strokeWidth={small ? 11.5 : 9.5}
          />
        </mask>
      </defs>
      <path
        d="M17 10h9a22 22 0 0 1 0 44h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth={small ? 8.5 : 7}
        strokeLinejoin="round"
        mask={`url(#${mask})`}
      />
    </svg>
  )
}
