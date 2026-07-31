import type {
  TeachLocalRecording,
  TeachRecorderStatus,
  TeachSession,
} from '@/lib/divo-teach'

/**
 * One recording's state in the words a manager would use.
 *
 * Teach has twelve backend session statuses and five local sidecar states.
 * That vocabulary is correct and it is unreadable — a manager only ever needs
 * to know which of five things is true: it hasn't been sent, it is being sent,
 * Divo is working on it, Divo needs them, or something stopped. Everything the
 * UI shows is derived here so the screen, the background chip, and the toasts
 * can never disagree about what is happening.
 */
export type TeachWorkPhase =
  | 'recording'
  | 'ready_to_send'
  | 'sending'
  | 'thinking'
  | 'needs_you'
  | 'stalled'

export type TeachWorkItem = {
  /** Local file path — the stable identity of a piece of work. */
  path: string
  fileName: string
  size: number
  sessionId: string | null
  phase: TeachWorkPhase
  /** Short, plain-language state. Safe to show on its own. */
  headline: string
  /** One sentence answering "so what should I do?". */
  detail: string
  /** 0-100 when a real number exists, otherwise null — never a fake number. */
  percent: number | null
  /** Failure text worth surfacing, already stripped of stack-trace noise. */
  problem: string | null
  canSend: boolean
  canOpen: boolean
  canDelete: boolean
  /** True once Divo has been "working" without moving for long enough. */
  canResume: boolean
  updatedAt: string
}

/**
 * How long a session may sit at the same progress before offering a retry.
 *
 * Long enough that a slow step — transcribing a twenty-minute recording — is
 * never mistaken for a hang, short enough that a manager is not left staring
 * at a frozen bar until the server's ten-minute sweep notices.
 */
export const TEACH_STUCK_AFTER_MS = 120_000

export type TeachActivityInput = {
  recorder: TeachRecorderStatus
  recordings: TeachLocalRecording[]
  sessions: Record<string, TeachSession | undefined>
  /** Session ids with an upload streaming right now, per the Rust backend. */
  uploading: string[]
  /** Live bytes-sent percentage per session, from the native upload stream. */
  uploadPercent: Record<string, number>
  /** When each session's progress last actually changed, for stall detection. */
  progressSeenAt: Record<string, number>
  /** Injected rather than read, so stall detection stays pure and testable. */
  now: number
  /** False when Divo cannot currently reach the backend. */
  online: boolean
}

const SETTLED_STATUSES: ReadonlyArray<TeachSession['status']> = [
  'completed',
  'persona_updated',
  'no_learning',
]

const THINKING_STATUSES: ReadonlyArray<TeachSession['status']> = [
  'queued',
  'ingesting',
  'ready_for_processing',
  'persona_processing',
]

const NEEDS_YOU_STATUSES: ReadonlyArray<TeachSession['status']> = [
  'evidence_ready',
  'agent_processing',
]

/** True once Divo has finished with a session and nothing is owed to the user. */
export const isTeachSessionSettled = (session: TeachSession) =>
  SETTLED_STATUSES.includes(session.status)

export const isTeachSessionWaitingForYou = (session: TeachSession) =>
  NEEDS_YOU_STATUSES.includes(session.status)

/**
 * Turn a raw failure into something a non-technical manager can act on.
 *
 * Backend errors arrive as transport strings ("error sending request for url
 * (https://…): connection closed"). Showing those verbatim reads as a crash;
 * naming the cause tells the manager whether to wait, retry, or ask for help.
 */
export function explainTeachProblem(
  raw: string | null | undefined
): string | null {
  if (!raw) return null
  const text = String(raw)
  if (
    /network|connection|timed? ?out|dns|unreachable|connect|socket/i.test(text)
  ) {
    return 'Divo could not reach the internet while sending this.'
  }
  if (/HTTP 401|HTTP 403|unauthor|forbidden/i.test(text)) {
    return 'Your Divo sign-in expired while sending this.'
  }
  if (/HTTP 413|too large/i.test(text)) {
    return 'This recording is too large to send. A shorter one will work.'
  }
  if (/HTTP 5\d\d|server error/i.test(text)) {
    return 'Divo’s service had a problem. This usually clears on its own.'
  }
  if (/database|transaction not found|can't reach database/i.test(text)) {
    return 'Divo read the recording but could not save what it learned.'
  }
  return 'Something went wrong while Divo was working on this.'
}

/** Backoff for automatic upload retries, capped so it never gives up quietly. */
export function teachRetryDelayMs(attempt: number): number {
  const seconds = Math.min(120, 5 * 2 ** Math.max(0, attempt - 1))
  return seconds * 1_000
}

/**
 * How long to wait before probing a backend that just stopped answering.
 *
 * Starts almost immediately so a backend restart is picked up within seconds,
 * then backs off so a genuinely dead server is not hammered. The caller resets
 * the count on the first success, which is what makes recovery feel instant
 * rather than "whenever the next slow poll happens to land".
 */
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const

export function teachReconnectDelayMs(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(0, consecutiveFailures),
    RECONNECT_DELAYS_MS.length - 1
  )
  return RECONNECT_DELAYS_MS[index]!
}

/**
 * Whether a failure is worth retrying by itself, or needs the manager.
 *
 * A dropped connection must never dead-end into an error screen — the
 * reconciler is already going to retry it, so telling the manager it failed
 * makes Divo look broken while it is quietly recovering. A rejected file or an
 * expired sign-in genuinely does need them, and retrying only wastes upload.
 */
export function isTransientTeachError(error: unknown): boolean {
  const text = String(
    (error as { message?: string } | null)?.message ?? error ?? ''
  )
  if (/HTTP 4\d\d/i.test(text) && !/HTTP 429/i.test(text)) return false
  return /network|connection|connect|refused|timed? ?out|timeout|dns|unreachable|socket|offline|reset by peer|HTTP 5\d\d|HTTP 429/i.test(
    text
  )
}

function describe(
  phase: TeachWorkPhase,
  percent: number | null,
  online: boolean
): { headline: string; detail: string } {
  switch (phase) {
    case 'recording':
      return {
        headline: 'Recording',
        detail: 'Work the way you normally would and say what matters out loud.',
      }
    case 'sending':
      return {
        headline: 'Sending to Divo',
        detail:
          percent === null
            ? 'You can close this and keep working — it carries on in the background.'
            : `${percent}% sent. You can close this and keep working — it carries on in the background.`,
      }
    case 'thinking':
      // Offline, the last status we read is just the last status we read.
      // Animating a stale percentage as though work were still happening was
      // a plain contradiction of the "cannot be reached" banner beside it.
      return online
        ? {
            headline: 'Divo is watching your recording',
            detail:
              'This usually takes a few minutes. You can close this and keep working.',
          }
        : {
            headline: 'Waiting to reconnect',
            detail:
              'Divo is offline. Your recording is safe and picks up from here on its own.',
          }
    case 'needs_you':
      return {
        headline: 'Ready for you',
        detail:
          'Divo has finished watching and wants to check what it understood.',
      }
    case 'stalled':
      return {
        headline: online ? 'Paused' : 'Waiting for the internet',
        detail: online
          ? 'Your recording is safe on this Mac. Nothing has been changed yet.'
          : 'Your recording is safe on this Mac. Divo will send it automatically once you are back online.',
      }
    case 'ready_to_send':
    default:
      return {
        headline: 'Saved, not sent yet',
        detail: 'Your recording is safe on this Mac. Send it when you are ready.',
      }
  }
}

/**
 * Fold one local recording plus whatever the backend knows into a work item.
 *
 * The local sidecar is trusted for "does this file still exist and what did we
 * last try", and the session is trusted for "what has actually happened".
 * Where they disagree the session wins, because the sidecar can be stale after
 * a crash — but the file is never treated as expendable either way.
 */
export function toTeachWorkItem(
  recording: TeachLocalRecording,
  session: TeachSession | undefined,
  {
    uploading,
    uploadPercent,
    online,
    stalledFor,
  }: {
    uploading: boolean
    uploadPercent?: number
    online: boolean
    /** Milliseconds since this session's progress last changed. */
    stalledFor?: number
  }
): TeachWorkItem {
  const base = {
    path: recording.path,
    fileName: recording.fileName,
    size: recording.size,
    sessionId: recording.sessionId,
    updatedAt: recording.updatedAt,
  }

  let phase: TeachWorkPhase
  let percent: number | null = null
  let problem = explainTeachProblem(recording.lastError)

  if (uploading) {
    phase = 'sending'
    percent = uploadPercent ?? null
    problem = null
  } else if (!session) {
    // No session yet, or the backend is unreachable and we only have the
    // sidecar. Either way the recording is intact and re-sendable.
    phase =
      recording.state === 'retryable'
        ? 'stalled'
        : recording.state === 'uploading' || recording.state === 'processing'
          ? 'thinking'
          : 'ready_to_send'
  } else if (isTeachSessionWaitingForYou(session)) {
    phase = 'needs_you'
    percent = 100
    problem = null
  } else if (THINKING_STATUSES.includes(session.status)) {
    phase = 'thinking'
    percent = session.progress
    problem = null
  } else if (session.status === 'awaiting_upload') {
    phase = online ? 'ready_to_send' : 'stalled'
  } else {
    // failed, cancelled, or a settled status whose file has not been cleaned
    // up yet. Nothing is in flight, so the manager decides what happens next.
    phase = 'stalled'
    problem = explainTeachProblem(session.lastError) ?? problem
  }

  // Divo says it is working but the number has not moved in a long time.
  // Saying so, and offering the retry, beats a bar that sits at 33% forever.
  const stuck =
    phase === 'thinking' &&
    online &&
    stalledFor !== undefined &&
    stalledFor >= TEACH_STUCK_AFTER_MS

  const copy = stuck
    ? {
      headline: 'This looks stuck',
      detail:
        'Divo has not made progress for a while. Your recording is safe — starting it again is usually enough.',
    }
    : describe(phase, percent, online)

  return {
    ...base,
    phase,
    percent,
    problem,
    headline: copy.headline,
    detail: copy.detail,
    canSend: phase === 'ready_to_send' || phase === 'stalled',
    canOpen: phase === 'needs_you',
    // Deleting mid-flight would pull the file out from under a live upload.
    canDelete: phase !== 'sending',
    canResume: stuck,
  }
}

export function toTeachWorkItems({
  recordings,
  sessions,
  uploading,
  uploadPercent,
  progressSeenAt,
  now,
  online,
}: TeachActivityInput): TeachWorkItem[] {
  return recordings.map((recording) => {
    const seenAt = recording.sessionId
      ? progressSeenAt[recording.sessionId]
      : undefined
    return toTeachWorkItem(
      recording,
      recording.sessionId ? sessions[recording.sessionId] : undefined,
      {
        uploading: Boolean(
          recording.sessionId && uploading.includes(recording.sessionId)
        ),
        uploadPercent: recording.sessionId
          ? uploadPercent[recording.sessionId]
          : undefined,
        ...(seenAt !== undefined ? { stalledFor: now - seenAt } : {}),
        online,
      }
    )
  })
}

export type TeachActivitySummary = {
  phase: TeachWorkPhase
  headline: string
  detail: string
  percent: number | null
  /** Present when opening a chat is the right next step. */
  sessionId: string | null
  /** How many pieces of Teach work are outstanding in total. */
  count: number
}

/** Most-urgent-first, so the one-line background chip shows the right thing. */
const PHASE_RANK: Record<TeachWorkPhase, number> = {
  recording: 0,
  needs_you: 1,
  sending: 2,
  thinking: 3,
  stalled: 4,
  ready_to_send: 5,
}

/**
 * The single line worth showing outside the Teach screen.
 *
 * Returns null when there is genuinely nothing in flight — the indicator has
 * to disappear completely rather than sit there saying "idle", or it stops
 * meaning anything when it does light up.
 */
export function summarizeTeachActivity(
  input: TeachActivityInput
): TeachActivitySummary | null {
  if (input.recorder.recording) {
    const copy = describe('recording', null, input.online)
    return {
      phase: 'recording',
      headline: copy.headline,
      detail: copy.detail,
      percent: null,
      sessionId: null,
      count: 1,
    }
  }

  const items = toTeachWorkItems(input)
  if (items.length === 0) return null

  const [first] = [...items].sort(
    (left, right) => PHASE_RANK[left.phase] - PHASE_RANK[right.phase]
  )
  if (!first) return null

  return {
    phase: first.phase,
    headline: first.headline,
    detail: first.detail,
    percent: first.percent,
    sessionId: first.canOpen ? first.sessionId : null,
    count: items.length,
  }
}

export function formatTeachBytes(bytes: number | null | undefined): string {
  if (!bytes) return 'Unknown size'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

export function formatTeachElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.max(0, Math.floor(seconds % 60))
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
