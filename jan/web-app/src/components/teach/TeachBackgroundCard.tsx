import { useRouter } from '@tanstack/react-router'
import {
  AlertTriangle,
  GraduationCap,
  MessageSquareText,
  UploadCloud,
  Video,
} from 'lucide-react'

import { route } from '@/constants/routes'
import { useTeachActivitySummary } from '@/hooks/useTeachActivity'
import { useWorkspaceMode } from '@/hooks/useWorkspaceMode'
import { cn } from '@/lib/utils'
import type { TeachWorkPhase } from '@/lib/teach-activity'

const PHASE_STYLE: Record<
  TeachWorkPhase,
  { icon: typeof Video; tint: string; bar: string; pulse: boolean }
> = {
  recording: {
    icon: Video,
    tint: 'text-destructive',
    bar: 'bg-destructive',
    pulse: true,
  },
  sending: {
    icon: UploadCloud,
    tint: 'text-violet-500',
    bar: 'bg-violet-500',
    pulse: true,
  },
  thinking: {
    icon: GraduationCap,
    tint: 'text-violet-500',
    bar: 'bg-violet-500',
    pulse: true,
  },
  needs_you: {
    icon: MessageSquareText,
    tint: 'text-emerald-600',
    bar: 'bg-emerald-500',
    pulse: false,
  },
  stalled: {
    icon: AlertTriangle,
    tint: 'text-amber-600',
    bar: 'bg-amber-500',
    pulse: false,
  },
  ready_to_send: {
    icon: AlertTriangle,
    tint: 'text-amber-600',
    bar: 'bg-amber-500',
    pulse: false,
  },
}

/**
 * Proof that Teach is still working, visible from anywhere in the app.
 *
 * The honest answer to "did I just lose my recording by clicking away?" is a
 * thing on screen that says otherwise. A toast cannot do this — it is gone in
 * five seconds and misses anyone who stepped away from the keyboard. So this
 * sits in the sidebar for exactly as long as there is outstanding Teach work,
 * shows what stage that work is at, and is itself the way back to it.
 *
 * It renders nothing when there is no work. An indicator that is always
 * present stops being read.
 */
export function TeachBackgroundCard() {
  const router = useRouter()
  const setMode = useWorkspaceMode((state) => state.setMode)
  const summary = useTeachActivitySummary()

  if (!summary) return null

  const style = PHASE_STYLE[summary.phase]
  const Icon = style.icon
  const open = () => {
    setMode('teach')
    void router.navigate({ to: route.home })
  }

  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        onClick={open}
        data-testid="teach-background-activity"
        aria-label={`${summary.headline} — open Teach`}
        className="w-full rounded-xl border bg-sidebar-accent/40 p-2.5 text-left transition-colors hover:bg-sidebar-accent"
      >
        <div className="flex items-center gap-2">
          <span className={cn('relative shrink-0', style.tint)}>
            <Icon className={cn('size-3.5', style.pulse && 'animate-pulse')} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {summary.headline}
          </span>
          {summary.percent !== null && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {summary.percent}%
            </span>
          )}
        </div>

        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {summary.detail}
        </p>

        {summary.percent !== null && (
          <span
            aria-hidden
            className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-border"
          >
            <span
              className={cn('block h-full rounded-full transition-all', style.bar)}
              style={{ width: `${Math.min(100, Math.max(2, summary.percent))}%` }}
            />
          </span>
        )}

        {summary.count > 1 && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            +{summary.count - 1} more waiting
          </p>
        )}
      </button>
    </div>
  )
}
