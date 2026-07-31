import { useEffect, useState } from 'react'
import { CircleStop, Square, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatTeachElapsed } from '@/lib/teach-activity'

/**
 * The live recording screen.
 *
 * Previously the only button here threw the recording away, and finishing
 * properly meant knowing to stop it from the macOS menu bar. Anyone who did
 * not know that — which is most people — pressed the one button that was
 * offered and destroyed the demonstration they had just given. So stopping and
 * keeping the recording is now the obvious primary action, and discarding is a
 * quiet secondary that asks first.
 */
export function TeachRecording({
  startedAt,
  onStop,
  onCancel,
}: {
  /** ISO timestamp from the native recorder, so the timer survives a remount. */
  startedAt?: string | null
  onStop: () => void
  onCancel: () => void
}) {
  const [elapsed, setElapsed] = useState(0)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  useEffect(() => {
    // Anchored to the recorder's own start time rather than counting from
    // mount, so leaving Teach and coming back shows the real duration.
    const started = startedAt ? new Date(startedAt).getTime() : Date.now()
    const tick = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - started) / 1_000)))
    tick()
    const id = window.setInterval(tick, 1_000)
    return () => window.clearInterval(id)
  }, [startedAt])

  return (
    <div
      className="flex h-full flex-col items-center justify-center overflow-y-auto px-5 py-10 text-center"
      data-testid="teach-mode"
    >
      <span className="relative grid size-20 place-items-center rounded-full bg-destructive/10 text-destructive">
        <span className="absolute inset-0 animate-ping rounded-full bg-destructive/15" />
        <span className="relative size-5 rounded-full bg-destructive" />
      </span>

      <p
        className="mt-6 font-mono text-4xl font-medium tabular-nums tracking-tight"
        aria-label="Recording elapsed time"
      >
        {formatTeachElapsed(elapsed)}
      </p>

      <h1 className="mt-3 font-studio text-xl font-medium">
        Recording your screen
      </h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        Do the task the way you normally would, and say out loud why you make
        each choice. Your explanation is what Divo learns from.
      </p>

      <Button
        size="lg"
        className="mt-7"
        onClick={onStop}
        data-testid="stop-teach-recording"
      >
        <Square className="fill-current" /> Stop and save
      </Button>
      <p className="mt-2.5 text-xs text-muted-foreground">
        Nothing is sent until you stop. You can also stop from the Mac menu bar.
      </p>

      <Button
        variant="ghost"
        size="sm"
        className="mt-6 text-muted-foreground"
        onClick={() => setConfirmingDiscard(true)}
      >
        <CircleStop /> Discard this recording
      </Button>

      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Throw this recording away?</DialogTitle>
            <DialogDescription>
              Everything you have recorded so far is deleted and Divo learns
              nothing from it. To keep it instead, choose “Stop and save”.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmingDiscard(false)}
            >
              Keep recording
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDiscard(false)
                onCancel()
              }}
            >
              <Trash2 /> Discard it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
