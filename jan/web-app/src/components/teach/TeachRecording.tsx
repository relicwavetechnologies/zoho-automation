import { useEffect, useState } from 'react'
import { CircleStop, MonitorPlay } from 'lucide-react'

import { Button } from '@/components/ui/button'

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

/**
 * While recording, the manager is in other applications demonstrating work —
 * not looking at Divo. So this drops to the three things worth coming back to
 * check: that it is still running, for how long, and how to stop or bail.
 */
export function TeachRecording({ onCancel }: { onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1_000)
    return () => window.clearInterval(id)
  }, [])

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
        {formatElapsed(elapsed)}
      </p>

      <h1 className="mt-3 font-studio text-xl font-medium">
        Recording in progress
      </h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        Divo is watching your main display. Work the way you normally would and
        say what matters out loud — your narration is what turns the
        demonstration into a rule.
      </p>

      <div className="mt-6 flex items-center gap-2 rounded-full border bg-muted px-4 py-2 text-xs text-muted-foreground">
        <MonitorPlay className="size-3.5" />
        Stop from the Mac menu bar when you are finished
      </div>

      <Button variant="ghost" className="mt-4" onClick={onCancel}>
        <CircleStop /> Cancel — discard this recording
      </Button>
    </div>
  )
}
