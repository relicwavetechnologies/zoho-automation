import { ArrowLeft, CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TeachRecordingFile } from '@/lib/divo-teach'

export type TeachErrorKind =
  | 'manager'
  | 'recorder'
  | 'upload'
  | 'processing'
  | 'generic'

const formatBytes = (bytes: number | null) => {
  if (!bytes) return 'Unknown size'
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

export const describeProcessingFailure = (
  lastError: string | null | undefined
) => {
  if (lastError?.includes('Failed to process successful response')) {
    return "The recording was processed, but Divo could not validate the Teach model's response. No persona or skill changes were saved."
  }
  if (
    lastError?.includes('Transaction not found') ||
    lastError?.includes("Can't reach database server")
  ) {
    return 'The recording was processed, but Divo lost its database connection while saving the learning. No persona or skill changes were saved.'
  }
  return 'The recording was processed, but Divo could not save the learning. No persona or skill changes were saved.'
}

/**
 * Failures used to collapse into one card with a single "Try again" that threw
 * the user back to the start. The kinds are genuinely different — a missing
 * macOS permission, a dropped upload with the file still on disk, and a
 * successful read that failed to persist all need different next steps — so
 * each states what survived and offers the action that actually recovers it.
 */
export function TeachErrorPanel({
  kind,
  lastError,
  recording,
  onRetry,
  onBack,
}: {
  kind: TeachErrorKind
  lastError?: string | null
  recording?: TeachRecordingFile
  /** Present when the failure is genuinely retryable from where it stopped. */
  onRetry?: () => void
  onBack: () => void
}) {
  const copy = {
    manager: {
      title: 'Manager access required',
      body: 'Teach currently learns only from the manager of the selected department. Choose a department you manage, then start again.',
      retryLabel: undefined,
    },
    recorder: {
      title: 'Screen recorder could not start',
      body: 'Allow Screen & System Audio Recording and Microphone access for Divo in Mac System Settings, then try again. This is a one-time approval.',
      retryLabel: 'Try again',
    },
    upload: {
      title: 'Upload failed',
      body: 'Your recording was completed and saved locally, but Divo could not upload it. Your persona was not changed.',
      retryLabel: 'Retry upload',
    },
    processing: {
      title: 'Persona update failed',
      body: describeProcessingFailure(lastError),
      retryLabel: undefined,
    },
    generic: {
      title: 'Teaching did not complete',
      body: 'Divo could not complete this teaching workflow. Your persona was not changed.',
      retryLabel: undefined,
    },
  }[kind]

  const destructive = kind === 'recorder' || kind === 'manager'

  return (
    <div
      className="h-full overflow-y-auto px-5 py-8 sm:px-8"
      data-testid="teach-mode"
    >
      <div className="mx-auto max-w-2xl">
        <div
          className={cn(
            'rounded-2xl border p-5 sm:p-6',
            destructive
              ? 'border-destructive/30 bg-destructive/[0.06]'
              : 'border-amber-500/30 bg-amber-500/[0.06]'
          )}
        >
          <div className="flex gap-3">
            <ShieldAlert
              className={cn(
                'mt-0.5 size-5 shrink-0',
                destructive ? 'text-destructive' : 'text-amber-600'
              )}
            />
            <div className="min-w-0">
              <h1 className="font-studio text-lg font-medium">{copy.title}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {copy.body}
              </p>
            </div>
          </div>

          {/* What survived. After a failure the first question is always
              "did I just lose the recording I made?" — answer it before
              offering an action. */}
          {kind === 'upload' && recording ? (
            <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-4 shrink-0" />
              <span className="min-w-0">
                Your recording is safe on this Mac —{' '}
                <span className="font-medium">{recording.fileName}</span>,{' '}
                {formatBytes(recording.size)}
              </span>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            {onRetry && copy.retryLabel ? (
              <Button onClick={onRetry}>
                <RotateCcw /> {copy.retryLabel}
              </Button>
            ) : null}
            <Button
              variant={onRetry && copy.retryLabel ? 'outline' : 'default'}
              onClick={onBack}
            >
              <ArrowLeft /> Back to Teach
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
