import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { IconArrowDown } from '@tabler/icons-react'
import type { ComponentProps } from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  memo,
} from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = memo(({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    // Jump to the bottom on (re)mount rather than animating a scroll. The thread
    // route remounts on every thread switch, so a "smooth" initial scroll played
    // a visible scroll animation each time a chat was opened — jarring. "instant"
    // positions at the bottom with no motion; live streaming still animates via
    // `resize`.
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  />
))

Conversation.displayName = 'Conversation'

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = memo(({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn('flex flex-col gap-x-8 gap-y-2 px-2', className)}
    {...props}
  />
))

ConversationContent.displayName = 'ConversationContent'

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export const ConversationEmptyState = ({
  className,
  title = 'No messages yet',
  description = 'Start a conversation to see messages here',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
)

export type ConversationPinSpacerProps = {
  /**
   * The message to pin near the top of the viewport (typically the latest user
   * turn). Must carry a matching `data-message-id` on its DOM element.
   */
  pinId: string | null
  /** Bumped each time a fresh turn should be pinned (i.e. on send). */
  nonce: number
  /** Gap in px to leave above the pinned message when it's at the top. */
  topGap?: number
}

/**
 * Renders an adaptive spacer as the LAST child of the conversation content so a
 * just-sent user message can pin to the top while its reply streams below it.
 *
 * The spacer reserves `viewport − (content below the pinned message)` of space,
 * which makes the scroll container's "bottom" coincide with the pinned message
 * sitting at the top. use-stick-to-bottom then holds that position for free, and
 * the spacer self-zeroes once the reply grows past a screen — at which point the
 * conversation resumes normal follow-the-bottom behavior. Scrolling up escapes
 * the lock exactly as before. No pin is active until `nonce` is bumped, so
 * loading a thread keeps the usual "latest answer at the bottom" behavior.
 */
export const ConversationPinSpacer = memo(
  ({ pinId, nonce, topGap = 16 }: ConversationPinSpacerProps) => {
    const { scrollRef, contentRef, scrollToBottom } = useStickToBottomContext()
    const spacerRef = useRef<HTMLDivElement | null>(null)
    const [height, setHeight] = useState(0)
    const heightRef = useRef(0)
    heightRef.current = height

    const recompute = useCallback(() => {
      const scroller = scrollRef.current
      const content = contentRef.current
      const spacer = spacerRef.current
      if (!scroller || !content || !spacer || !pinId || nonce === 0) {
        if (heightRef.current !== 0) setHeight(0)
        return
      }
      const el = content.querySelector(
        `[data-message-id="${pinId}"]`
      ) as HTMLElement | null
      if (!el) return

      const contentTop = content.getBoundingClientRect().top
      // The spacer is the last child, so its top marks the end of real content —
      // measuring it this way keeps the math independent of the spacer's own
      // height, avoiding any resize feedback loop.
      const realContentBottom = spacer.getBoundingClientRect().top - contentTop
      const pinnedTop = el.getBoundingClientRect().top - contentTop
      const belowPin = realContentBottom - pinnedTop
      const desired = Math.max(0, scroller.clientHeight - belowPin - topGap)
      if (Math.abs(desired - heightRef.current) > 1) setHeight(desired)
    }, [pinId, nonce, topGap, scrollRef, contentRef])

    // Keep the reserve correct as the reply streams in and on viewport resize.
    useEffect(() => {
      const content = contentRef.current
      if (!content) return
      const ro = new ResizeObserver(() => recompute())
      ro.observe(content)
      window.addEventListener('resize', recompute)
      return () => {
        ro.disconnect()
        window.removeEventListener('resize', recompute)
      }
    }, [recompute, contentRef])

    // On a new send: reserve the space, then let the library scroll to "bottom"
    // — which the spacer has made equal to the pinned message at the top.
    useLayoutEffect(() => {
      if (!pinId || nonce === 0) return
      recompute()
      const raf = requestAnimationFrame(() => {
        recompute()
        scrollToBottom()
      })
      return () => cancelAnimationFrame(raf)
      // Intentionally keyed on `nonce` only: pin once per send, not on every
      // content change (that would yank the scroll while the user reads).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nonce])

    return <div ref={spacerRef} aria-hidden="true" style={{ height }} />
  }
)

ConversationPinSpacer.displayName = 'ConversationPinSpacer'

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full',
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <IconArrowDown className="size-4" />
      </Button>
    )
  )
}
