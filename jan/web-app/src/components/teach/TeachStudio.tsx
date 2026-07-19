import {
  AlertTriangle,
  CheckCircle2,
  FileVideo2,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  Video,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PersonaGraph } from './PersonaGraph'
import { TeachSteps } from './TeachHowItWorks'
import type {
  ManagerPersonaTree,
  TeachLocalRecording,
  TeachSession,
} from '@/lib/divo-teach'

const formatBytes = (bytes: number | null) => {
  if (!bytes) return 'Unknown size'
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

const formatLearningDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))

/** Human wording for the state a local recording is stuck in. */
const describeState = (recording: TeachLocalRecording) => {
  switch (recording.state) {
    case 'agent_ready':
      return 'waiting for you in a conversation'
    case 'retryable':
      return 'upload failed'
    case 'processing':
      return 'processing'
    case 'uploading':
      return 'uploading'
    default:
      return 'ready to upload'
  }
}

export type TeachStudioProps = {
  checkingAccess: boolean
  departmentId?: string
  loadingOverview: boolean
  overviewWarning?: string
  localRecordings: TeachLocalRecording[]
  recentLearnings: TeachSession[]
  personaTree: ManagerPersonaTree | null
  undoing: boolean
  onRecord: () => void
  onUpload: () => void
  onHowItWorks: () => void
  onRetryRecording: (recording: TeachLocalRecording) => void
  onResumeRecording: (recording: TeachLocalRecording) => void
  onDeleteRecording: (recording: TeachLocalRecording) => void
  onUndoLastLearning: (learning: TeachSession) => void
}

export function TeachStudio({
  checkingAccess,
  departmentId,
  loadingOverview,
  overviewWarning,
  localRecordings,
  recentLearnings,
  personaTree,
  undoing,
  onRecord,
  onUpload,
  onHowItWorks,
  onRetryRecording,
  onResumeRecording,
  onDeleteRecording,
  onUndoLastLearning,
}: TeachStudioProps) {
  const blocked = checkingAccess || !departmentId
  const hasHistory = recentLearnings.length > 0 || Boolean(personaTree?.nodes.length)

  // Undo pops the department persona stack — it is not addressable per row.
  // So only the newest learning that actually wrote something may offer it;
  // anything older would silently revert a different session's changes.
  const undoableId = recentLearnings.find(
    (learning) => learning.appliedChangeCount > 0
  )
  const canUndo =
    undoableId && undoableId.remainingUndos > 0 ? undoableId.id : undefined

  // Deliberately NOT gated on `loadingOverview`. Both this and the studio
  // branch start empty, so keying the choice on the loading flag made the whole
  // page unmount and remount on every refresh — a visible flicker, and it tore
  // the launcher buttons out from under an in-flight click.
  if (!hasHistory && localRecordings.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center overflow-y-auto px-5 py-10"
        data-testid="teach-mode"
      >
        <div className="w-full max-w-lg text-center">
          <div className="mx-auto grid size-13 place-items-center rounded-2xl bg-violet-500/10 text-violet-500">
            <Video className="size-6" />
          </div>
          <h1 className="mt-5 font-studio text-2xl font-medium tracking-tight">
            Teach Divo how you work
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground">
            Record your screen while you do a task and explain your decisions
            out loud. Divo turns the demonstration into department rules and
            reusable skills.
          </p>

          <TeachSteps className="mx-auto mt-6 max-w-sm text-left" />

          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button
              variant="outline"
              onClick={onUpload}
              disabled={blocked}
              data-testid="upload-teach-recording"
            >
              <Upload /> Upload recording
            </Button>
            <Button
              onClick={onRecord}
              disabled={blocked}
              data-testid="start-teach-recording"
            >
              <Video /> Record teaching
            </Button>
          </div>
          {!checkingAccess && !departmentId && (
            <p className="mt-4 text-sm text-amber-600">
              Select a department you manage before starting Teach.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="h-full overflow-y-auto px-5 py-6 sm:px-8"
      data-testid="teach-mode"
    >
      <div className="mx-auto max-w-5xl pb-10">
        {/* Unprocessed recordings are work already done that has not landed,
            so they outrank the launcher. When there are none this collapses
            to a single reassuring line rather than an empty 50% column. */}
        {localRecordings.length > 0 ? (
          <section className="mb-4 overflow-hidden rounded-xl border border-amber-500/35 bg-amber-500/[0.07]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-amber-600" />
              <span className="font-medium">
                {localRecordings.length}{' '}
                {localRecordings.length === 1 ? 'recording is' : 'recordings are'}{' '}
                still on this Mac
              </span>
              <span className="text-muted-foreground">
                They finished recording but have not been processed. Nothing is
                lost.
              </span>
            </div>
            {localRecordings.slice(0, 4).map((recording) => {
              const canResume = recording.state === 'agent_ready'
              const canRetry =
                recording.state === 'ready' || recording.state === 'retryable'
              return (
                <div
                  key={recording.path}
                  className="flex flex-wrap items-center gap-3 border-t border-amber-500/20 px-4 py-3"
                >
                  <FileVideo2 className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {recording.fileName}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {formatBytes(recording.size)} · {describeState(recording)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={canResume || canRetry ? 'default' : 'outline'}
                      size="sm"
                      disabled={!canRetry && !canResume}
                      onClick={() =>
                        canResume
                          ? onResumeRecording(recording)
                          : onRetryRecording(recording)
                      }
                    >
                      <RotateCcw />{' '}
                      {canResume
                        ? 'Resume teaching'
                        : canRetry
                          ? 'Retry'
                          : 'Processing'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete ${recording.fileName}`}
                      onClick={() => onDeleteRecording(recording)}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </div>
                </div>
              )
            })}
          </section>
        ) : null}

        {/* The launcher: one row, not a hero. A returning manager has read the
            explainer already; it lives behind "How it works". */}
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border bg-gradient-to-b from-violet-500/[0.06] to-transparent p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-500">
            <Video className="size-5" />
          </span>
          <div className="min-w-40 flex-1">
            <h1 className="text-sm font-medium">Teach a workflow</h1>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Record your screen while you work and explain your decisions.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onHowItWorks}>
            How it works
          </Button>
          <Button
            variant="outline"
            onClick={onUpload}
            disabled={blocked}
            data-testid="upload-teach-recording"
          >
            <Upload /> Upload recording
          </Button>
          <Button
            onClick={onRecord}
            disabled={blocked}
            data-testid="start-teach-recording"
          >
            <Video /> Record teaching
          </Button>
        </section>

        {!checkingAccess && !departmentId && (
          <p className="mt-3 text-sm text-amber-600">
            Select a department you manage before starting Teach.
          </p>
        )}

        {localRecordings.length === 0 && !loadingOverview ? (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5" />
            No recordings waiting to process. Everything you have taught has
            been saved.
          </p>
        ) : null}

        {/* The persona is the accumulated result of every session — it was
            previously the last thing on the page, below both cards. */}
        <PersonaGraph tree={personaTree} loading={loadingOverview} />

        <section className="mt-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">Recent Teach learnings</h2>
            <p className="text-xs text-muted-foreground">
              Every session and exactly what it changed
            </p>
          </div>

          {recentLearnings.length === 0 ? (
            <p className="rounded-xl border bg-card px-5 py-6 text-sm text-muted-foreground">
              {loadingOverview
                ? 'Loading recent learnings…'
                : 'No completed Teach learnings yet.'}
            </p>
          ) : (
            <ol className="relative space-y-2.5 pl-6">
              <span
                aria-hidden
                className="absolute bottom-2 left-1.5 top-2 w-px bg-border"
              />
              {recentLearnings.slice(0, 6).map((learning) => {
                const changed = learning.appliedChangeCount > 0
                return (
                  <li key={learning.id} className="relative">
                    <span
                      aria-hidden
                      className={
                        changed
                          ? 'absolute -left-[18px] top-4 size-2.5 rounded-full border-2 border-violet-500 bg-card'
                          : 'absolute -left-[18px] top-4 size-2.5 rounded-full border-2 border-muted-foreground/40 bg-card'
                      }
                    />
                    <div className="rounded-xl border bg-card px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {changed ? (
                          <>
                            <Badge variant="secondary">
                              {learning.appliedChanges.length}{' '}
                              {learning.appliedChanges.length === 1
                                ? 'rule'
                                : 'rules'}
                            </Badge>
                            {learning.appliedSkills.length > 0 && (
                              <Badge variant="outline">
                                {learning.appliedSkills.length}{' '}
                                {learning.appliedSkills.length === 1
                                  ? 'skill'
                                  : 'skills'}
                              </Badge>
                            )}
                          </>
                        ) : (
                          <Badge variant="outline">no changes</Badge>
                        )}
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                          {formatLearningDate(learning.updatedAt)}
                        </span>
                      </div>

                      {learning.understanding && (
                        <p className="mt-2 line-clamp-2 text-sm leading-5">
                          {learning.understanding}
                        </p>
                      )}
                      {learning.appliedChanges[0]?.instruction && (
                        <p className="mt-2 line-clamp-2 border-l-2 border-emerald-500/30 pl-3 text-xs leading-5 text-muted-foreground">
                          {learning.appliedChanges[0].instruction}
                        </p>
                      )}
                      {learning.appliedSkills[0] && (
                        <p className="mt-2 text-xs text-violet-500">
                          {learning.appliedSkills[0].outcome === 'created'
                            ? 'Created'
                            : 'Updated'}{' '}
                          skill: {learning.appliedSkills[0].name} v
                          {learning.appliedSkills[0].revision}
                        </p>
                      )}

                      {changed && (
                        <div className="mt-3 flex items-center gap-2 border-t pt-2.5">
                          {canUndo === learning.id ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-auto text-destructive hover:text-destructive"
                              disabled={undoing}
                              onClick={() => onUndoLastLearning(learning)}
                            >
                              <Undo2 />
                              {undoing ? 'Undoing…' : 'Undo this learning'}
                            </Button>
                          ) : (
                            <span className="ml-auto text-xs text-muted-foreground">
                              {learning.remainingUndos > 0
                                ? 'Only the most recent learning can be undone'
                                : 'No undos remaining'}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        {overviewWarning && (
          <p className="mt-3 text-xs text-amber-600" role="status">
            {overviewWarning}
          </p>
        )}
      </div>
    </div>
  )
}
