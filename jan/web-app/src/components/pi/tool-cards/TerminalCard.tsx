import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { resolveToolIdentity } from '@/lib/pi/tool-label'
import { extractCommand, parseTerminalOutput } from '@/lib/pi/tool-cards/terminal'

type ToolPart = {
  type?: string
  toolName?: string
  state?: unknown
  input?: unknown
  output?: unknown
  error?: unknown
  errorText?: unknown
}

type RunState = 'running' | 'done' | 'error'

function runState(state: unknown): RunState {
  if (state === 'output-error' || state === 'output-denied') return 'error'
  if (state === 'output-available') return 'done'
  return 'running'
}

/**
 * A shell command run, rendered like a real terminal.
 *
 * Always dark — a terminal reads as a terminal in either app theme — with
 * window traffic-lights, an `❯` prompt over the (possibly multi-line) command,
 * and its stdout/stderr below. While running it shows a live caret; when it
 * settles it shows an exit-code badge, red on a non-zero exit. Output is
 * scroll-capped so a chatty command can't run the thread off the page.
 */
export const TerminalCard = memo(({ part }: { part: ToolPart }) => {
  const identity = useMemo(() => resolveToolIdentity(part), [part])
  const command = useMemo(
    () => extractCommand(part.input, identity.detail),
    [part.input, identity.detail]
  )
  const out = useMemo(() => parseTerminalOutput(part.output), [part.output])

  const rawState = runState(part.state)
  const state: RunState = rawState === 'done' && out.failed ? 'error' : rawState
  const running = state === 'running'

  const errorText =
    (typeof part.errorText === 'string' && part.errorText) ||
    (typeof part.error === 'string' && part.error) ||
    undefined

  return (
    <section
      className="my-1 max-w-[80ch] overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-[12.5px] leading-relaxed text-zinc-100 shadow-sm"
      data-testid="terminal-card"
      data-state={state}
    >
      {/* Window chrome. */}
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/60 px-3 py-1.5">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-red-500/90" />
          <span className="size-2.5 rounded-full bg-amber-400/90" />
          <span className="size-2.5 rounded-full bg-emerald-500/90" />
        </span>
        <span className="ml-1 text-[11px] font-medium text-zinc-500">bash</span>
        <span className="ml-auto">
          {running ? (
            <span className="text-[11px] text-zinc-500">
              <span className="text-shimmer">running</span>
            </span>
          ) : (
            <ExitBadge state={state} exitCode={out.exitCode} />
          )}
        </span>
      </div>

      {/* Command + output. */}
      <div className="max-h-80 overflow-auto px-3 py-2.5">
        <div className="flex gap-2">
          <span aria-hidden className="shrink-0 select-none text-emerald-400">
            ❯
          </span>
          <pre className="min-w-0 whitespace-pre-wrap break-words text-zinc-100">
            {command || <span className="text-zinc-600">(command pending…)</span>}
            {running && <span className="ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] animate-pulse bg-zinc-300 align-middle" />}
          </pre>
        </div>

        {out.stdout && (
          <pre className="mt-2 whitespace-pre-wrap break-words text-zinc-300">
            {out.stdout}
          </pre>
        )}
        {out.stderr && (
          <pre className="mt-2 whitespace-pre-wrap break-words text-red-300/90">
            {out.stderr}
          </pre>
        )}
        {state === 'error' && !out.stderr && !out.stdout && (
          <pre className="mt-2 whitespace-pre-wrap break-words text-red-300/90">
            {errorText || 'Command failed.'}
          </pre>
        )}
      </div>
    </section>
  )
})

TerminalCard.displayName = 'TerminalCard'

function ExitBadge({ state, exitCode }: { state: RunState; exitCode?: number }) {
  const failed = state === 'error'
  const label =
    exitCode !== undefined ? `exit ${exitCode}` : failed ? 'failed' : 'done'
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums',
        failed
          ? 'bg-red-500/15 text-red-300'
          : 'bg-emerald-500/15 text-emerald-300'
      )}
    >
      {label}
    </span>
  )
}
