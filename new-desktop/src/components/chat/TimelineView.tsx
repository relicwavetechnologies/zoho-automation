import { useState } from 'react';
import { Check, AlertTriangle, ChevronRight, Database, Globe, Mail, BookOpen, Workflow, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';
import { TerminalCard } from './TerminalCard';
import type { ChatMessage, TimelineItem } from '@/types/chat';

interface TimelineViewProps {
  message: ChatMessage;
  onTerminalDecision: (callId: string, decision: 'run' | 'decline', remember?: 'chat') => void;
  onTerminalStop: (callId: string) => void;
}

/**
 * Renders the assistant's single ordered timeline.
 *  - While streaming: everything is live and expanded, under a "Working…" line.
 *  - When done: the work (thoughts / tools / terminals + mid-run prose) folds
 *    into a clickable "Worked for Ns" toggle, and the final answer renders
 *    cleanly below it.
 */
export function TimelineView({ message, onTerminalDecision, onTerminalStop }: TimelineViewProps) {
  const items = message.timeline ?? [];
  const streaming = !!message.streaming;
  const [userOpen, setUserOpen] = useState(false);

  let lastTextIdx = -1;
  items.forEach((it, i) => {
    if (it.kind === 'text') lastTextIdx = i;
  });

  const renderItem = (it: TimelineItem, isLastText: boolean) => (
    <Item
      key={it.id}
      item={it}
      isLastText={isLastText}
      streaming={streaming}
      onTerminalDecision={onTerminalDecision}
      onTerminalStop={onTerminalStop}
    />
  );

  // ── Streaming: live, fully expanded ───────────────────────────────────────
  if (streaming) {
    const header = headerLabel(message, items, true);
    const hasWork = items.some((it) => it.kind !== 'text');
    return (
      <div className="flex flex-col">
        {header ? (
          <div className="mb-1 flex items-center gap-1.5 py-0.5 text-[13px]">
            <span className={cn('font-medium', header.shimmer ? 'shimmer-text' : 'text-fg-muted')}>
              {header.text}
            </span>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          {items.map((it, i) => renderItem(it, i === lastTextIdx))}
        </div>
        {!hasWork && lastTextIdx === -1 ? (
          <span className="inline-block h-3.5 w-[2px] animate-pulse bg-fg-muted" />
        ) : null}
      </div>
    );
  }

  // ── Done: collapse the work, keep the final answer visible ────────────────
  const answer = lastTextIdx >= 0 ? items[lastTextIdx] : null;
  const work = items.filter((_, i) => i !== lastTextIdx);
  const workSeconds = message.workMs ? (message.workMs / 1000).toFixed(1) : null;

  return (
    <div className="flex flex-col">
      {work.length > 0 ? (
        <div className="mb-1 flex flex-col">
          <button
            type="button"
            onClick={() => setUserOpen((v) => !v)}
            className="flex items-center gap-1.5 self-start py-0.5 text-[13px] text-fg-muted transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn('h-3 w-3 text-fg-dim transition-transform duration-150', userOpen && 'rotate-90')} />
            <span className="font-medium text-foreground">
              {workSeconds ? `Worked for ${workSeconds}s` : 'Worked'}
            </span>
          </button>
          <div
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
              userOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="overflow-hidden">
              <div className="flex flex-col gap-1 pt-1">
                {work.map((it) => renderItem(it, false))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {answer && answer.kind === 'text' ? <Markdown content={answer.text} /> : null}
    </div>
  );
}

function Item({
  item,
  isLastText,
  streaming,
  onTerminalDecision,
  onTerminalStop,
}: {
  item: TimelineItem;
  isLastText: boolean;
  streaming: boolean;
  onTerminalDecision: (callId: string, decision: 'run' | 'decline', remember?: 'chat') => void;
  onTerminalStop: (callId: string) => void;
}) {
  if (item.kind === 'text') {
    return <Markdown content={item.text} streaming={streaming && isLastText} />;
  }

  if (item.kind === 'thought') {
    return (
      <div className="flex items-baseline gap-1.5 py-[3px] text-[13px] leading-[1.55]">
        <span className={cn('font-medium', item.shimmer ? 'shimmer-text' : 'text-foreground')}>
          Thinking
        </span>
        <span className={cn('min-w-0 flex-1 text-fg-muted', item.shimmer && 'shimmer-text')}>
          {item.text}
        </span>
      </div>
    );
  }

  if (item.kind === 'tool') {
    const Icon = toolIcon(item.family);
    const isError = item.status === 'error';
    return (
      <div className="flex items-center gap-2 py-[3px] text-[13px] leading-[1.55]">
        <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-surface-2 text-fg-muted">
          {item.status === 'running' ? (
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-fg-faint border-t-fg-muted" />
          ) : isError ? (
            <AlertTriangle className="h-3 w-3 text-destructive" />
          ) : item.status === 'done' ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Icon className="h-3 w-3" />
          )}
        </span>
        <span className={cn('font-medium', isError ? 'text-destructive' : 'text-foreground', item.shimmer && 'shimmer-text')}>
          {item.verb}
        </span>
        {item.arg ? (
          <span className={cn('min-w-0 flex-1 truncate text-fg-muted', item.shimmer && 'shimmer-text')}>
            {item.arg}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {item.durationMs && !item.shimmer ? (
          <span className="shrink-0 text-[11.5px] tabular-nums text-fg-dim">{formatMs(item.durationMs)}</span>
        ) : null}
      </div>
    );
  }

  // terminal
  return (
    <TerminalCard block={item.block} onDecision={onTerminalDecision} onStop={onTerminalStop} />
  );
}

function headerLabel(
  message: ChatMessage,
  items: TimelineItem[],
  streaming: boolean,
): { text: string; shimmer: boolean } | null {
  const hasWork = items.some((it) => it.kind !== 'text');
  if (!streaming) {
    if (message.workMs && hasWork) return { text: `Worked for ${(message.workMs / 1000).toFixed(1)}s`, shimmer: false };
    return null;
  }
  // streaming — surface the current active verb
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === 'thought' && it.shimmer) return { text: 'Thinking', shimmer: true };
    if (it.kind === 'tool' && it.status === 'running') return { text: it.verb, shimmer: true };
    if (it.kind === 'terminal' && it.block.status === 'running') return { text: 'Running command', shimmer: true };
  }
  return { text: 'Working', shimmer: true };
}

function toolIcon(family: string) {
  switch (family) {
    case 'zoho': return Database;
    case 'lark': return Mail;
    case 'google': return Mail;
    case 'web':
    case 'web-search': return Globe;
    case 'context': return BookOpen;
    case 'orchestration': return Workflow;
    default: return Sparkles;
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
