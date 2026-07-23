import type { DragEvent, ReactNode } from 'react'

import { MovingBorder } from '@/containers/MovingBorder'
import { cn } from '@/lib/utils'

/**
 * The composer's outer chrome, as one component with two deliberately
 * different looks.
 *
 * ChatInput renders the same body — attachments, the `/` menu, the input row,
 * approvals — in two places: the landing page (a fresh, empty conversation)
 * and inside an ongoing thread. The request was for those two to look
 * different while behaving identically.
 *
 * The behaviour that could diverge does NOT live in the body. It lives on the
 * shell: the MovingBorder that traces the frame while streaming, the drag-drop
 * target, and the focus ring. So the shell is the one thing extracted, and it
 * takes every one of those as props — both variants pass the same handlers, so
 * "behaves identically" is structural here, not a promise. The body is handed
 * through as `children`, untouched, closing over ChatInput's state exactly as
 * it did inline.
 *
 * The only real difference between the variants is the `styles` map below.
 * `landing` is a generous, rectangular two-row composition. `thread` is the
 * compact, pill-shaped follow-up bar that stays visually quiet beneath a
 * transcript. Behaviour remains shared: both retain the same drag/drop,
 * focus, and streaming-border ownership.
 */
export type DivoComposerShellVariant = 'landing' | 'thread'

export type DivoComposerShellProps = {
  variant: DivoComposerShellVariant
  /** Streaming — turns on the MovingBorder trace. */
  isComposerBusy: boolean
  isFocused: boolean
  isDragOver: boolean
  /** When false, the shell is not a drop target and binds no drag handlers. */
  dropAcceptsAnything: boolean
  onDragEnter: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  children: ReactNode
}

/**
 * Per-variant chrome. Kept as whole class strings rather than toggled
 * fragments so each variant reads as one coherent surface you can eyeball,
 * instead of a diff you have to assemble in your head.
 */
const styles: Record<
  DivoComposerShellVariant,
  { shell: string; focused: string; dragOver: string }
> = {
  landing: {
    shell:
      'relative z-20 flex min-h-[96px] flex-col rounded-[18px] border border-border/80 bg-card p-2 transition-colors dark:border-white/15 dark:bg-white/[0.045]',
    focused: 'border-primary/60 dark:border-primary/60 dark:bg-white/[0.065]',
    dragOver: 'ring-2 ring-primary/50 border-primary',
  },
  thread: {
    shell:
      'relative z-20 flex min-h-[40px] flex-col justify-center rounded-[38px] border border-border/80 bg-card px-2.5 py-1 transition-colors dark:border-white/15 dark:bg-white/[0.035]',
    focused: 'border-border dark:bg-white/[0.055]',
    dragOver: 'ring-2 ring-ring/50 border-primary',
  },
}

export function DivoComposerShell({
  variant,
  isComposerBusy,
  isFocused,
  isDragOver,
  dropAcceptsAnything,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  children,
}: DivoComposerShellProps) {
  const s = styles[variant]
  const frameRadius = variant === 'landing' ? 'rounded-[18px]' : 'rounded-[38px]'

  return (
    <div className="relative">
      {/* overflow-hidden clips the MovingBorder to the rounded frame. The `/`
          menu popover deliberately lives OUTSIDE this in ChatInput, since it
          would be clipped here. */}
      <div className={cn('relative overflow-hidden p-0.5', frameRadius)}>
        {isComposerBusy && (
          <div className="absolute inset-0">
            <MovingBorder rx="10%" ry="10%">
              <div className="h-100 w-100 bg-[radial-gradient(var(--app-primary),transparent_60%)]" />
            </MovingBorder>
          </div>
        )}

        <div
          className={cn(
            s.shell,
            isFocused && s.focused,
            isDragOver && s.dragOver
          )}
          data-drop-zone={dropAcceptsAnything ? 'true' : undefined}
          data-composer-variant={variant}
          onDragEnter={dropAcceptsAnything ? onDragEnter : undefined}
          onDragLeave={dropAcceptsAnything ? onDragLeave : undefined}
          onDragOver={dropAcceptsAnything ? onDragOver : undefined}
          onDrop={dropAcceptsAnything ? onDrop : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
