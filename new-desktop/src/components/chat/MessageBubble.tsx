import { memo } from 'react';
import { ApprovalCard } from './ApprovalCard';
import { TimelineView } from './TimelineView';
import { Markdown } from './Markdown';
import { DivoMark } from '../DivoMark';
import { useChatStore } from '@/store/chat';
import type { ChatMessage } from '@/types/chat';

interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Memoized on the message object. The store preserves object identity for every
 * message except the one currently streaming, so during a live reply only the
 * active bubble re-renders — completed answers (with their tables/code) are not
 * re-parsed on each token. This is what keeps streaming cost flat regardless of
 * conversation length.
 */
export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const respondTerminal = useChatStore((s) => s.respondTerminal);
  const cancelTerminal = useChatStore((s) => s.cancelTerminal);

  if (message.role === 'user') {
    // Rendered by UserBubble inside TurnSection; no-op here so legacy callers
    // don't double-render the message.
    return null;
  }

  if (message.role === 'system') {
    return (
      <div className="mb-3 flex w-full justify-center">
        <div className="rounded-md border border-border-subtle bg-surface-1 px-3 py-1.5 text-[12px] text-fg-muted">
          {message.content}
        </div>
      </div>
    );
  }

  const hasTimeline = (message.timeline?.length ?? 0) > 0;

  return (
    <div className="mb-3.5 flex w-full flex-col gap-2">
      <div className="flex items-start gap-3">
        <DivoMark className="mt-0.5 h-[22px] w-[22px] shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 text-xs text-fg-muted">Divo</div>

          {hasTimeline ? (
            <TimelineView
              message={message}
              onTerminalDecision={(callId, decision, remember) =>
                respondTerminal(message.threadId, callId, decision, remember)
              }
              onTerminalStop={(callId) => cancelTerminal(callId)}
            />
          ) : message.content || message.streaming ? (
            // History messages (loaded from DB) carry only content — render it directly.
            <Markdown content={message.content} streaming={!!message.streaming} />
          ) : null}
        </div>
      </div>

      {message.approval ? <ApprovalCard approval={message.approval} /> : null}
    </div>
  );
});
