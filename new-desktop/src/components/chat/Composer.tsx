import { useRef, useState, useEffect } from 'react';
import { Plus, ChevronDown, Mic, ArrowUp, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { useChatStore } from '@/store/chat';
import { useAuthStore } from '@/store/auth';
import { useActiveWorkspace } from '@/store/workspace';

interface ComposerProps {
  /**
   * `inline` — no surrounding padding/centering, used inside EmptyState.
   * `dock`   — bottom-docked padding, used under the message list.
   */
  variant?: 'inline' | 'dock';
}

export function Composer({ variant = 'dock' }: ComposerProps) {
  const { session } = useAuthStore();
  const workspace = useActiveWorkspace();
  const { send, cancel, newThread, activeThreadId, isStreaming } = useChatStore();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 240)}px`;
    }
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || !session?.token) return;
    let threadId = activeThreadId;
    // First send in a draft → create the thread under the currently active workspace.
    if (!threadId) {
      const created = await newThread(session.token, workspace ?? null);
      if (!created) return;
      threadId = created.id;
    }
    const sent = send(session.token, value, {
      threadId,
      workspace: workspace ? { name: workspace.name, path: workspace.path } : null,
    });
    if (sent) setText('');
  };

  const card = (
    <div
      className={cn(
        'rounded-2xl border bg-surface-2 px-3 pb-2 pt-3 transition-all',
        'focus-within:border-border-strong',
        'border-border',
      )}
    >
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Plan, Build, / for commands, @ for context"
        rows={1}
        className="min-h-[44px] max-h-[240px] px-1"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          title="Attach"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-fg-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <button className="inline-flex items-center gap-1 px-1 text-[12.5px] text-fg-muted transition-colors hover:text-foreground">
          <span>Divo</span>
          <ChevronDown className="h-3 w-3" />
        </button>

        <div className="flex-1" />

        <button
          title="Voice"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-fg-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <Mic className="h-3.5 w-3.5" />
        </button>

        {isStreaming ? (
          <button
            onClick={() => cancel()}
            title="Stop"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-foreground transition-all hover:scale-105 hover:bg-surface-hover"
          >
            <Pause className="h-3.5 w-3.5" />
          </button>
        ) : text.trim() ? (
          <button
            onClick={() => void submit()}
            title="Send"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background transition-all hover:scale-105"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );

  if (variant === 'inline') {
    return card;
  }

  // `dock` — bottom docked, centred max-width
  return (
    <div className="shrink-0 px-7 pb-4 pt-1">
      <div className="mx-auto w-full max-w-[720px]">{card}</div>
    </div>
  );
}
