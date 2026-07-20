import type { DragEvent, ReactNode } from 'react'

import { MovingBorder } from '@/containers/MovingBorder'
import { cn } from '@/lib/utils'

/**
 * The composer's outer chrome, as one component with two looks.
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
 * `landing` is deliberately more present — a larger radius, a lifted surface
 * with a soft shadow, and a focus ring in Divo's accent — because it is the
 * hero of an otherwise empty page. `thread` is the restrained shell that has
 * to sit quietly beneath a scrolling transcript, and is byte-for-byte the
 * treatment it always had, so nothing about the in-thread composer moves.
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
 *
 * The `thread` strings are lifted verbatim from the original inline shell —
 * same radius, border, fill and focus treatment — so extracting the component
 * changes the in-thread composer by exactly nothing.
 */
const styles: Record<
  DivoComposerShellVariant,
  { shell: string; focused: string; dragOver: string }
> = {
  landing: {
    // The hero surface has to LIFT off a near-black page, and elevation cues
    // (drop shadow, a few px of radius) are invisible there — the first cut
    // used exactly those and read as no change at all. So the lift is carried
    // by contrast instead: a distinctly lighter fill (3× the thread panel), a
    // border that actually catches light, more generous padding, and a much
    // rounder frame. Those differences survive on dark; a shadow does not.
    shell:
      'relative z-20 flex flex-col rounded-[30px] border border-border/70 bg-card p-3 shadow-[0_16px_50px_-20px_rgba(0,0,0,0.7)] transition-colors dark:border-white/12 dark:bg-white/[0.06]',
    focused: 'border-primary/60 dark:border-primary/60 dark:bg-white/[0.08]',
    dragOver: 'ring-2 ring-primary/50 border-primary',
  },
  thread: {
    // Verbatim from the original shell: a hairline over a barely-lifted fill,
    // so it reads as part of the page rather than a card stuck on top of it.
    shell:
      'relative z-20 flex flex-col rounded-[24px] border border-border/50 bg-card p-2 transition-colors dark:bg-white/[0.02]',
    focused: 'border-border/80 dark:bg-white/[0.04]',
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

  return (
    <div className="relative">
      {/* overflow-hidden clips the MovingBorder to the rounded frame. The `/`
          menu popover deliberately lives OUTSIDE this in ChatInput, since it
          would be clipped here. */}
      <div className="relative overflow-hidden rounded-[22px] p-0.5">
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
