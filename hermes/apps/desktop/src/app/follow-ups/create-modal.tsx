import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  defaultFollowUpCreateDraft,
  FOLLOW_UP_POLICY_PRESETS,
  MOCK_FOLLOW_UP_ASSIGNEES
} from '@/lib/follow-ups/mock-data'
import type { FollowUpCreateDraft } from '@/lib/follow-ups/types'
import { cn } from '@/lib/utils'

const DUE_CHIPS = [
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'other', label: 'Other' }
] as const

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'

export function FollowUpCreateModal({
  errorMessage,
  onOpenChange,
  onSubmit,
  open,
  submitting = false
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (draft: FollowUpCreateDraft) => Promise<void>
  submitting?: boolean
  errorMessage?: string | null
}) {
  const [draft, setDraft] = useState(defaultFollowUpCreateDraft)

  useEffect(() => {
    if (!open) {
      return
    }
    setDraft(defaultFollowUpCreateDraft())
  }, [open])

  const assignee = MOCK_FOLLOW_UP_ASSIGNEES.find(option => option.id === draft.assignee)
  const canSubmit = draft.title.trim().length > 0 && Boolean(draft.assignee) && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) {
      return
    }
    await onSubmit(draft)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-[min(85vh,640px)] max-w-[min(820px,calc(100vw-2.5rem))] gap-0 overflow-y-auto border-[#3a3a3a] bg-[#292929] p-0 text-[#e5e5e5] shadow-[0_28px_90px_rgba(0,0,0,0.62)]"
        showCloseButton
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Create Divo Follow Up</DialogTitle>
          <DialogDescription>Assign tracked work to a teammate.</DialogDescription>
        </DialogHeader>

        <div className="px-8 pb-24 pt-8">
          <Input
            aria-label="Task title"
            autoFocus
            className="mb-2 h-auto border-0 bg-transparent px-0 text-[1.45rem] font-medium text-[#e7e7e7] shadow-none placeholder:text-[#a1a1a1] focus-visible:ring-0"
            disabled={submitting}
            onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
            placeholder="Task title"
            value={draft.title}
          />
          <p className="mb-6 text-xs text-[#8e8e8e]">
            <span className="text-[#bdbdbd]">Assign</span> creates a tracked follow-up.{' '}
            <span className="text-[#bdbdbd]">Ask</span> in chat is DM only.
          </p>

          <FormRow icon="account">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              {assignee && (
                <span className="inline-flex items-center gap-2 text-[15px] text-[#dcdcdc]">
                  <span className="grid size-8 place-items-center rounded-full bg-[linear-gradient(145deg,#9ec3f2,#284865)] text-[11px] font-bold text-[#102034]">
                    {assignee.initials}
                  </span>
                  {assignee.name}
                </span>
              )}
              <span className="hidden h-6 w-px bg-[#4a4a4a] sm:block" />
              <Select
                disabled={submitting}
                onValueChange={value => setDraft(current => ({ ...current, assignee: value }))}
                value={draft.assignee}
              >
                <SelectTrigger className="h-9 min-w-[10rem] border-0 bg-[#363636] text-[#e5e5e5] shadow-none">
                  <SelectValue placeholder="Assignee" />
                </SelectTrigger>
                <SelectContent className="z-[150]">
                  {MOCK_FOLLOW_UP_ASSIGNEES.map(option => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FormRow>

          <FormRow icon="calendar">
            <div className="flex flex-wrap gap-2">
              {DUE_CHIPS.map(chip => (
                <button
                  className={cn(
                    'inline-flex h-9 items-center rounded-lg bg-[#363636] px-3 text-sm text-[#e5e5e5] transition-colors disabled:opacity-50',
                    draft.dueDate === chip.id && 'shadow-[inset_0_0_0_1px_rgba(40,183,189,0.75)]'
                  )}
                  disabled={submitting}
                  key={chip.id}
                  onClick={() => setDraft(current => ({ ...current, dueDate: chip.id }))}
                  type="button"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </FormRow>

          <FormRow icon="note">
            <Textarea
              className="min-h-[4.5rem] border-0 bg-[#363636] text-[#dcdcdc] shadow-none placeholder:text-[#8e8e8e] disabled:opacity-60"
              disabled={submitting}
              onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))}
              placeholder="Notes or reference (optional)"
              value={draft.notes}
            />
          </FormRow>

          <FormRow icon="bell">
            <Select
              disabled={submitting}
              onValueChange={value =>
                setDraft(current => ({
                  ...current,
                  policyPreset: value as FollowUpCreateDraft['policyPreset']
                }))
              }
              value={draft.policyPreset}
            >
              <SelectTrigger className="h-9 w-full border-0 bg-[#363636] text-[#e5e5e5] shadow-none sm:max-w-sm">
                <SelectValue placeholder="Follow-up policy" />
              </SelectTrigger>
              <SelectContent className="z-[150]">
                {FOLLOW_UP_POLICY_PRESETS.map(preset => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>

          {errorMessage ? (
            <p className="mt-2 rounded-lg border border-[color-mix(in_srgb,#e0697a_45%,transparent)] bg-[#2a1d20] px-3 py-2 text-sm text-[#e0697a]">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter className="absolute inset-x-8 bottom-6 flex-row items-center justify-end gap-3 border-0 bg-transparent p-0 sm:justify-end">
          <p className="mr-auto hidden text-xs text-[#8e8e8e] sm:block">No expected output required.</p>
          <Button
            className={cn('h-10 rounded-lg px-4', PANEL_BORDER, 'bg-transparent text-[#eee] hover:bg-[#333]')}
            disabled={submitting}
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
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FormRow({ children, icon }: { icon: string; children: ReactNode }) {
  return (
    <div className="mb-4 grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-4">
      <span className="grid size-8 place-items-center text-[#9a9a9a]">
        <Codicon name={icon} size="1rem" />
      </span>
      <div className="min-w-0 pt-1">{children}</div>
    </div>
  )
}
