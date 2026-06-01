import { forwardRef } from 'react';
import { UserBubble } from './UserBubble';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage } from '@/types/chat';

export interface Turn {
  /** May be null only for the very first turn if the conversation opens with an assistant/system message. */
  user: ChatMessage | null;
  responses: ChatMessage[];
}

interface TurnSectionProps {
  turn: Turn;
  isLast: boolean;
  /** Pixels to subtract from the scroll-viewport when sizing the active turn (composer height + buffer). */
  viewportHeight: number;
}

/**
 * One conversational turn: a sticky user bubble at the top and the assistant's
 * activity stream + reply below. The last turn gets a min-height so that — after
 * `scrollIntoView` — the user bubble sits at the top of the viewport with a full
 * screen of room below for the work area to render without feeling cramped.
 */
export const TurnSection = forwardRef<HTMLElement, TurnSectionProps>(function TurnSection(
  { turn, isLast, viewportHeight },
  ref,
) {
  // Reserve room equal to the scroll viewport minus the height of the user bubble
  // itself (≈ 60px). Falls back to a sensible default if we couldn't measure.
  const minHeight = isLast && viewportHeight > 0 ? viewportHeight - 60 : undefined;

  return (
    <section
      ref={ref}
      className="relative mb-6"
      style={minHeight ? { minHeight } : undefined}
      data-turn-id={turn.user?.id ?? 'orphan'}
    >
      {turn.user ? (
        // Sticky wrapper escapes the scroll container's px-7 with -mx-7 and pads
        // the full edge-to-edge width with a solid bg so nothing scrolling
        // beneath it leaks through. Inside, the bubble is centered at 720px.
        <div className="sticky top-0 z-30 -mx-7 bg-background px-7 pb-3 pt-4">
          <div className="mx-auto w-full max-w-[720px]">
            <UserBubble message={turn.user} />
          </div>
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-[720px] pt-1">
        {turn.responses.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
    </section>
  );
});
