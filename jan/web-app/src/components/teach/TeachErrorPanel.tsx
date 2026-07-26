import { ArrowLeft, CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatTeachBytes } from '@/lib/teach-activity'
import type { TeachRecordingFile } from '@/lib/divo-teach'

export type TeachErrorKind =
  | 'manager'
  | 'recorder'
  | 'upload'
  | 'processing'
  | 'generic'

export const describeProcessingFailure = (
  lastError: string | null | undefined
) => {
  if (lastError?.includes('Failed to process successful response')) {
    return 'Divo watched your recording, but could not make sense of what it got back. Nothing was changed.'
  }
  if (
    lastError?.includes('Transaction not found') ||
    lastError?.includes("Can't reach database server")
  ) {
    return 'Divo watched your recording, but lost its connection while saving. Nothing was changed.'
  }
  return 'Divo watched your recording, but could not save what it learned. Nothing was changed.'
}

/**
 * What went wrong, what is still safe, and the one thing to do next.
 *
 * Failures used to collapse into one card with a single "Try again" that threw
 * the manager back to the start. The kinds are genuinely different — a missing
 * macOS permission, a dropped upload with the file still on disk, and a
 * successful read that failed to save all need different next steps — so each
 * one states what survived and offers the action that actually recovers it.
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
      title: 'Pick a department you manage',
      body: 'Divo learns the way a department works from the person who runs it. Choose a department you manage, then start again.',
      retryLabel: undefined,
    },
    recorder: {
      title: 'macOS did not let Divo record',
      body: 'Open System Settings › Privacy & Security, and switch on Screen Recording and Microphone for Divo. You only have to do this once.',
      retryLabel: 'Try again',
    },
    upload: {
      title: 'Could not send your recording',
      body: 'Your recording finished and is saved on this Mac. Divo just could not send it — usually the internet connection. Nothing about the way Divo works has changed.',
      retryLabel: 'Send it again',
    },
    processing: {
      title: 'Divo could not save what it learned',
      body: describeProcessingFailure(lastError),
      retryLabel: undefined,
    },
    generic: {
      title: 'That teaching did not finish',
      body: 'Something stopped part way through. Nothing about the way Divo works has changed.',
      retryLabel: undefined,
    },
  }[kind]

  const destructive = kind === 'recorder' || kind === 'manager'
  const survivorNote =
    kind === 'upload' || kind === 'processing' || kind === 'generic'

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
          {survivorNote ? (
            <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2.5 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                {recording ? (
                  <>
                    Your recording is safe on this Mac —{' '}
                    <span className="font-medium">{recording.fileName}</span>,{' '}
                    {formatTeachBytes(recording.size)}.{' '}
                  </>
                ) : (
                  'Your recording is safe on this Mac. '
                )}
                It stays in “Your recordings” on the Teach screen, where you can
                send it again whenever you like.
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
