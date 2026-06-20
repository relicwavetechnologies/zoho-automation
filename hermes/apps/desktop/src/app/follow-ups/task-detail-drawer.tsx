import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { isDivoFollowUpTask } from '@/lib/follow-ups/record-kind'
import { followUpStatusLabel, followUpStatusTone } from '@/lib/follow-ups/status-label'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import { cn } from '@/lib/utils'

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'

export function FollowUpTaskDetailDrawer({
  onAddToContext,
  onMarkDone,
  onOpenChange,
  onOpenDoc,
  onPause,
  onUpdateDoc,
  open,
  task
}: {
  open: boolean
  task: FollowUpTask | null
  onOpenChange: (open: boolean) => void
  onAddToContext?: (task: FollowUpTask) => void
  onPause?: (task: FollowUpTask) => void
  onMarkDone?: (task: FollowUpTask) => void
  onOpenDoc?: (task: FollowUpTask) => void
  onUpdateDoc?: (task: FollowUpTask) => void
}) {
  const actions = task?.lifecycleActions
  const isDivo = task ? isDivoFollowUpTask(task) : false

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="w-full border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-[#171717] text-[#dcdcdc] sm:max-w-md"
        showCloseButton
      >
        {task && actions ? (
          <>
            <SheetHeader className="gap-2 border-b border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] pb-4">
              <SheetTitle className="text-left text-[1.05rem] leading-snug text-[#eee]">{task.title}</SheetTitle>
              <SheetDescription className="text-left text-[#9a9a9a]">
                From {task.assignedBy} · due {task.dueLabel}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {isDivo && task.delegatedTag && (
                  <span className={cn('rounded-md px-2 py-0.5 text-[10px]', PANEL_BORDER, 'text-[#cd9883]')}>
                    {task.delegatedTag}
                  </span>
                )}
                <span className={cn('text-xs font-medium', followUpStatusTone(task.status))}>
                  {followUpStatusLabel(task.status)}
                </span>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-3 py-4 text-sm">
              <DetailRow label="Assigned by" value={task.assignedBy} />
              <DetailRow label="Due" value={task.dueLabel} />
              {task.notes && <DetailRow label="Notes" value={task.notes} />}
              <LinkRow href={task.larkTaskUrl} label="Lark task" />
              {actions.canOpenTrackingDoc && <LinkRow href={task.trackingDocUrl} label="Tracking doc" />}
            </div>

            <SheetFooter className="mt-auto gap-2 border-t border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] pt-4 sm:flex-col">
              {actions.canStart && (
                <Button
                  className="h-10 w-full rounded-lg bg-[#cd9883] font-semibold text-[#1a120e] hover:bg-[#d8a78f]"
                  onClick={() => onAddToContext?.(task)}
                  type="button"
                >
                  Add to context &amp; start
                </Button>
              )}
              {(actions.canPause || actions.canComplete) && (
                <div
                  className={cn(
                    'grid w-full gap-2',
                    actions.canPause && actions.canComplete ? 'grid-cols-2' : 'grid-cols-1'
                  )}
                >
                  {actions.canPause && (
                    <Button
                      className={cn('h-9 rounded-lg', PANEL_BORDER, 'bg-[#1b1b1b] hover:bg-[#222]')}
                      onClick={() => onPause?.(task)}
                      type="button"
                      variant="outline"
                    >
                      Pause
                    </Button>
                  )}
                  {actions.canComplete && (
                    <Button
                      className="h-9 rounded-lg bg-[#2a2a2a] hover:bg-[#333]"
                      onClick={() => onMarkDone?.(task)}
                      type="button"
                      variant="secondary"
                    >
                      Mark done
                    </Button>
                  )}
                </div>
              )}
              {actions.canUpdateDoc && (
                <Button
                  className={cn('h-9 w-full rounded-lg', PANEL_BORDER, 'bg-transparent hover:bg-[#222]')}
                  onClick={() => onUpdateDoc?.(task)}
                  type="button"
                  variant="outline"
                >
                  Update doc
                </Button>
              )}
              {actions.canOpenTrackingDoc && (
                <Button
                  className={cn('h-9 w-full rounded-lg', PANEL_BORDER, 'bg-transparent hover:bg-[#222]')}
                  onClick={() => onOpenDoc?.(task)}
                  type="button"
                  variant="outline"
                >
                  <Codicon className="mr-1.5" name="link-external" size="0.85rem" />
                  Open tracking doc
                </Button>
              )}
              {actions.canStart && task.status === 'paused' && (
                <p className="text-xs text-[#8e8e8e]">Paused — resume from Add to context &amp; start.</p>
              )}
              {!actions.isFollowUp && (
                <p className="text-xs text-[#8e8e8e]">Plain Lark task — open the Lark task link above to manage it.</p>
              )}
            </SheetFooter>
          </>
        ) : (
          <div className="py-8 text-sm text-[#8e8e8e]">No task selected.</div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
      <span className="text-xs uppercase tracking-wide text-[#7a7a7a]">{label}</span>
      <span className="text-[#dcdcdc]">{value}</span>
    </div>
  )
}

function LinkRow({ href, label }: { label: string; href?: string }) {
  if (!href) {
    return (
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
        <span className="text-xs uppercase tracking-wide text-[#7a7a7a]">{label}</span>
        <span className="text-[#8e8e8e]">—</span>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
      <span className="text-xs uppercase tracking-wide text-[#7a7a7a]">{label}</span>
      <a className="truncate text-[#7fa9cf] hover:underline" href={href} rel="noreferrer" target="_blank">
        {href}
      </a>
    </div>
  )
}
