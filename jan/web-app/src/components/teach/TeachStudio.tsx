import {
  CheckCircle2,
  CloudOff,
  FileVideo2,
  MessageSquareText,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  Upload,
  Video,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PersonaGraph } from './PersonaGraph'
import { TeachSteps } from './TeachHowItWorks'
import { cn } from '@/lib/utils'
import { formatTeachBytes, type TeachWorkItem } from '@/lib/teach-activity'
import type { ManagerPersonaTree, TeachSession } from '@/lib/divo-teach'

const formatLearningDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))

/** Why Teach cannot be started, when it cannot be started. */
export type TeachAccessProblem = 'not-manager' | 'unreachable'

export type TeachStudioProps = {
  checkingAccess: boolean
  accessProblem?: TeachAccessProblem
  departmentId?: string
  online: boolean
  loadingOverview: boolean
  overviewWarning?: string
  workItems: TeachWorkItem[]
  recentLearnings: TeachSession[]
  personaTree: ManagerPersonaTree | null
  undoing: boolean
  onRecord: () => void
  onUpload: () => void
  onHowItWorks: () => void
  onSendRecording: (item: TeachWorkItem) => void
  onOpenRecording: (item: TeachWorkItem) => void
  onResumeRecording: (item: TeachWorkItem) => void
  onDeleteRecording: (item: TeachWorkItem) => void
  onUndoLastLearning: (learning: TeachSession) => void
}

/** One line describing what a finished session actually did. */
function summarizeLearning(learning: TeachSession) {
  if (learning.appliedChangeCount === 0) {
    return 'Divo did not find anything new to learn from this one.'
  }
  const rules = learning.appliedChanges.length
  const skills = learning.appliedSkills.length
  const parts = [`Learned ${rules} ${rules === 1 ? 'thing' : 'things'}`]
  if (skills > 0) {
    parts.push(`and can now run ${skills} ${skills === 1 ? 'task' : 'tasks'} for you`)
  }
  return `${parts.join(' ')}.`
}

export function TeachStudio({
  checkingAccess,
  accessProblem,
  departmentId,
  online,
  loadingOverview,
  overviewWarning,
  workItems,
  recentLearnings,
  personaTree,
  undoing,
  onRecord,
  onUpload,
  onHowItWorks,
  onSendRecording,
  onOpenRecording,
  onResumeRecording,
  onDeleteRecording,
  onUndoLastLearning,
}: TeachStudioProps) {
  const blocked = checkingAccess || !departmentId
  const hasHistory =
    recentLearnings.length > 0 || Boolean(personaTree?.nodes.length)

  // Undo pops the department persona stack — it is not addressable per row.
  // So only the newest learning that actually wrote something may offer it;
  // anything older would silently revert a different session's changes.
  const newestApplied = recentLearnings.find(
    (learning) => learning.appliedChangeCount > 0
  )
  const canUndo =
    newestApplied && newestApplied.remainingUndos > 0
      ? newestApplied.id
      : undefined

  const accessNotice = checkingAccess
    ? null
    : accessProblem === 'unreachable'
      ? 'Divo cannot be reached right now, so teaching cannot start. Your existing recordings are safe.'
      : accessProblem === 'not-manager'
        ? 'Teach learns from the manager of a department. Pick a department you manage to start.'
        : null

  // Deliberately NOT gated on `loadingOverview`. Both this and the studio
  // branch start empty, so keying the choice on the loading flag made the whole
  // page unmount and remount on every refresh — a visible flicker, and it tore
  // the launcher buttons out from under an in-flight click.
  if (!hasHistory && workItems.length === 0) {
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
            Show Divo how you work
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground">
            Record yourself doing a task once, talking through your decisions.
            Divo watches it and learns to do that work your way.
          </p>

          <TeachSteps className="mx-auto mt-6 max-w-sm text-left" />

          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button
              variant="outline"
              onClick={onUpload}
              disabled={blocked}
              data-testid="upload-teach-recording"
            >
              <Upload /> Use a video I already have
            </Button>
            <Button
              onClick={onRecord}
              disabled={blocked}
              data-testid="start-teach-recording"
            >
              <Video /> Start recording
            </Button>
          </div>
          {accessNotice && (
            <p className="mt-4 text-sm text-amber-600">{accessNotice}</p>
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
      <div className="mx-auto max-w-3xl pb-10">
        {/* Work already done that has not landed outranks the launcher —
            answering "where did my recording go?" before offering a new one. */}
        {workItems.length > 0 ? (
          <section
            className="mb-4 overflow-hidden rounded-xl border bg-card"
            data-testid="teach-work-items"
          >
            <p className="border-b px-4 py-3 text-sm font-medium">
              Your recordings
            </p>
            {workItems.map((item) => (
              <TeachWorkRow
                key={item.path}
                item={item}
                onSend={() => onSendRecording(item)}
                onOpen={() => onOpenRecording(item)}
                onResume={() => onResumeRecording(item)}
                onDelete={() => onDeleteRecording(item)}
              />
            ))}
          </section>
        ) : null}

        <section className="flex flex-wrap items-center gap-3 rounded-2xl border bg-gradient-to-b from-violet-500/[0.06] to-transparent p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-500">
            <Video className="size-5" />
          </span>
          <div className="min-w-40 flex-1">
            <h1 className="text-sm font-medium">Teach Divo something new</h1>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Record a task and talk through your decisions.
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
            <Upload /> Use a video
          </Button>
          <Button
            onClick={onRecord}
            disabled={blocked}
            data-testid="start-teach-recording"
          >
            <Video /> Start recording
          </Button>
        </section>

        {accessNotice && (
          <p className="mt-3 text-sm text-amber-600">{accessNotice}</p>
        )}

        {!online && !accessNotice && (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <CloudOff className="size-3.5 shrink-0" />
            Divo cannot be reached right now. Anything you record is kept safely
            on this Mac and sent automatically when the connection is back.
          </p>
        )}

        {workItems.length === 0 && !loadingOverview && online ? (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5" />
            Nothing waiting. Everything you have taught Divo has been saved.
          </p>
        ) : null}

        <PersonaGraph tree={personaTree} loading={loadingOverview} />

        <section className="mt-6">
          <div className="mb-3">
            <h2 className="text-sm font-medium">Your teaching sessions</h2>
            <p className="text-xs text-muted-foreground">
              What each recording changed
            </p>
          </div>

          {recentLearnings.length === 0 ? (
            <p className="rounded-xl border bg-card px-5 py-6 text-sm text-muted-foreground">
              {loadingOverview
                ? 'Loading your recent sessions…'
                : 'No finished teaching sessions yet.'}
            </p>
          ) : (
            <ol className="space-y-2.5">
              {recentLearnings.slice(0, 6).map((learning) => {
                const changed = learning.appliedChangeCount > 0
                return (
                  <li key={learning.id}>
                    <div className="rounded-xl border bg-card px-4 py-3.5">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <p
                          className={cn(
                            'text-sm font-medium',
                            !changed && 'text-muted-foreground'
                          )}
                        >
                          {summarizeLearning(learning)}
                        </p>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {formatLearningDate(learning.updatedAt)}
                        </span>
                      </div>

                      {learning.understanding && (
                        <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                          {learning.understanding}
                        </p>
                      )}
                      {learning.appliedChanges[0]?.instruction && (
                        <p className="mt-2 border-l-2 border-emerald-500/40 pl-3 text-sm leading-6">
                          {learning.appliedChanges[0].instruction}
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
                              {undoing ? 'Undoing…' : 'Undo this session'}
                            </Button>
                          ) : (
                            <span className="ml-auto text-xs text-muted-foreground">
                              {learning.remainingUndos > 0
                                ? 'Only the most recent session can be undone'
                                : 'This can no longer be undone'}
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

/**
 * One recording, with the single action that moves it forward.
 *
 * Every row previously offered "Retry" whether or not retrying was the right
 * move, and a row mid-upload offered a Delete that would have pulled the file
 * out from under the stream. Each state now gets exactly the button that
 * applies to it, and states with nothing to do say so instead.
 */
function TeachWorkRow({
  item,
  onSend,
  onOpen,
  onResume,
  onDelete,
}: {
  item: TeachWorkItem
  onSend: () => void
  onOpen: () => void
  onResume: () => void
  onDelete: () => void
}) {
  const busy =
    !item.canResume && (item.phase === 'sending' || item.phase === 'thinking')

  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3.5 first:border-t-0">
      <span
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-lg',
          item.phase === 'needs_you'
            ? 'bg-emerald-500/10 text-emerald-600'
            : busy
              ? 'bg-violet-500/10 text-violet-500'
              : 'bg-amber-500/10 text-amber-600'
        )}
      >
        {item.phase === 'needs_you' ? (
          <MessageSquareText className="size-4" />
        ) : (
          <FileVideo2 className={cn('size-4', busy && 'animate-pulse')} />
        )}
      </span>

      <div className="min-w-45 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          {item.headline}
          {item.percent !== null && (
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {item.percent}%
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {item.detail}
        </p>
        {item.problem && (
          <p className="mt-1 text-xs text-amber-600">{item.problem}</p>
        )}
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {item.fileName} · {formatTeachBytes(item.size)}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {item.canOpen && (
          <Button size="sm" onClick={onOpen}>
            <MessageSquareText /> Open the chat
          </Button>
        )}
        {item.canSend && (
          <Button size="sm" onClick={onSend}>
            <Send /> Send to Divo
          </Button>
        )}
        {item.canResume && (
          <Button size="sm" onClick={onResume} data-testid="resume-teach-recording">
            <RotateCcw /> Start it again
          </Button>
        )}
        {item.canDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${item.fileName}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        )}
        {busy && (
          <Badge variant="outline" className="font-normal">
            Working
          </Badge>
        )}
      </div>
    </div>
  )
}
