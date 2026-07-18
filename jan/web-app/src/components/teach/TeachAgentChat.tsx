import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, BrainCircuit, Check, CircleStop, Database, RotateCcw, Sparkles, Wrench } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useChat } from '@/hooks/use-chat'
import type { TeachSession } from '@/lib/divo-teach'
import { cn } from '@/lib/utils'

const BOOTSTRAP_MESSAGE = 'The teaching evidence is ready. Start the Teach analysis now. Show me concise progress, ask only material clarification questions, and write the confirmed persona or reusable skill when ready.'

export function TeachAgentChat({
  session,
  undoing,
  undoMessage,
  onUndo,
  onFinish,
}: {
  session: TeachSession
  undoing: boolean
  undoMessage?: string
  onUndo: () => void
  onFinish: () => void
}) {
  const [input, setInput] = useState('')
  const bootstrapped = useRef(false)
  const chatSessionId = `teach-${session.id}`
  const profile = useMemo(() => ({
    kind: 'teach' as const,
    teachSessionId: session.id,
    departmentId: session.departmentId,
  }), [session.departmentId, session.id])
  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
  } = useChat({
    sessionId: chatSessionId,
    sessionTitle: 'Divo Teach',
    piProfile: profile,
    experimental_throttle: 50,
  })
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    if (bootstrapped.current || messages.length > 0 || busy) return
    bootstrapped.current = true
    void sendMessage({ text: BOOTSTRAP_MESSAGE }).catch(() => {
      bootstrapped.current = false
    })
  }, [busy, messages.length, sendMessage])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    void sendMessage({ text })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="teach-agent-chat">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-violet-500">Interactive Teach</p>
          <p className="text-sm font-medium">Divo is understanding your workflow</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">DeepSeek Pro · Max thinking</Badge>
          {session.status === 'completed' && (
            <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600" variant="outline">
              <Check /> Saved
            </Badge>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <main className="min-w-0 space-y-4">
            {messages.length === 0 && (
              <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
                Starting the Teach agent with your compiled recording evidence…
              </div>
            )}
            {messages.map((message, messageIndex) => {
              const isBootstrap = message.role === 'user'
                && message.parts.some(part => part.type === 'text' && part.text === BOOTSTRAP_MESSAGE)
              if (isBootstrap) return null
              return (
                <article
                  key={message.id}
                  className={cn(
                    'rounded-xl border p-4 sm:p-5',
                    message.role === 'user' ? 'ml-8 bg-muted/45' : 'bg-card'
                  )}
                >
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    {message.role === 'assistant' ? <Sparkles className="size-3.5 text-violet-500" /> : null}
                    {message.role === 'assistant' ? 'Divo' : 'You'}
                  </div>
                  <div className="space-y-3">
                    {message.parts.map((part, partIndex) => (
                      <TeachMessagePart
                        key={`${message.id}-${partIndex}`}
                        part={part as unknown as Record<string, unknown>}
                        active={busy && messageIndex === messages.length - 1}
                      />
                    ))}
                  </div>
                </article>
              )
            })}
            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600" role="alert">
                Teach agent failed: {error.message}. Your recording remains available and nothing is reported as saved unless the write succeeds.
              </div>
            )}
          </main>

          <aside className="space-y-4">
            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database className="size-4 text-violet-500" /> Evidence ready
              </div>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <p>{session.evidence?.frameCount ?? 0} selected screens</p>
                <p>{session.evidence?.transcriptSegmentCount ?? 0} transcript segments</p>
                <p>{session.evidence?.ocrModels.join(', ') || 'OCR evidence prepared'}</p>
              </div>
            </section>

            <section className="rounded-xl border bg-card p-4">
              <h2 className="text-sm font-medium">Write receipt</h2>
              {session.status === 'completed' ? (
                <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <p>{session.appliedChangeCount} persona {session.appliedChangeCount === 1 ? 'rule' : 'rules'} written</p>
                  <p>{session.personaRevision ? `Persona v${session.personaRevision}` : 'Persona unchanged'}</p>
                  {session.understanding && <p className="border-l-2 border-emerald-500/30 pl-3 leading-5">{session.understanding}</p>}
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Nothing is marked learned until the backend confirms the persona write.
                </p>
              )}
              {session.remainingUndos > 0 && (
                <Button className="mt-4 w-full" size="sm" variant="outline" disabled={undoing} onClick={onUndo}>
                  <RotateCcw /> {undoing ? 'Undoing…' : `Undo (${session.remainingUndos} left)`}
                </Button>
              )}
              {undoMessage && <p className="mt-2 text-xs text-muted-foreground">{undoMessage}</p>}
            </section>
          </aside>
        </div>
      </div>

      <div className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
        <form className="mx-auto flex max-w-4xl items-end gap-2 rounded-xl border bg-card p-2" onSubmit={submit}>
          <Textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="Correct Divo, answer a clarification, or add an important detail…"
            className="min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            rows={2}
            disabled={busy}
          />
          {busy ? (
            <Button type="button" size="icon-sm" variant="outline" onClick={() => void stop()} aria-label="Stop Teach agent">
              <CircleStop />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" disabled={!input.trim()} aria-label="Send to Teach agent">
              <ArrowUp />
            </Button>
          )}
        </form>
        <div className="mx-auto mt-2 flex max-w-4xl justify-between text-[10px] text-muted-foreground">
          <span>Same Teach context stays active for corrections.</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={onFinish}>Finish</Button>
        </div>
      </div>
    </div>
  )
}

function TeachMessagePart({ part, active }: { part: Record<string, unknown>; active: boolean }) {
  const type = typeof part.type === 'string' ? part.type : ''
  if (type === 'text' && typeof part.text === 'string') {
    return <p className="whitespace-pre-wrap text-sm leading-6">{part.text}</p>
  }
  if (type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
    return (
      <div className="flex gap-2 rounded-lg border border-violet-500/15 bg-violet-500/5 p-3 text-xs leading-5 text-muted-foreground">
        <BrainCircuit className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
        <span className="whitespace-pre-wrap">{part.text}</span>
      </div>
    )
  }
  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    const input = part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : undefined
    const op = typeof input?.op === 'string' ? input.op : type.replace(/^tool-/, '').replaceAll('_', ' ')
    const state = typeof part.state === 'string' ? part.state : ''
    const failed = state === 'output-error' || state === 'output-denied'
    const running = active && state !== 'output-available' && !failed
    return (
      <div className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
        failed ? 'border-red-500/20 bg-red-500/5 text-red-600' : 'bg-muted/35 text-muted-foreground'
      )}>
        <Wrench className={cn('size-3.5', running && 'animate-pulse')} />
        <span>{failed ? 'Failed' : running ? 'Working' : 'Completed'}: {friendlyOperation(op)}</span>
      </div>
    )
  }
  return null
}

function friendlyOperation(op: string): string {
  const labels: Record<string, string> = {
    'teach.context.get': 'loaded recording evidence and current persona',
    'teach.persona.apply': 'validated and saved persona changes',
    'skills.search': 'checked reusable skills',
    'skills.get': 'reviewed an existing skill',
    'tools.list': 'mapped available tools',
    'capabilities.get': 'checked available capabilities',
    'connections.list': 'checked connected work apps',
    'tools.invoke': 'prepared or used a governed capability',
  }
  return labels[op] ?? op.replaceAll('.', ' ')
}
