/**
 * Taking something out of the conversation.
 *
 * An answer is usually written down somewhere else — a doc, a ticket, a reply
 * to the person who asked. Until now the only way out of this thread was
 * selecting the text by hand, which on an answer with a table gets you the
 * table's *rendered* cells run together into a paragraph.
 *
 * So this copies the **markdown source**, not what the screen is showing. That
 * is the form that survives being pasted: the table is still a table wherever
 * it lands, the links keep their targets, and the headings keep being headings.
 * The thread and Lark already agree that markdown is the interchange format —
 * this is the same decision applied to the clipboard.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'

/**
 * What the last attempt did. `failed` is a real state rather than a silent
 * no-op: `navigator.clipboard` does not exist in an insecure context and can be
 * refused by permission policy, and a button that flashes "copied" over an
 * empty clipboard sends someone to paste nothing into a customer email.
 */
type Attempt = 'idle' | 'copied' | 'failed'

/** How long the outcome stays on the button before it offers itself again. */
const SETTLE_MS = 1_600

const FACE: Record<Attempt, { Icon: typeof Copy; label: string }> = {
  idle: { Icon: Copy, label: 'Copy' },
  copied: { Icon: Check, label: 'Copied' },
  failed: { Icon: X, label: 'Could not copy' },
}

export function CopyButton({ text, className = '' }: {
  /** Copied verbatim. Markdown source, never the rendered text — see above. */
  text: string
  className?: string
}) {
  const [attempt, setAttempt] = useState<Attempt>('idle')
  const settle = useRef<number | undefined>(undefined)

  /* The button can leave with a timer still pending — a reader who copies an
     answer and immediately opens another thread unmounts it mid-countdown. */
  useEffect(() => () => window.clearTimeout(settle.current), [])

  const copy = async () => {
    let done = false
    try {
      await navigator.clipboard.writeText(text)
      done = true
    } catch {
      /* Reported on the button rather than thrown. Nothing else in the thread
         depends on this succeeding, and a failed copy is not a failed run. */
    }
    setAttempt(done ? 'copied' : 'failed')
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => setAttempt('idle'), SETTLE_MS)
  }

  const { Icon, label } = FACE[attempt]

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      /* Revealed on hover, like the rest of the thread's controls — but
         `focus-visible` keeps it reachable by keyboard, where an opacity-only
         reveal would otherwise hide a control that is still in the tab order
         and leave someone tabbing to something they cannot see. */
      className={`flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-fill hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 ${className}`}
    >
      <Icon size={13} />
    </button>
  )
}
