import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StatusRibbon } from './StatusRibbon';
import { TurnSection, type Turn } from './TurnSection';
import { useChatStore } from '@/store/chat';
import type { ChatMessage, Thread } from '@/types/chat';

interface MessageListProps {
  thread: Thread;
}

export function MessageList({ thread }: MessageListProps) {
  const isStreaming = useChatStore((s) => s.isStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);

  const turns = useMemo(() => groupTurns(thread.messages), [thread.messages]);

  // Measure the scroll-viewport so the last turn can claim full screen room.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // When a new user message arrives (= the count of user-led turns grew), scroll
  // the newest turn to the top of the viewport so its user bubble pins there and
  // the work area has a full viewport below it.
  const userTurnCountRef = useRef(0);
  useEffect(() => {
    const next = turns.filter((t) => t.user).length;
    const prev = userTurnCountRef.current;
    userTurnCountRef.current = next;
    if (next > prev && lastTurnRef.current) {
      // Defer to the next paint so the new turn's min-height is applied first.
      requestAnimationFrame(() => {
        lastTurnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [turns]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-background px-7"
        style={{ scrollBehavior: 'smooth' }}
      >
        {turns.length > 0 ? (
          <div className="mx-auto mb-3 flex w-full max-w-[720px] items-center justify-center gap-2 pt-3 text-[11.5px] text-fg-muted">
            <span className="h-[3px] w-[3px] rounded-full bg-fg-faint" />
            <span>
              Today ·{' '}
              {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
            <span className="h-[3px] w-[3px] rounded-full bg-fg-faint" />
          </div>
        ) : null}

        {turns.map((turn, i) => {
          const isLast = i === turns.length - 1;
          return (
            <TurnSection
              key={turn.user?.id ?? `orphan-${i}`}
              ref={isLast ? lastTurnRef : undefined}
              turn={turn}
              isLast={isLast}
              viewportHeight={viewportHeight}
            />
          );
        })}
      </div>

      {isStreaming ? <StatusRibbon /> : null}
    </div>
  );
}

function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (current) turns.push(current);
      current = { user: m, responses: [] };
    } else if (current) {
      current.responses.push(m);
    } else {
      // Assistant/system message with no preceding user (greetings, system warnings).
      current = { user: null, responses: [m] };
    }
  }
  if (current) turns.push(current);
  return turns;
}
