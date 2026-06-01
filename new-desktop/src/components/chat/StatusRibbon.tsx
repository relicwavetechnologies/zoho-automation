import { useEffect, useState } from 'react';
import { Pause } from 'lucide-react';
import { useChatStore } from '@/store/chat';

export function StatusRibbon() {
  const { cancel } = useChatStore();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 100) / 10), 100);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="shrink-0 px-7 pb-2">
      <div className="mx-auto flex w-full max-w-[720px] items-center gap-2 rounded-full border border-border-subtle bg-surface-1 px-3 py-1.5 text-xs text-fg-muted">
        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-fg-faint border-t-accent" />
        <span className="shimmer-text">Synthesizing reply…</span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className="text-fg-dim">{elapsed.toFixed(1)}s</span>
          <button
            onClick={cancel}
            className="inline-flex h-[22px] items-center gap-1.5 rounded px-2 text-xs text-fg-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Pause className="h-3 w-3" />
            Stop
          </button>
        </span>
      </div>
    </div>
  );
}
