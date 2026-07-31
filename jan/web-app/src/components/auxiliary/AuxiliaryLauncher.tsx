import { FileCode2Icon, MessageSquarePlusIcon } from 'lucide-react'
import { AUXILIARY_LAUNCHER } from '@/lib/auxiliary/kind-registry'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import { cn } from '@/lib/utils'

const DEMO_ARTIFACT = `# Research brief

A sample artifact surface for Divo Dex. Agent tools will open real reports here later — for now you can promote HTML from chat or create a blank report.

## What belongs here

- Long-form research writeups
- Structured findings with headings and lists
- HTML / SVG previews promoted out of the transcript

## Why a separate surface

Keeping dense output in the auxiliary rail keeps the main thread scannable while you iterate on the work product.
`

function launcherIcon(id: string) {
  switch (id) {
    case 'side-chat':
      return MessageSquarePlusIcon
    case 'demo-artifact':
      return FileCode2Icon
    default:
      return FileCode2Icon
  }
}

function launcherIconClass(id: string) {
  switch (id) {
    case 'side-chat':
      return 'text-sky-600 dark:text-sky-400'
    case 'demo-artifact':
      return 'text-violet-600 dark:text-violet-400'
    default:
      return 'text-muted-foreground'
  }
}

export function AuxiliaryLauncher() {
  const openSideChat = useAuxiliaryTabs((s) => s.openSideChat)
  const openArtifact = useAuxiliaryTabs((s) => s.openArtifact)

  return (
    <div className="flex h-full min-h-0 flex-col justify-center px-5 py-8">
      <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground/70 uppercase">
        Open in sidebar
      </p>
      <ul className="mt-4 space-y-0.5">
        {AUXILIARY_LAUNCHER.map((item) => {
          const Icon = launcherIcon(item.id)
          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={!item.enabled}
                onClick={() => {
                  if (item.kind === 'sideChat') {
                    openSideChat()
                    return
                  }
                  if (item.kind === 'artifact') {
                    openArtifact({
                      title: 'Research brief',
                      content: DEMO_ARTIFACT,
                      mime: 'text/markdown',
                      artifactId: `demo-${Date.now()}`,
                    })
                  }
                }}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors',
                  item.enabled
                    ? 'hover:bg-muted/60'
                    : 'cursor-not-allowed opacity-45'
                )}
              >
                <span
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-lg border border-border/60 bg-background/80',
                    item.enabled && 'group-hover:border-border'
                  )}
                >
                  <Icon
                    className={cn('size-3.5', launcherIconClass(item.id))}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-foreground/90">
                    {item.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.description}
                  </span>
                </span>
                {item.shortcut ? (
                  <kbd className="font-mono text-[10px] tracking-wide text-muted-foreground/70">
                    {item.shortcut}
                  </kbd>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
