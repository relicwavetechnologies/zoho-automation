import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * How long each suggestion holds before rolling to the next. Long enough to
 * read a full line without racing; short enough that a few land while someone
 * is deciding what to ask.
 */
const ROTATE_MS = 3600

/**
 * Suggestions, not instructions. Each is a real request Divo can service, so
 * the composer teaches what it's for while it sits idle — the first line is
 * the neutral one, and it's also the only one shown when motion is reduced.
 */
export const PLACEHOLDER_PROMPTS = [
  'Ask me anything…',
  'Check my unpaid invoices',
  "Summarise this week's expenses",
  'Scan my calendar for conflicts',
  'Draft a reply to the vendor',
  'Reconcile last month’s payments',
  'Find the Zoho bill for Acme',
]

/**
 * The composer's idle placeholder, rolling one line up at a time.
 *
 * A `<textarea placeholder>` can't animate, so this is an overlay that mirrors
 * the textarea's own type and padding. It is `pointer-events-none` and
 * `aria-hidden`: clicks fall through to the input, and screen readers get the
 * textarea's real placeholder attribute instead of a string that changes under
 * them every few seconds.
 *
 * Callers must hide the textarea's own placeholder while this shows, or the two
 * stack on top of each other.
 */
export function RotatingPlaceholder({ className }: { className?: string }) {
  const reduce = useReducedMotion()
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (reduce) return
    const id = setInterval(
      () => setIndex((i) => (i + 1) % PLACEHOLDER_PROMPTS.length),
      ROTATE_MS
    )
    return () => clearInterval(id)
  }, [reduce])

  const text = reduce ? PLACEHOLDER_PROMPTS[0] : PLACEHOLDER_PROMPTS[index]

  return (
    <div
      aria-hidden
      data-testid="rotating-placeholder"
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center overflow-hidden text-muted-foreground',
        className
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          // Rolls upward: the outgoing line exits through the top as the next
          // one arrives from below, so the column reads as one moving list
          // rather than two lines crossfading in place.
          initial={reduce ? false : { y: '110%', opacity: 0 }}
          animate={{ y: '0%', opacity: 1 }}
          exit={reduce ? undefined : { y: '-110%', opacity: 0 }}
          transition={{ duration: 0.34, ease: [0.32, 0.72, 0, 1] }}
          className="block truncate"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
