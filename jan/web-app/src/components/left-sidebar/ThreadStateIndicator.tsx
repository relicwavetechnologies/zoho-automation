import { memo } from 'react'
import { CircleAlert, Clock, Loader2, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  selectPiThreadCapacityWaiting,
  useAppState,
  useIsThreadActive,
} from '@/hooks/useAppState'
import { useChatSessions } from '@/stores/chat-session-store'
import { usePiApproval } from '@/hooks/usePiApproval'

/**
 * Compact, thread-level runtime state shown next to a thread title in the
 * sidebar. `idle` renders a reserved-but-empty slot — no visible badge (an
 * always-on "complete" marker on every settled thread would be pure noise,
 * so completion is conveyed by the row simply going quiet) but the fixed-size
 * box is still present so the title never shifts as state comes and goes.
 */
export type ThreadRuntimeState =
  | 'approval'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'idle'

/**
 * Deterministic precedence when several signals overlap for one thread.
 *
 * Attention states win over generic busy so they can never be hidden behind a
 * spinner while a run is still technically active:
 *   approval > failed > waiting > running > idle
 *
 * - approval / failed both demand the user's attention; approval outranks
 *   failed because it is a live, actionable block on in-flight work.
 * - waiting outranks running because a capacity-waiting prompt is also flagged
 *   busy (it has been accepted by Pi), and the waiting state is the truthful
 *   one to surface.
 */
export function deriveThreadRuntimeState(input: {
  approvalPending: boolean
  failed: boolean
  capacityWaiting: boolean
  running: boolean
}): ThreadRuntimeState {
  if (input.approvalPending) return 'approval'
  if (input.failed) return 'failed'
  if (input.capacityWaiting) return 'waiting'
  if (input.running) return 'running'
  return 'idle'
}

type IndicatorSpec = {
  Icon: typeof Loader2
  label: string
  className: string
  spin?: boolean
}

// Familiar status icons only — no rounded text pills. Every icon shares the
// same box size so transitions between states never reflow the row.
const INDICATOR_SPECS: Record<
  Exclude<ThreadRuntimeState, 'idle'>,
  IndicatorSpec
> = {
  approval: {
    Icon: ShieldAlert,
    label: 'Approval needed',
    className: 'text-amber-500',
  },
  failed: {
    Icon: CircleAlert,
    label: 'Failed',
    className: 'text-destructive',
  },
  waiting: {
    Icon: Clock,
    label: 'Waiting for capacity',
    className: 'text-muted-foreground',
  },
  running: {
    Icon: Loader2,
    label: 'Working',
    className: 'text-muted-foreground',
    spin: true,
  },
}

function ThreadStateIndicatorImpl({
  threadId,
  className,
}: {
  threadId: string
  className?: string
}) {
  const isAppStateActive = useIsThreadActive(threadId)
  const isSessionStreaming = useChatSessions(
    (state) => state.sessions[threadId]?.isStreaming ?? false
  )
  const failed = useChatSessions(
    (state) => state.sessions[threadId]?.status === 'error'
  )
  const capacityWaiting = useAppState(selectPiThreadCapacityWaiting(threadId))
  const approvalPending = usePiApproval(
    (state) => (state.queues[threadId]?.length ?? 0) > 0
  )

  const runtimeState = deriveThreadRuntimeState({
    approvalPending,
    failed,
    capacityWaiting,
    running: isAppStateActive || isSessionStreaming,
  })

  // The slot is always rendered so the icon box + flex gap are permanent; the
  // title position and truncation width never change as state comes and goes.
  const baseClassName = cn(
    'flex size-3 shrink-0 items-center justify-center',
    className
  )

  if (runtimeState === 'idle') {
    // Reserved-but-empty placeholder. aria-hidden + no role/label so screen
    // readers skip it entirely — no per-row announcement, no accessible noise.
    return (
      <span
        aria-hidden="true"
        data-thread-state="idle"
        className={baseClassName}
      />
    )
  }

  const { Icon, label, className: toneClassName, spin } =
    INDICATOR_SPECS[runtimeState]

  // `role="img"` + aria-label names the icon when the user reaches this row,
  // but it is NOT a live region, so opening a list of active rows does not
  // auto-announce a stream of state words detached from any thread name.
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-thread-state={runtimeState}
      className={baseClassName}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3 shrink-0', toneClassName, spin && 'animate-spin')}
      />
    </span>
  )
}

export const ThreadStateIndicator = memo(ThreadStateIndicatorImpl)
