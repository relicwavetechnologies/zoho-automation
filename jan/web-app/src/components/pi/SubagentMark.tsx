import { cn } from '@/lib/utils'

/**
 * A per-agent identity mark.
 *
 * A card of four children is four rows of near-identical grey text, and the
 * only thing distinguishing "Backend scout" from "Adversarial review" is the
 * label itself — so scanning back to a specific agent means re-reading every
 * row. A small coloured glyph beside the name gives each one a shape you can
 * find without reading, which is what makes Codex's subagent chips scannable.
 *
 * The mark is DERIVED, never assigned: the same role always hashes to the same
 * shape and hue, across runs and across sessions. That stability is the whole
 * point — a mark that shuffled per render would be decoration rather than
 * identity. Two children genuinely sharing a role share a mark, which is
 * correct: they are the same kind of worker.
 *
 * These are deliberately abstract. A literal icon per role would need a
 * taxonomy of roles nobody maintains, and would be wrong the moment someone
 * spawns an agent we have no art for.
 */

/**
 * FNV-1a. Small, dependency-free, and well spread for short strings — role
 * names like "scout" and "scribe" must not collide onto the same mark just
 * because they share a prefix.
 */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Hues chosen to stay legible on both themes at 14px and to remain
 * distinguishable from each other — and from the log's own colour vocabulary,
 * where red already means failure.
 */
const HUES = [
  'text-rose-400',
  'text-violet-400',
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-fuchsia-400',
]

/**
 * Dot clusters, drawn on a 24×24 grid. Distinct in silhouette, not just hue.
 *
 * Solid silhouettes were tried here and are the obvious "safe at small size"
 * answer, but they read as flat and generic — a plain circle beside a plain
 * hexagon says nothing, so hue ends up carrying the whole distinction. The
 * clusters have far more character and stay separable at 14px, where the dots
 * hold roughly 3px apart.
 *
 * That separation is the constraint to respect when adding a shape: keep the
 * dots on this grid spacing. Pack them tighter and they close up into a blob
 * at render size, which is what makes a mark look cheap.
 */
const SHAPES: string[][] = [
  // Clover — four dots around the centre.
  ['8,8', '16,8', '8,16', '16,16'],
  // Triad.
  ['12,6', '7,17', '17,17'],
  // Compass — four points plus a centre.
  ['12,5', '5,12', '19,12', '12,19', '12,12'],
  // Hex ring.
  ['12,5', '18,8.5', '18,15.5', '12,19', '6,15.5', '6,8.5'],
  // Diagonal pair with a lead dot.
  ['7,7', '12,12', '17,17', '17,7'],
  // Column of three with a satellite.
  ['12,6', '12,12', '12,18', '18,12'],
]

export function SubagentMark({
  seed,
  className,
}: {
  seed: string
  className?: string
}) {
  const h = hash(seed.trim().toLowerCase() || 'agent')
  const dots = SHAPES[h % SHAPES.length]!
  // Shift the hue selector off a different slice of the hash than the shape,
  // so shape and colour vary independently instead of moving in lockstep.
  const hue = HUES[(h >>> 8) % HUES.length]!

  return (
    <svg
      viewBox="0 0 24 24"
      role="presentation"
      aria-hidden
      className={cn(hue, className)}
      fill="currentColor"
    >
      {dots.map((dot) => {
        const [cx, cy] = dot.split(',')
        return <circle key={dot} cx={cx} cy={cy} r="3.1" />
      })}
    </svg>
  )
}
