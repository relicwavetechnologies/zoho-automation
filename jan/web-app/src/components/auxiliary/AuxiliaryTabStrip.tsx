import {
  FileCode2Icon,
  MessageSquareIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react'
import type { AuxiliaryTab, AuxiliaryTabKind } from '@/lib/auxiliary/types'
import { tabKindLabel } from '@/lib/auxiliary/kind-registry'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

function TabKindIcon({
  kind,
  className,
}: {
  kind: AuxiliaryTabKind
  className?: string
}) {
  if (kind === 'sideChat') {
    return (
      <MessageSquareIcon
        className={cn('size-3.5 shrink-0', className)}
        aria-hidden
      />
    )
  }
  return (
    <FileCode2Icon className={cn('size-3.5 shrink-0', className)} aria-hidden />
  )
}

function tabTooltip(tab: AuxiliaryTab): string {
  return `${tabKindLabel(tab.kind)} · ${tab.title}`
}

export function AuxiliaryTabStrip({
  tabs,
  activeTabId,
}: {
  tabs: AuxiliaryTab[]
  activeTabId: string | null
}) {
  const focusTab = useAuxiliaryTabs((s) => s.focusTab)
  const closeTab = useAuxiliaryTabs((s) => s.closeTab)
  const openSideChat = useAuxiliaryTabs((s) => s.openSideChat)
  const openArtifact = useAuxiliaryTabs((s) => s.openArtifact)

  return (
    <div className="relative z-30 flex h-10 shrink-0 items-stretch gap-0.5 border-b border-border/70 bg-muted/15 px-1 pt-1">
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const kind = tabKindLabel(tab.kind)
          return (
            <div
              key={tab.id}
              className={cn(
                'group relative flex max-w-[11rem] min-w-[7rem] items-center gap-1 rounded-t-md border px-2 text-xs',
                active
                  ? 'border-border/80 border-b-background bg-background text-foreground shadow-[0_-1px_0_0_var(--background)]'
                  : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
                    onClick={() => focusTab(tab.id)}
                    aria-label={tabTooltip(tab)}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-md',
                        tab.kind === 'sideChat'
                          ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                          : 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
                      )}
                      title={kind}
                    >
                      <TabKindIcon kind={tab.kind} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  <span className="font-medium">{kind}</span>
                  <span className="opacity-70"> · {tab.title}</span>
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                aria-label={`Close ${kind}`}
                className={cn(
                  'shrink-0 rounded p-0.5 text-muted-foreground/70 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100',
                  active && 'opacity-100'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="my-auto shrink-0"
            aria-label="Open new tab"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => openSideChat()}>
            <MessageSquareIcon className="size-3.5 text-sky-600 dark:text-sky-400" />
            Side chat
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              openArtifact({
                title: 'Untitled artifact',
                content: '# Untitled\n\nStart writing…\n',
                mime: 'text/markdown',
              })
            }
          >
            <FileCode2Icon className="size-3.5 text-violet-600 dark:text-violet-400" />
            Artifact
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
