/**
 * A conversation that is on its way.
 *
 * Loading was not a state anything modelled here — it was the *absence* of
 * exchanges, which is also what an empty thread looks like and what a failed
 * read looks like. So the column drew nothing at all while a thread loaded, and
 * a slow read was indistinguishable from a chat with nothing in it. On a long
 * thread that is a second or more of blank page directly after a click.
 *
 * Shaped like the thing it is about to become rather than like a spinner: a
 * prompt on the right, a few log lines under it, an answer below. The point is
 * that the layout does not jump when the real transcript lands — the reader's
 * eye is already where the first line will be.
 *
 * Deliberately not a count of anything. We do not know how many turns are
 * coming until they arrive, and a skeleton that guesses wrong reflows twice.
 */
export function ThreadSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-8" style={{
      /* Held back a beat. A thread already in the browser's cache lands in a
         few milliseconds, and a skeleton that flashed up and vanished inside
         one frame reads as a glitch rather than as progress. */
      animation: 'bui-fade-in 200ms ease-out 180ms both',
    }}>
      <ExchangeSkeleton promptWidth="42%" lines={3} answerLines={3} />
      <ExchangeSkeleton promptWidth="28%" lines={2} answerLines={2} />
    </div>
  )
}

function ExchangeSkeleton({ promptWidth, lines, answerLines }: {
  promptWidth: string
  lines: number
  answerLines: number
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end pl-16">
        <Bar width={promptWidth} height={30} className="rounded-card" />
      </div>
      <div className="flex flex-col gap-3">
        {/* The work log: a mark and a label per row, at the log's own rhythm. */}
        <div className="flex flex-col gap-2">
          {Array.from({ length: lines }, (_, row) => (
            <div key={row} className="flex items-center gap-2.5">
              <Bar width="16px" height={14} className="rounded-[3px]" />
              <Bar width={`${34 + row * 9}%`} height={12} />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2 pt-1">
          {Array.from({ length: answerLines }, (_, row) => (
            <Bar key={row} width={row === answerLines - 1 ? '54%' : '100%'} height={12} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One placeholder line.
 *
 * `bg-field` and nothing else — no pulse. The surface's rule is that movement
 * means the agent is working, and a thread being read off the server is not the
 * agent doing anything. A wall of throbbing bars would say a run had started.
 *
 * `bg-field` rather than the lighter `bg-fill`, which sits one step off the
 * canvas and read as an empty page with a faint smudge on it. This is the tone
 * the prompt bubble itself is drawn in, so the placeholder is the same weight
 * as the thing replacing it.
 */
function Bar({ width, height, className = 'rounded-[4px]' }: {
  width: string
  height: number
  className?: string
}) {
  return <span className={`block bg-field ${className}`} style={{ width, height }} />
}
