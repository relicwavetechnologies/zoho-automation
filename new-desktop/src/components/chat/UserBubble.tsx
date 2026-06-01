import { memo } from 'react';
import { CornerUpLeft } from 'lucide-react';
import type { ChatMessage } from '@/types/chat';

interface UserBubbleProps {
  message: ChatMessage;
  /** Optional click handler on the reply icon — usually wires to "quote in composer". */
  onReply?: () => void;
}

/**
 * Full-width user message. Spans the same 720px column as Divo's reply so it can
 * sit cleanly as a sticky-pinned bar at the top of each turn (Cursor-style).
 * Memoized: user messages never mutate, so they shouldn't re-render while the
 * assistant streams.
 */
export const UserBubble = memo(function UserBubble({ message, onReply }: UserBubbleProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border-strong bg-surface-3 px-4 py-3 text-[14px] leading-relaxed text-foreground shadow-[0_1px_0_hsl(0_0%_0%/0.3)]">
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message.content}</div>
      {onReply ? (
        <button
          type="button"
          onClick={onReply}
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center text-fg-dim transition-colors hover:text-foreground"
          aria-label="Quote this message"
          title="Quote this message"
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
});
