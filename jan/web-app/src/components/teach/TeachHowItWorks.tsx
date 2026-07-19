import { ShieldCheck, Video } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * The four things a manager needs to know before recording. This used to be a
 * permanent panel on the landing page; it is the same content, reachable on
 * demand, so it stops competing with the persona and history a returning
 * manager actually came to see.
 */
export const TEACH_STEPS = [
  {
    title: 'Your main display starts recording',
    detail:
      'Along with your microphone, so your reasoning is captured with the screen.',
  },
  {
    title: 'Work normally and explain what matters',
    detail:
      'Say why you chose something, not just what you clicked — that is what becomes a rule.',
  },
  {
    title: 'Stop from the Mac menu bar',
    detail:
      'Divo reads the recording, then opens a conversation to check what it understood.',
  },
  {
    title: 'You approve every change',
    detail:
      'Nothing reaches your department persona until you confirm it, and recent sessions can be undone.',
  },
]

export function TeachSteps({ className }: { className?: string }) {
  return (
    <div className={className}>
      {TEACH_STEPS.map((step, index) => (
        <div key={step.title} className="flex gap-3 py-2.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-5">{step.title}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {step.detail}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

export function TeachHowItWorks({
  open,
  onOpenChange,
  onRecord,
  canRecord,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRecord: () => void
  canRecord: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>How Teach works</DialogTitle>
          <DialogDescription>
            Divo learns from a demonstration, not from a form. You show the
            work; it writes the rule.
          </DialogDescription>
        </DialogHeader>

        <TeachSteps />

        <div className="flex gap-2.5 rounded-xl bg-muted p-3 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            Nothing is recorded in the background. Teach captures only while a
            session is running, and only your main display.
          </span>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={!canRecord}
            onClick={() => {
              onOpenChange(false)
              onRecord()
            }}
          >
            <Video /> Record teaching
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
