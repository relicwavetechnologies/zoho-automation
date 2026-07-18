import { useMemo, useState, type ComponentType, type FormEvent } from 'react'
import {
  ArrowUp,
  AudioLines,
  BrainCircuit,
  Check,
  CheckCircle2,
  FileVideo2,
  GitCompareArrows,
  Image,
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
import type { TeachSession } from '@/lib/divo-teach'

type StepTone = 'upload' | 'media' | 'language' | 'reasoning' | 'write'
type Step = {
  key: TeachSession['processingStep']
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
  tone: StepTone
}

const steps: Step[] = [
  {
    key: 'recording_received',
    icon: UploadCloud,
    title: 'Recording received',
    detail: 'The completed recording is stored in this Teach session.',
    tone: 'upload',
  },
  {
    key: 'selecting_evidence',
    icon: FileVideo2,
    title: 'Selecting useful evidence',
    detail: 'Peepshow is removing repeated screens and retaining meaningful changes.',
    tone: 'media',
  },
  {
    key: 'transcribing',
    icon: AudioLines,
    title: 'Transcribing your explanation',
    detail: 'OpenAI is turning the narration into timestamped working instructions.',
    tone: 'language',
  },
  {
    key: 'reading_screens',
    icon: ScanText,
    title: 'Reading the screens',
    detail: 'Qwen is identifying visible interface text and important actions.',
    tone: 'language',
  },
  {
    key: 'reconstructing_workflow',
    icon: GitCompareArrows,
    title: 'Reconstructing the workflow',
    detail: 'Divo is aligning what happened on screen with what you explained.',
    tone: 'media',
  },
  {
    key: 'loading_persona',
    icon: UserRound,
    title: 'Loading the current persona',
    detail: 'The existing manager persona and its current revision are being added to the evidence.',
    tone: 'reasoning',
  },
  {
    key: 'deepseek_reviewing',
    icon: BrainCircuit,
    title: 'DeepSeek is reviewing the teaching',
    detail: 'DeepSeek is comparing the demonstration with the current persona and proposing a precise change.',
    tone: 'reasoning',
  },
  {
    key: 'validating_change',
    icon: ShieldCheck,
    title: 'Validating the persona change',
    detail: 'Divo is checking evidence references, confidence, manager scope and safety constraints.',
    tone: 'reasoning',
  },
  {
    key: 'writing_persona',
    icon: UserRound,
    title: 'Writing the persona revision',
    detail: 'The accepted change and its Undo snapshot are being saved atomically.',
    tone: 'write',
  },
]

const toneClasses: Record<StepTone, string> = {
  upload: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  media: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  language: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  reasoning: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  write: 'border-orange-500/20 bg-orange-500/10 text-orange-600 dark:text-orange-300',
}

export function TeachProcessingExperience({
  session,
  statusWarning,
  onCancel,
}: {
  session: TeachSession
  statusWarning?: string
  onCancel?: () => void
}) {
  const activeIndex = Math.max(0, steps.findIndex(step => step.key === session.processingStep))
  const activeStep = steps[activeIndex] ?? steps[0]!
  const ActiveIcon = activeStep.icon

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="teach-processing-experience">
      <TeachHeader
        eyebrow={session.parentSessionId ? 'Teach refinement' : 'Teach processing'}
        title="Learning from your demonstration"
        trailing={<Badge variant="outline">Live job</Badge>}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <main className="min-w-0">
            <section className="rounded-xl border bg-card">
              <div className="border-b p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 gap-3.5">
                    <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg border', toneClasses[activeStep.tone])}>
                      <ActiveIcon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Happening now</p>
                      <h1 className="mt-1 font-studio text-xl font-medium">{activeStep.title}</h1>
                      <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{activeStep.detail}</p>
                    </div>
                  </div>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{session.progress}%</span>
                </div>
                <Progress value={session.progress} className="mt-5 h-1.5" />
                {statusWarning && <p className="mt-3 text-xs text-amber-600" role="status">{statusWarning}</p>}
              </div>

              <div className="divide-y px-4 sm:px-5">
                {steps.map((step, index) => (
                  <ProcessingStep
                    key={step.key}
                    step={step}
                    status={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending'}
                  />
                ))}
              </div>
            </section>
          </main>

          <aside className="space-y-4">
            <EvidenceReceipt session={session} live />
            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="size-4 text-violet-500" />
                Current context
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {session.managerCorrection
                  ? `Refining the prior result with: “${session.managerCorrection}”`
                  : 'The workflow understanding will appear after DeepSeek has reviewed the complete evidence.'}
              </p>
            </section>
            <div className="flex gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600" />
              Divo reports success only after the persona revision is committed.
            </div>
          </aside>
        </div>
      </div>

      {onCancel && (
        <div className="flex shrink-0 justify-end border-t px-5 py-3 sm:px-7">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel teaching</Button>
        </div>
      )}
    </div>
  )
}

export function TeachResultExperience({
  session,
  undoing,
  undoMessage,
  onUndo,
  onRefine,
  onFinish,
}: {
  session: TeachSession
  undoing: boolean
  undoMessage?: string
  onUndo: () => void
  onRefine: (correction: string) => Promise<void>
  onFinish: () => void
}) {
  const [correction, setCorrection] = useState('')
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState<string>()
  const learned = session.status === 'persona_updated'
  const contextLabel = useMemo(() => [
    session.personaRevision ? `Persona v${session.personaRevision}` : 'No persona revision',
    session.evidence ? `${session.evidence.frameCount} frames` : null,
    session.evidence ? `${session.evidence.transcriptSegmentCount} transcript segments` : null,
  ].filter(Boolean).join(' · '), [session])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = correction.trim()
    if (!value || refining) return
    try {
      setRefining(true)
      setRefineError(undefined)
      await onRefine(value)
      setCorrection('')
    } catch (error) {
      setRefineError(String(error).replace(/^Error:\s*/, ''))
      setRefining(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="teach-result-experience">
      <TeachHeader
        eyebrow={session.parentSessionId ? 'Refined Teach result' : 'Teach result'}
        title="Review what Divo learned"
        trailing={(
          <Badge variant="outline" className={learned ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600' : undefined}>
            {learned ? <><CheckCircle2 /> Persona v{session.personaRevision}</> : 'No persona change'}
          </Badge>
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
                <div className="min-w-0">
                  <h1 className="font-studio text-2xl font-medium">{learned ? `${session.appliedChangeCount} persona ${session.appliedChangeCount === 1 ? 'rule' : 'rules'} updated` : 'Teaching reviewed'}</h1>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{session.understanding}</p>
                  {session.managerCorrection && (
                    <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5">Manager correction: {session.managerCorrection}</p>
                  )}
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b px-5 py-4">
                <h2 className="text-sm font-medium">Persona changes</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">The exact validated rules written by this Teach job</p>
              </div>
              {session.appliedChanges.length > 0 ? (
                <div className="divide-y">
                  {session.appliedChanges.map((change, index) => (
                    <div key={`${change.operation}-${change.kind}-${change.ruleKey}-${index}`} className="p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{change.operation}</Badge>
                          <Badge variant="secondary">{change.kind}</Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">{change.ruleKey}</span>
                        </div>
                        <span className="font-mono text-[10px] text-muted-foreground">{Math.round(change.confidence * 100)}% confidence</span>
                      </div>
                      <div className="mt-3 flex gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                        <span className="font-mono text-sm text-emerald-600">{change.operation === 'retire' ? '−' : '+'}</span>
                        <p className="text-sm leading-6">{change.instruction ?? `Retired ${change.scopeKey} / ${change.ruleKey}`}</p>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {change.evidenceRefs.map(ref => <Badge key={ref} variant="outline" className="font-normal text-muted-foreground">{ref}</Badge>)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-sm text-muted-foreground">No high-confidence persona rule was written.</div>
              )}
            </section>

            <section className="rounded-xl border bg-card">
              <div className="border-b px-5 py-4">
                <div className="flex items-center gap-2">
                  <MessageSquareText className="size-4 text-violet-500" />
                  <h2 className="text-sm font-medium">Correct or add to this teaching</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Your correction is processed with this recording evidence, the current result and the latest persona revision.</p>
              </div>
              <form className="p-3" onSubmit={submit}>
                <div className="flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:border-ring">
                  <Textarea
                    value={correction}
                    onChange={event => setCorrection(event.target.value)}
                    className="min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                    placeholder="Tell Divo what was too broad, missing or incorrect."
                    aria-label="Refine what Divo learned"
                    rows={2}
                    maxLength={2_000}
                    disabled={refining}
                  />
                  <Button type="submit" size="icon-sm" disabled={!correction.trim() || refining} aria-label="Send correction">
                    {refining ? <BrainCircuit className="animate-pulse" /> : <ArrowUp />}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
                  <span>{contextLabel}</span>
                  <span>{correction.length}/2,000</span>
                </div>
                {refining && <p className="mt-3 text-xs text-violet-600" role="status">Creating a linked refinement job…</p>}
                {refineError && <p className="mt-3 text-xs text-red-600" role="alert">Correction failed: {refineError}</p>}
              </form>
            </section>
          </main>

          <aside className="space-y-4">
            <EvidenceReceipt session={session} />
            <section className="rounded-xl border bg-card p-4">
              <h2 className="text-sm font-medium">Teaching receipt</h2>
              <div className="mt-3 divide-y">
                <ReceiptRow label="Model" value={session.modelId ?? 'Not reported'} />
                <ReceiptRow label="Accepted rules" value={String(session.appliedChangeCount)} />
                <ReceiptRow label="Persona revision" value={session.personaRevision ? `v${session.personaRevision}` : 'Unchanged'} />
              </div>
            </section>
            {session.remainingUndos > 0 && (
              <section className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-emerald-600" /> Control</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">Undo restores only the latest saved persona snapshot.</p>
                <Button variant="outline" className="mt-4 w-full" disabled={undoing} onClick={onUndo}>
                  <Undo2 /> {undoing ? 'Undoing…' : `Undo (${session.remainingUndos} left)`}
                </Button>
                {undoMessage && <p className="mt-3 text-xs text-muted-foreground" role="status">{undoMessage}</p>}
              </section>
            )}
          </aside>
        </div>
      </div>

      <div className="flex shrink-0 justify-end border-t px-5 py-3 sm:px-7">
        <Button size="sm" onClick={onFinish}>Finish <Check /></Button>
      </div>
    </div>
  )
}

function ProcessingStep({ step, status }: { step: Step; status: 'complete' | 'active' | 'pending' }) {
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
        <p className="text-sm font-medium">{step.title}</p>
        {status === 'active' && <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>}
      </div>
      {status === 'complete' && <span className="font-mono text-[10px] text-muted-foreground">done</span>}
      {status === 'active' && <span className="font-mono text-[10px] text-muted-foreground">working…</span>}
    </div>
  )
}

function EvidenceReceipt({ session, live = false }: { session: TeachSession; live?: boolean }) {
  const evidence = session.evidence
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Evidence {live ? 'available' : 'receipt'}</h2>
        {live && <Badge variant="outline">Live</Badge>}
      </div>
      <div className="mt-3 divide-y">
        <Fact icon={FileVideo2} label="Recording" value={formatDuration(evidence?.durationSeconds)} />
        <Fact icon={Image} label="Selected frames" value={evidence ? String(evidence.frameCount) : 'Preparing'} />
        <Fact icon={AudioLines} label="Transcript" value={evidence ? `${evidence.transcriptSegmentCount} segments` : 'Preparing'} />
        <Fact icon={ScanText} label="OCR" value={evidence?.ocrModels.join(', ') || 'Preparing'} />
      </div>
    </section>
  )
}

function TeachHeader({ eyebrow, title, trailing }: { eyebrow: string; title: string; trailing: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
        <p className="truncate text-sm font-medium">{title}</p>
      </div>
      {trailing}
    </div>
  )
}

function Fact({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 py-3 first:pt-0 last:pb-0">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>
      <span className="max-w-36 truncate text-right text-xs font-medium">{value}</span>
    </div>
  )
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-xs first:pt-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-40 truncate text-right font-medium">{value}</span>
    </div>
  )
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Preparing'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}
