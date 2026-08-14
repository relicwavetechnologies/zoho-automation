/**
 * Sending a message moves it to the top of the screen, and the reply arrives
 * underneath it.
 *
 * Ported from the desktop's `ConversationPinSpacer`. Without it a thread only
 * ever follows its own bottom edge, so a long answer scrolls the question you
 * just asked off the top of the screen while you are still reading the first
 * line of the reply — you end up chasing your own message upward. Pinning it
 * puts the ask and its answer in one stable frame, which is what every chat
 * surface people already use does, the desktop included.
 *
 * The mechanism is a spacer rather than a scripted scroll, and that is the whole
 * trick. A `scrollIntoView` fights the reply: every frame of streaming text
 * changes the page height, so the position has to be re-imposed continuously and
 * the reader feels each correction. Instead this reserves
 * `viewport − (content below the pinned message)` of empty space at the very
 * bottom, which makes "scrolled to the bottom" and "pinned message at the top"
 * the same position. The thread's ordinary follow-the-bottom behaviour then
 * holds the pin for free, and as the reply grows the reserve shrinks to nothing
 * and the thread goes back to behaving normally — no mode to exit, no handoff.
 *
 * There is exactly one scroll here, on the send itself, to travel to the bottom
 * this has just redefined. Everything after that is the screen's own auto-follow
 * — which already stops the moment the reader scrolls up, so escaping the pin
 * needs no code and no special case.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** Breathing room between the header and the message pinned under it. */
const GAP_BELOW_HEADER = 12

/**
 * How much empty space the thread must end with for the pinned message to reach
 * the top of the viewport when the thread is scrolled fully down.
 *
 * `belowPin` is everything from the top of the pinned message to the end of the
 * thread — the message itself, the reply growing under it, and the column's own
 * bottom padding. Once that alone fills the viewport the pin is reachable
 * without any help, and the reserve must be nothing: any left over would be
 * blank space the reader has to scroll past to see the end of the answer.
 */
export function reserveFor(input: {
  /** The scrolling viewport's height. */
  viewport: number
  /** Content from the pinned message's top edge to the end of the thread. */
  belowPin: number
  /** Space kept clear at the top, for the header the message would sit behind. */
  topGap: number
}): number {
  return Math.max(0, input.viewport - input.belowPin - input.topGap)
}

export type PinSpacerProps = {
  /** The scrolling element. Its height is what the reserve is measured against. */
  scroller: RefObject<HTMLElement | null>
  /** The thread's column of exchanges, each carrying a `data-exchange-id`. */
  column: RefObject<HTMLElement | null>
  /**
   * The exchange to pin. Null until something has actually been sent from this
   * screen, which is what keeps a reopened thread scrolling normally.
   */
  pinId: string | null
  /** Bumped once per send, and the only thing that repositions the thread. */
  nonce: number
}

/**
 * The reserve, rendered after the thread's column rather than inside it.
 *
 * Outside, for two reasons. The column is a gapped flex list, so a spacer inside
 * it would add a gap's worth of dead space under every thread that is not
 * pinned. And measuring the column's own bottom edge — rather than the spacer's
 * top — keeps the arithmetic independent of the spacer's height, so the value
 * being computed can never feed back into the measurement that computes it.
 */
export function PinSpacer({ scroller, column, pinId, nonce }: PinSpacerProps) {
  const spacerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  /* Read inside `recompute`, which must not be rebuilt on every height change —
     it is what the ResizeObserver holds, and re-subscribing per frame of a
     streaming reply would cost more than the measurement it is guarding. */
  const heightRef = useRef(0)
  heightRef.current = height

  const recompute = useCallback(() => {
    const scroll = scroller.current
    const list = column.current
    if (!scroll || !list || !pinId || nonce === 0) {
      if (heightRef.current !== 0) setHeight(0)
      return
    }

    /* Walked rather than queried: an exchange id is server-supplied text, and a
       quote inside one would turn an attribute selector into a syntax error. */
    let pinned: HTMLElement | null = null
    for (const child of Array.from(list.children)) {
      if (child.getAttribute('data-exchange-id') === pinId) {
        pinned = child as HTMLElement
        break
      }
    }
    if (!pinned) return

    /* The header does not scroll away — it is stuck to the top of this same
       scroller — so a message at "the top" would sit behind it. Measured rather
       than assumed, because the header's height is set by its own type. */
    const header = scroll.querySelector('header')
    const topGap = (header?.offsetHeight ?? 0) + GAP_BELOW_HEADER

    const desired = reserveFor({
      viewport: scroll.clientHeight,
      belowPin: list.getBoundingClientRect().bottom - pinned.getBoundingClientRect().top,
      topGap,
    })
    // A sub-pixel difference is a re-render that changes nothing visible.
    if (Math.abs(desired - heightRef.current) > 1) setHeight(desired)
  }, [scroller, column, pinId, nonce])

  /* Keep the reserve honest while the reply streams in, and when the window
     changes size under it. */
  useEffect(() => {
    const list = column.current
    if (!list) return
    const observer = new ResizeObserver(() => recompute())
    observer.observe(list)
    window.addEventListener('resize', recompute)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', recompute)
    }
  }, [recompute, column])

  /* On a send: reserve the space, then travel to the bottom it just redefined.
     Two passes because the first runs before the browser has laid the new
     message out, so what it measures is the thread as it was a frame ago.

     This is the only scroll in the feature, and it happens once per send. From
     here the screen's own follow-the-bottom keeps the pin in place for nothing,
     because the bottom and the pin are now the same position — and the moment
     the reader scrolls up, that follow stops and so does the pinning. */
  useLayoutEffect(() => {
    if (!pinId || nonce === 0) return
    recompute()
    const frame = requestAnimationFrame(() => {
      recompute()
      const scroll = scroller.current
      if (scroll) scroll.scrollTop = scroll.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
    /* Keyed on the send alone. Recomputing on every content change is the job of
       the observer above; scrolling on every content change would drag the page
       out from under someone who is reading it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  return <div ref={spacerRef} aria-hidden="true" style={{ height }} />
}
