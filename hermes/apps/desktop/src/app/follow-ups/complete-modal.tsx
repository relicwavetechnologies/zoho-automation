import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'

export function FollowUpCompleteModal({
  errorMessage,
  generating = false,
  onGenerateSummary,
  onOpenChange,
  onSubmit,
  open,
  submitting = false,
  taskTitle
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (summary: string) => Promise<void>
  onGenerateSummary?: () => Promise<string> | string
  submitting?: boolean
  generating?: boolean
  errorMessage?: string | null
  taskTitle?: string
}) {
  const [summary, setSummary] = useState('')

  useEffect(() => {
    if (open) {
      setSummary('')
    }
  }, [open])

  const canSubmit = summary.trim().length > 0 && !submitting && !generating

  const handleGenerate = async () => {
    if (!onGenerateSummary || submitting || generating) {
      return
    }

    const generated = await onGenerateSummary()
    setSummary(generated)
  }

  const handleSubmit = async () => {
    if (!canSubmit) {
      return
    }

    await onSubmit(summary.trim())
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-[min(560px,calc(100vw-2.5rem))] gap-0 border-[#3a3a3a] bg-[#292929] p-0 text-[#e5e5e5] shadow-[0_28px_90px_rgba(0,0,0,0.62)]"
        showCloseButton
      >
        <DialogHeader className="border-b border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-6 py-4">
          <DialogTitle className="text-left text-[1.05rem] text-[#eee]">Complete follow-up</DialogTitle>
          <DialogDescription className="text-left text-[#9a9a9a]">
            {taskTitle ? `Approve the final update for "${taskTitle}".` : 'Approve the final update for this task.'}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="text-xs font-medium uppercase tracking-wide text-[#8e8e8e]" htmlFor="follow-up-summary">
              Manager summary
            </label>
            {onGenerateSummary && (
              <Button
                className={cn('h-8 rounded-lg px-3 text-xs', PANEL_BORDER, 'bg-transparent hover:bg-[#333]')}
                disabled={submitting || generating}
                onClick={() => void handleGenerate()}
                type="button"
                variant="outline"
              >
                {generating ? 'Generating...' : 'Generate from chat'}
              </Button>
            )}
          </div>
          <Textarea
            aria-label="Completion summary"
            className="min-h-[150px] resize-y border-[#3a3a3a] bg-[#1f1f1f] text-[#e5e5e5] placeholder:text-[#8e8e8e]"
            disabled={submitting || generating}
            id="follow-up-summary"
            onChange={event => setSummary(event.target.value)}
            placeholder="What should the manager know before this is marked done?"
            value={summary}
          />

          {errorMessage ? (
            <p className="mt-3 rounded-lg border border-[color-mix(in_srgb,#e0697a_45%,transparent)] bg-[#2a1d20] px-3 py-2 text-sm text-[#e0697a]">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-3 border-t border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-6 py-4 sm:justify-end">
          <Button
            className={cn('h-10 rounded-lg px-4', PANEL_BORDER, 'bg-transparent text-[#eee] hover:bg-[#333]')}
            disabled={submitting || generating}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            className="h-10 rounded-lg bg-[#cfcfcf] px-5 font-semibold text-[#292929] hover:bg-[#dedede] disabled:opacity-60"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {submitting ? 'Completing...' : 'Mark done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
