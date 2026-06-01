import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal, ChevronRight, Globe, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TerminalBlock } from '@/types/chat';

interface TerminalCardProps {
  block: TerminalBlock;
  onDecision: (callId: string, decision: 'run' | 'decline', remember?: 'chat') => void;
  onStop: (callId: string) => void;
}

export function TerminalCard({ block, onDecision, onStop }: TerminalCardProps) {
  if (block.status === 'awaiting') {
    return <RunGate block={block} onDecision={onDecision} />;
  }
  if (block.status === 'declined') {
    return (
      <div className="my-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
        <span>⊘</span>
        <span className="text-fg-muted">
          Declined — <span className="font-mono text-[11.5px]">{truncate(block.command, 60)}</span> was not run.
        </span>
      </div>
    );
  }
  return <LiveTerminal block={block} onStop={onStop} />;
}

function RunGate({
  block,
  onDecision,
}: {
  block: TerminalBlock;
  onDecision: (callId: string, decision: 'run' | 'decline', remember?: 'chat') => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="my-2 rounded-md border border-border-strong bg-surface-2 p-3.5">
      <div className="mb-2.5 flex items-center gap-2 text-[12.5px] text-fg-muted">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface-3">
          <Terminal className="h-3.5 w-3.5 text-fg-muted" />
        </span>
        <span>
          Divo wants to run a command in <b className="text-foreground">{tail(block.cwd)}</b>
        </span>
        {block.net ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10.5px] font-medium text-destructive">
            <Globe className="h-3 w-3" /> internet access
          </span>
        ) : null}
      </div>
      <pre className="mb-3 overflow-x-auto rounded-md border border-border-subtle bg-[hsl(0_0%_3%)] px-3 py-2.5 font-mono text-[12.5px] text-foreground">
        <span className="text-planned select-none" style={{ color: 'hsl(218 80% 66%)' }}>$ </span>
        {block.command}
      </pre>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onDecision(block.callId, 'run', remember ? 'chat' : undefined)}
          className="rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          Run
        </button>
        <button
          onClick={() => onDecision(block.callId, 'decline')}
          className="rounded-md border border-border bg-surface-3 px-4 py-1.5 text-[12.5px] font-semibold text-foreground transition hover:bg-surface-hover"
        >
          Decline
        </button>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11.5px] text-fg-dim hover:text-fg-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3 w-3 accent-foreground"
          />
          Don&apos;t ask again this chat
        </label>
      </div>
    </div>
  );
}

function LiveTerminal({ block, onStop }: { block: TerminalBlock; onStop: (callId: string) => void }) {
  const running = block.status === 'running';
  const [open, setOpen] = useState(running);
  const bodyRef = useRef<HTMLPreElement>(null);

  // Expanded while running; auto-collapse to the summary row once done.
  // The header stays clickable so the user can re-open it to inspect output.
  useEffect(() => {
    setOpen(running);
  }, [running]);

  useLayoutEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [block.output, open]);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-[hsl(0_0%_3%)]">
      <div
        role={running ? undefined : 'button'}
        onClick={() => !running && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 border-b border-border-subtle bg-surface-1 px-3 py-2 text-[12px] text-fg-muted',
          !running && 'cursor-pointer hover:bg-surface-2',
        )}
      >
        {!running ? (
          <ChevronRight className={cn('h-3 w-3 text-fg-dim transition-transform', open && 'rotate-90')} />
        ) : (
          <Terminal className="h-3.5 w-3.5 text-fg-muted" />
        )}
        <span className="truncate font-mono text-[11.5px] text-foreground">{truncate(block.command, 56)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {running ? (
            <>
              <span className="flex items-center gap-1.5 text-fg-muted">
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-fg-faint border-t-fg-muted" />
                running
              </span>
              <button
                type="button"
                onClick={() => onStop(block.callId)}
                title="Terminate"
                className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            </>
          ) : (
            <span className="tabular-nums text-fg-dim">
              exit{' '}
              <span style={{ color: block.exitCode === 0 ? 'hsl(142 60% 55%)' : 'hsl(0 75% 65%)' }}>
                {block.exitCode}
              </span>
              {block.durationMs != null ? ` · ${(block.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
          )}
        </span>
      </div>
      {open ? (
        <pre
          ref={bodyRef}
          className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-[hsl(0_0%_78%)]"
        >
          {block.output || (running ? '' : '(no output)')}
          {running ? <span className="ml-0.5 inline-block h-3 w-[7px] animate-pulse bg-[hsl(218_80%_66%)] align-middle" /> : null}
        </pre>
      ) : null}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function tail(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
