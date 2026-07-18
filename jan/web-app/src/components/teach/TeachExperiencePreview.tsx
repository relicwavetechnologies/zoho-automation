import { useEffect, useMemo, useState, type ComponentType, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  AudioLines,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  FileVideo2,
  GitCompareArrows,
  Image,
  Mail,
  MessageSquareText,
  ScanText,
  ShieldCheck,
  Sparkles,
  Undo2,
  UploadCloud,
  UserRound,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type PreviewStage = 'processing' | 'result'
type PreviewStepTone = 'upload' | 'media' | 'language' | 'reasoning' | 'write'

type PreviewStep = {
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
  result: string
  tone: PreviewStepTone
}

const previewSteps: PreviewStep[] = [
  {
    icon: UploadCloud,
    title: 'Recording received',
    detail: 'Streaming the completed Mac recording into this Teach session.',
    result: '78 MB verified',
    tone: 'upload',
  },
  {
    icon: FileVideo2,
    title: 'Selecting useful evidence',
    detail: 'Peepshow is removing repeated screens and keeping meaningful changes.',
    result: '8 frames · 1 audio track',
    tone: 'media',
  },
  {
    icon: AudioLines,
    title: 'Transcribing your explanation',
    detail: 'OpenAI is turning the narration into timestamped working instructions.',
    result: '1 narration segment',
    tone: 'language',
  },
  {
    icon: ScanText,
    title: 'Reading the screens',
    detail: 'Qwen is identifying visible apps, interface text and important actions.',
    result: 'Gmail · Lark · 8 screens',
    tone: 'language',
  },
  {
    icon: GitCompareArrows,
    title: 'Reconstructing the workflow',
    detail: 'Divo is aligning what happened on screen with what you explained.',
    result: '4 workflow steps',
    tone: 'media',
  },
  {
    icon: BrainCircuit,
    title: 'DeepSeek is reviewing the teaching',
    detail: 'Comparing this workflow with the existing manager persona and its current revision.',
    result: '1 candidate rule',
    tone: 'reasoning',
  },
  {
    icon: ShieldCheck,
    title: 'Validating the persona change',
    detail: 'Checking confidence, evidence references, manager scope and safety constraints.',
    result: '1 accepted · 0 rejected',
    tone: 'reasoning',
  },
  {
    icon: UserRound,
    title: 'Writing persona revision 1',
    detail: 'Saving the accepted workflow rule with an Undo snapshot.',
    result: 'Revision saved',
    tone: 'write',
  },
]

const baseRule = 'Use the dedicated Cursor inbox to find the latest unprocessed Cursor emails, then forward each one with its full context to Anish on Lark. Do not process unrelated emails in that inbox.'

const toneClasses: Record<PreviewStepTone, string> = {
  upload: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  media: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  language: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  reasoning: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  write: 'border-orange-500/20 bg-orange-500/10 text-orange-600 dark:text-orange-300',
}

export function TeachExperiencePreview({ onExit }: { onExit: () => void }) {
  const [stage, setStage] = useState<PreviewStage>('processing')

  if (stage === 'processing') {
    return <TeachProcessingPreview onExit={onExit} onShowResult={() => setStage('result')} />
  }

  return <TeachResultPreview onExit={onExit} onReplay={() => setStage('processing')} />
}

function TeachProcessingPreview({
  onExit,
  onShowResult,
}: {
  onExit: () => void
  onShowResult: () => void
}) {
  const [currentStep, setCurrentStep] = useState(0)
  const progress = Math.round(((currentStep + 1) / previewSteps.length) * 100)

  useEffect(() => {
    if (currentStep >= previewSteps.length - 1) return
    const timer = window.setTimeout(() => setCurrentStep((value) => value + 1), 1_350)
    return () => window.clearTimeout(timer)
  }, [currentStep])

  const activeStep = previewSteps[currentStep]!
  const ActiveStepIcon = activeStep.icon

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="teach-experience-preview">
      <PreviewHeader
        eyebrow="Teach processing"
        title="Learning from your demonstration"
        onBack={onExit}
        trailing={<Badge variant="secondary">UI preview · no model calls</Badge>}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <main className="min-w-0">
            <section className="rounded-xl border bg-card">
              <div className="border-b p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 gap-3.5">
                    <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg border', toneClasses[activeStep.tone])}>
                      <ActiveStepIcon className="size-4.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Happening now</p>
                      <h1 className="mt-1 font-studio text-xl font-medium">{activeStep.title}</h1>
                      <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{activeStep.detail}</p>
                    </div>
                  </div>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{progress}%</span>
                </div>
                <Progress value={progress} className="mt-5 h-1.5" />
              </div>

              <div className="divide-y px-4 sm:px-5">
                {previewSteps.map((step, index) => (
                  <ProcessingStep
                    key={step.title}
                    step={step}
                    status={index < currentStep ? 'complete' : index === currentStep ? 'active' : 'pending'}
                  />
                ))}
              </div>
            </section>
          </main>

          <aside className="space-y-4">
            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">Evidence available</h2>
                <Badge variant="outline">Live</Badge>
              </div>
              <div className="mt-3 divide-y">
                <PreviewFact icon={FileVideo2} label="Recording" value="03:14 · 78 MB" />
                <PreviewFact icon={Image} label="Selected frames" value="8 useful screens" />
                <PreviewFact icon={AudioLines} label="Narration" value="1 transcript" />
                <PreviewFact icon={Mail} label="Apps understood" value="Gmail + Lark" />
              </div>
            </section>

            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="size-4 text-violet-500" />
                Current understanding
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                The dedicated inbox is used only to find recent Cursor emails and forward them with context to Anish on Lark.
              </p>
              <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">
                This can change while later evidence is reviewed.
              </p>
            </section>

            <div className="flex gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600" />
              No persona change is presented as successful until the final write is confirmed.
            </div>
          </aside>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 sm:px-7">
        <p className="hidden text-xs text-muted-foreground sm:block">Mock timing and evidence for UX review only.</p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCurrentStep(0)}>Replay steps</Button>
          <Button size="sm" onClick={onShowResult}>View learned result <ChevronRight /></Button>
        </div>
      </div>
    </div>
  )
}

function ProcessingStep({
  step,
  status,
}: {
  step: PreviewStep
  status: 'complete' | 'active' | 'pending'
}) {
  const Icon = step.icon
  return (
    <div className={cn('flex gap-3 py-3.5 transition-opacity', status === 'pending' && 'opacity-45')}>
      <span className={cn(
        'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground',
        status === 'complete' && 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600',
        status === 'active' && toneClasses[step.tone],
      )}>
        {status === 'complete' ? <Check className="size-3.5" /> : <Icon className={cn('size-3.5', status === 'active' && 'animate-pulse')} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cn('text-sm font-medium', status === 'active' && 'text-foreground')}>{step.title}</p>
          {status !== 'pending' && (
            <span className="font-mono text-[10px] text-muted-foreground">{status === 'active' ? 'working…' : step.result}</span>
          )}
        </div>
        {status === 'active' && <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>}
      </div>
    </div>
  )
}

function TeachResultPreview({
  onExit,
  onReplay,
}: {
  onExit: () => void
  onReplay: () => void
}) {
  const [correction, setCorrection] = useState('')
  const [pendingCorrection, setPendingCorrection] = useState<string>()
  const [history, setHistory] = useState<string[]>([baseRule])
  const [lastCorrection, setLastCorrection] = useState<string>()
  const [statusMessage, setStatusMessage] = useState<string>()

  useEffect(() => {
    if (!pendingCorrection) return
    const value = pendingCorrection
    const timer = window.setTimeout(() => {
      setHistory((current) => [...current.slice(-1), `${current.at(-1) ?? baseRule}\n\nAdditional manager guidance: ${value}`])
      setLastCorrection(value)
      setPendingCorrection(undefined)
      setStatusMessage('DeepSeek updated the mock persona rule and created a new revision.')
    }, 1_250)
    return () => window.clearTimeout(timer)
  }, [pendingCorrection])

  const revision = history.length
  const currentRule = history.at(-1)
  const remainingUndos = Math.min(history.length, 2)
  const learned = Boolean(currentRule)
  const contextLabel = useMemo(() => `${revision > 0 ? `Persona v${revision}` : 'No saved revision'} · 8 frames · 1 transcript`, [revision])

  const submitCorrection = (event: FormEvent) => {
    event.preventDefault()
    const value = correction.trim()
    if (!value || pendingCorrection) return
    setCorrection('')
    setStatusMessage(undefined)
    setPendingCorrection(value)
  }

  const undo = () => {
    setHistory((current) => current.slice(0, -1))
    setLastCorrection(undefined)
    setStatusMessage(revision <= 1
      ? 'Mock persona change undone. The workflow rule is no longer active.'
      : 'Latest refinement undone. Persona returned to the previous revision.')
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="teach-result-preview">
      <PreviewHeader
        eyebrow="Teach result"
        title="Review what Divo learned"
        onBack={onExit}
        trailing={(
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Preview data</Badge>
            <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/5 text-emerald-600">
              <CheckCircle2 /> {learned ? `Persona v${revision}` : 'Undone'}
            </Badge>
          </div>
        )}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <main className="min-w-0 space-y-4">
            <section className="rounded-xl border bg-card p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600">
                  <CheckCircle2 className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="font-studio text-2xl font-medium">{learned ? 'One workflow rule learned' : 'Persona change undone'}</h1>
                    {learned && <Badge variant="secondary">100% confidence</Badge>}
                  </div>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                    {learned
                      ? 'You taught Divo how the dedicated Cursor inbox should be handled and where the resulting emails should go.'
                      : 'The preview has returned to the persona state before this teaching session.'}
                  </p>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                <div>
                  <h2 className="text-sm font-medium">Persona change</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Exactly what was written—not only a summary</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">workflow</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">cursor-email-processing</span>
                </div>
              </div>
              {currentRule ? (
                <div className="p-5">
                  <div className="flex gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <span className="font-mono text-sm text-emerald-600">+</span>
                    <p className="whitespace-pre-line text-sm leading-6">{currentRule}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <EvidenceBadge label="Narration 00:12–00:43" />
                    <EvidenceBadge label="Frames 3–6" />
                    <EvidenceBadge label="Gmail + Lark" />
                  </div>
                </div>
              ) : (
                <div className="p-6 text-sm text-muted-foreground">No active rule from this Teach preview.</div>
              )}
            </section>

            <section className="rounded-xl border bg-card">
              <div className="border-b px-5 py-4">
                <div className="flex items-center gap-2">
                  <MessageSquareText className="size-4 text-violet-500" />
                  <h2 className="text-sm font-medium">Continue teaching in the same context</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Divo keeps this recording evidence, the previous result and the current persona together for your correction.</p>
              </div>

              <div className="space-y-3 px-5 py-4">
                <div className="flex gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-500"><Sparkles className="size-3.5" /></span>
                  <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5">
                    I added one workflow rule. Tell me what is too broad, missing or incorrect and I’ll revise only this learning.
                  </div>
                </div>
                {lastCorrection && (
                  <div className="flex justify-end gap-3">
                    <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs leading-5 text-primary-foreground">{lastCorrection}</div>
                  </div>
                )}
                {pendingCorrection && (
                  <div className="flex gap-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-500"><BrainCircuit className="size-3.5 animate-pulse" /></span>
                    <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5">DeepSeek is revisiting the rule with your correction…</div>
                  </div>
                )}
                {statusMessage && <p className="text-xs text-emerald-600" role="status">{statusMessage}</p>}
              </div>

              <form className="border-t p-3" onSubmit={submitCorrection}>
                <div className="flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:border-ring">
                  <Textarea
                    value={correction}
                    onChange={(event) => setCorrection(event.target.value)}
                    className="min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                    placeholder="Example: Forward only unread Cursor emails, and include my own summary before the original message."
                    aria-label="Refine what Divo learned"
                    rows={2}
                  />
                  <Button type="submit" size="icon-sm" disabled={!correction.trim() || Boolean(pendingCorrection)} aria-label="Send correction">
                    <ArrowUp />
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
                  <span>{contextLabel}</span>
                  <span>Mock interaction · nothing is written</span>
                </div>
              </form>
            </section>
          </main>

          <aside className="space-y-4">
            <section className="rounded-xl border bg-card p-4">
              <h2 className="text-sm font-medium">Teaching receipt</h2>
              <div className="mt-3 divide-y">
                <ReceiptRow label="Recording" value="03:14" />
                <ReceiptRow label="Evidence" value="8 frames" />
                <ReceiptRow label="Model" value="DeepSeek V4 Pro" />
                <ReceiptRow label="Accepted rules" value={learned ? '1' : '0'} />
                <ReceiptRow label="Persona revision" value={revision > 0 ? `v${revision}` : 'None'} />
              </div>
            </section>

            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-emerald-600" />
                Control
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">Every mock update creates a visible revision. Undo removes only the latest persona change.</p>
              <Button variant="outline" className="mt-4 w-full" disabled={remainingUndos < 1 || Boolean(pendingCorrection)} onClick={undo}>
                <Undo2 /> Undo ({remainingUndos} left)
              </Button>
            </section>

            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 text-xs leading-5 text-muted-foreground">
              <BrainCircuit className="mb-2 size-4 text-violet-500" />
              The production version will reconstruct this context for every correction instead of relying on hidden model reasoning.
            </div>
          </aside>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 sm:px-7">
        <Button variant="ghost" size="sm" onClick={onReplay}><ArrowLeft /> Replay processing</Button>
        <Button size="sm" onClick={onExit}>Finish preview <Check /></Button>
      </div>
    </div>
  )
}

function PreviewHeader({
  eyebrow,
  title,
  onBack,
  trailing,
}: {
  eyebrow: string
  title: string
  onBack: () => void
  trailing: ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
      <div className="flex min-w-0 items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Exit Teach UX preview"><ArrowLeft /></Button>
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
          <p className="truncate text-sm font-medium">{title}</p>
        </div>
      </div>
      {trailing}
    </div>
  )
}

function PreviewFact({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 py-3 first:pt-0 last:pb-0">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs font-medium">{value}</span>
    </div>
  )
}

function EvidenceBadge({ label }: { label: string }) {
  return <Badge variant="outline" className="font-normal text-muted-foreground">{label}</Badge>
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-xs first:pt-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}
