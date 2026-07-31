import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDotIcon,
  Clock3Icon,
  ListChecksIcon,
  OctagonXIcon,
} from 'lucide-react'
import type { ThreadMessage } from '@janhq/core'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  currentDivoTodoItem,
  latestDivoTodoDetailsForThread,
  type DivoTodoItem,
  type DivoTodoStatus,
} from '@/lib/pi/todo'

type TodoBubbleProps = {
  threadId?: string
  messages: ThreadMessage[]
  activeRootId?: string
}

function statusLabel(status: DivoTodoStatus): string {
  switch (status) {
    case 'in_progress':
      return 'In progress'
    case 'pending':
      return 'Up next'
    case 'completed':
      return 'Done'
    case 'blocked':
      return 'Blocked'
    case 'cancelled':
      return 'Stopped'
  }
}

function ItemStatusIcon({ status }: { status: DivoTodoStatus }) {
  if (status === 'completed') {
    return <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
  }
  if (status === 'in_progress') {
    return <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 animate-pulse text-primary" />
  }
  if (status === 'blocked') {
    return <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
  }
  if (status === 'cancelled') {
    return <OctagonXIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
  }
  return <Clock3Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
}

function TaskRow({ item, subdued = false }: { item: DivoTodoItem; subdued?: boolean }) {
  return (
    <div className={cn('flex gap-2 rounded-md px-1 py-1.5', subdued && 'opacity-65')}>
      <ItemStatusIcon status={item.status} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[13px] leading-5 text-muted-foreground',
            item.status === 'completed' && 'line-through',
          )}
        >
          {item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content}
        </p>
        {item.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
            {item.description}
          </p>
        ) : null}
        {item.blockedBy.length > 0 ? (
          <p className="mt-0.5 truncate text-[11px] text-amber-600 dark:text-amber-400">
            Blocked by {item.blockedBy.map((id) => `#${id}`).join(', ')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Section({
  title,
  items,
  subdued,
}: {
  title: string
  items: DivoTodoItem[]
  subdued?: boolean
}) {
  if (items.length === 0) return null
  return (
    <section>
      <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </p>
      <div className="divide-y divide-border/60">
        {items.map((item) => <TaskRow key={item.id} item={item} subdued={subdued} />)}
      </div>
    </section>
  )
}

/**
 * A read-only view of the current Pi-owned task board. The component receives
 * only the route's own thread history and first resolves its active branch, so
 * a task state from another chat or a discarded branch cannot reach this UI.
 */
export function TodoBubble({ threadId, messages, activeRootId }: TodoBubbleProps) {
  const details = useMemo(
    () => latestDivoTodoDetailsForThread(messages, activeRootId),
    [activeRootId, messages]
  )
  const current = details ? currentDivoTodoItem(details) : undefined
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [threadId, details?.boardId])

  // A completed board needs no idle composer affordance. Its complete history
  // remains in the Pi transcript; the bubble returns with the next active plan.
  if (!threadId || !details || !current) return null

  const completed = details.items.filter((item) => item.status === 'completed')
  const active = details.items.filter((item) => item.status === 'in_progress')
  const next = details.items.filter((item) => item.status === 'pending')
  const blocked = details.items.filter((item) => item.status === 'blocked')
  const stopped = details.items.filter((item) => item.status === 'cancelled')
  const label = current.activeForm || current.content
  const openCount = active.length + next.length + blocked.length

  return (
    <div className="flex min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                data-testid="todo-bubble-trigger"
                aria-label={`Open task plan: ${label}`}
                className="h-7 min-w-0 max-w-full gap-1.5 rounded-full px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ListChecksIcon className={cn('size-3.5 shrink-0', current.status === 'in_progress' && 'text-primary')} />
                <span className="min-w-0 truncate text-xs">{label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground/70">{openCount}</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-72">
            <p className="font-medium">{statusLabel(current.status)}</p>
            <p className="mt-0.5 text-background/80">
              {current.description || current.activeForm || current.content}
            </p>
            {current.blockedBy.length > 0 ? (
              <p className="mt-1 text-amber-200">Blocked by {current.blockedBy.map((id) => `#${id}`).join(', ')}</p>
            ) : null}
          </TooltipContent>
        </Tooltip>

        <PopoverContent side="top" align="start" className="w-[min(25rem,calc(100vw-2rem))] p-0">
          <PopoverHeader className="p-3 pb-2">
            <div className="flex items-center justify-between gap-3">
              <PopoverTitle className="flex items-center gap-2 text-sm">
                <ListChecksIcon className="size-4 text-primary" />
                Task plan
              </PopoverTitle>
              <span className="text-xs text-muted-foreground">
                {completed.length}/{details.items.length} done
              </span>
            </div>
            <PopoverDescription className="truncate">
              {current.status === 'in_progress' ? 'Current work is highlighted below.' : 'Waiting for the next task to start.'}
            </PopoverDescription>
          </PopoverHeader>
          <div className="max-h-80 overflow-y-auto border-t border-border/70 p-3 pt-2">
            <div className="space-y-3">
              <Section title="Previous" items={completed} subdued />
              <Section title={current.status === 'in_progress' ? 'Active' : statusLabel(current.status)} items={active.length ? active : [current]} />
              <Section title="Up next" items={next.filter((item) => item.id !== current.id)} />
              <Section title="Blocked" items={blocked.filter((item) => item.id !== current.id)} />
              <Section title="Stopped" items={stopped} subdued />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
