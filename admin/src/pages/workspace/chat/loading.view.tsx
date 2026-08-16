/**
 * Things on their way, drawn as the shape they are about to be.
 *
 * One vocabulary for the whole surface. There were two: the thread column drew
 * *nothing at all* while it loaded — loading was not a state anything modelled,
 * merely the absence of exchanges, which is also what an empty thread and a
 * failed read look like — and the document panel drew pulsing bars of its own,
 * a shade too faint to see, in a treatment nothing else used.
 *
 * The shared rules, in one place so the next one to arrive inherits them:
 *
 *   **Shaped like the thing arriving.** Not a spinner. The layout must not jump
 *   when the real content lands; the reader's eye should already be where the
 *   first line will be.
 *
 *   **Still.** Movement on this surface means the agent is working, and reading
 *   something off the server is not the agent doing anything. Pulsing bars say
 *   a run has started when none has.
 *
 *   **`bg-field`.** One step off the canvas is a smudge, not a placeholder —
 *   this is the tone the prompt bubble itself is drawn in, so a bar weighs what
 *   replaces it.
 *
 *   **Late.** Held back a beat, because content already in the browser's cache
 *   lands in a few milliseconds and a skeleton that flashes up and vanishes
 *   inside one frame reads as a glitch rather than as progress.
 */

/**
 * One placeholder line.
 *
 * The only primitive. Everything below is an arrangement of these, which is
 * what keeps two skeletons on this surface looking like one idea.
 */
export function Bar({ width, height, className = 'rounded-[4px]' }: {
  width: string
  height: number
  className?: string
}) {
  return <span className={`block bg-field ${className}`} style={{ width, height }} />
}

/** The delay every skeleton opens on. See "Late" above. */
const HOLD = 'bui-fade-in 200ms ease-out 180ms both'

/**
 * A conversation that is on its way.
 *
 * Deliberately not a count of anything. We do not know how many turns are
 * coming until they arrive, and a skeleton that guesses wrong reflows twice.
 */
export function ThreadSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-8" style={{ animation: HOLD }}>
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
 * A document that has been opened but not yet read back.
 *
 * The tab opens the moment a run announces the document, which is one fetch
 * ahead of its body — so this is on screen for a real moment, every time.
 *
 * Ragged on purpose. Prose does not have justified edges, and a stack of
 * identical full-width bars reads as a table waiting to load rather than as a
 * document.
 */
export function DocumentSkeleton() {
  return (
    <div
      aria-label="Loading document"
      className="flex flex-col gap-3 px-5 py-6"
      style={{ animation: HOLD }}
    >
      {[92, 76, 84, 40, 88, 68].map((width, row) => (
        <Bar key={row} width={`${width}%`} height={12} />
      ))}
    </div>
  )
}

/**
 * The way back into a conversation longer than one page.
 *
 * At the top of the column rather than as an infinite scroll, because a thread
 * is read from its newest end and reaching upward is a deliberate act. Scroll
 * anchoring on the way up is the part that goes wrong quietly: prepending
 * content moves everything the reader is looking at, and a browser that has not
 * been told otherwise keeps the scroll offset rather than the content under it.
 */
export function LoadEarlier({ loading, onLoad }: {
  loading: boolean
  onLoad: () => void
}) {
  return (
    <div className="flex justify-center pb-2">
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="rounded-full bg-fill px-3 py-1 text-[11.5px] text-ink-3 transition-colors duration-100 hover:bg-field hover:text-ink-2 disabled:cursor-default disabled:text-ink-3"
      >
        {/* The label says what happens, not what is happening. A control whose
            text changes length mid-press moves under the cursor. */}
        {loading ? 'Loading earlier…' : 'Load earlier messages'}
      </button>
    </div>
  )
}
