import { describe, expect, it } from 'vitest'

import {
  explainTeachProblem,
  isTransientTeachError,
  summarizeTeachActivity,
  teachReconnectDelayMs,
  TEACH_STUCK_AFTER_MS,
  toTeachWorkItem,
  type TeachActivityInput,
} from '../teach-activity'
import type { TeachLocalRecording, TeachSession } from '../divo-teach'

const recording = (
  overrides: Partial<TeachLocalRecording> = {}
): TeachLocalRecording => ({
  path: '/tmp/teach.mov',
  fileName: 'teach.mov',
  mimeType: 'video/quicktime',
  size: 10 * 1024 * 1024,
  localOwned: true,
  sessionId: 'teach-session-1',
  state: 'ready',
  lastError: null,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  ...overrides,
})

const session = (status: TeachSession['status']): TeachSession =>
  ({ id: 'teach-session-1', status, progress: 40, lastError: null }) as TeachSession

const input = (overrides: Partial<TeachActivityInput> = {}): TeachActivityInput => ({
  recorder: { recording: false, startedAt: null, fileName: null },
  recordings: [],
  sessions: {},
  uploading: [],
  uploadPercent: {},
  progressSeenAt: {},
  now: 1_000_000,
  online: true,
  ...overrides,
})

/**
 * This is the only place Teach decides what is happening to a recording, so it
 * is the only place worth testing that decision. The screen, the sidebar chip
 * and the toasts all read these results — testing the same logic again through
 * rendered copy would assert wording, not behaviour.
 */
describe('toTeachWorkItem', () => {
  it('treats a failed send as recoverable work, never as a lost recording', () => {
    const item = toTeachWorkItem(
      recording({ state: 'retryable', lastError: 'connection closed' }),
      session('awaiting_upload'),
      { uploading: false, online: true }
    )

    expect(item.phase).toBe('ready_to_send')
    expect(item.canSend).toBe(true)
    expect(item.canDelete).toBe(true)
  })

  it('refuses to offer delete while the file is being streamed', () => {
    // Deleting here would pull the video out from under a live upload.
    const item = toTeachWorkItem(recording(), session('awaiting_upload'), {
      uploading: true,
      uploadPercent: 42,
      online: true,
    })

    expect(item.phase).toBe('sending')
    expect(item.percent).toBe(42)
    expect(item.canDelete).toBe(false)
  })

  it('promises an offline recording sends itself, rather than blaming the user', () => {
    const item = toTeachWorkItem(recording(), session('awaiting_upload'), {
      uploading: false,
      online: false,
    })

    expect(item.phase).toBe('stalled')
    expect(item.detail).toMatch(/safe on this Mac/i)
    expect(item.detail).toMatch(/automatically once you are back online/i)
  })

  it('keeps a recording actionable when the backend cannot be reached at all', () => {
    // No session could be fetched. The sidecar is all we have, and it must
    // still produce something the manager can act on.
    const item = toTeachWorkItem(
      recording({ state: 'retryable', lastError: 'connection refused' }),
      undefined,
      { uploading: false, online: false }
    )

    expect(item.phase).toBe('stalled')
    expect(item.canSend).toBe(true)
    expect(item.problem).toMatch(/could not reach the internet/i)
  })

  it('stops animating stale progress once Divo goes unreachable', () => {
    // The last status read is not evidence that work is still happening. This
    // rendered "Divo is watching your recording 66%" directly beside a banner
    // saying Divo could not be reached.
    const online = toTeachWorkItem(recording(), session('ingesting'), {
      uploading: false,
      online: true,
    })
    const offline = toTeachWorkItem(recording(), session('ingesting'), {
      uploading: false,
      online: false,
    })

    expect(online.headline).toMatch(/watching your recording/i)
    expect(offline.headline).toMatch(/Waiting to reconnect/i)
    expect(offline.detail).toMatch(/picks up from here on its own/i)
  })

  it('offers a restart once Divo has stopped making progress', () => {
    // The reported case: a bar frozen at 33% with nothing the manager could do
    // but wait for a ten-minute server sweep they could not see.
    const moving = toTeachWorkItem(recording(), session('ingesting'), {
      uploading: false,
      online: true,
      stalledFor: 30_000,
    })
    const wedged = toTeachWorkItem(recording(), session('ingesting'), {
      uploading: false,
      online: true,
      stalledFor: TEACH_STUCK_AFTER_MS + 1,
    })

    expect(moving.canResume).toBe(false)
    expect(wedged.canResume).toBe(true)
    expect(wedged.headline).toMatch(/looks stuck/i)
  })

  it('does not call a session stuck merely because Divo is unreachable', () => {
    // Offline already has its own honest explanation, and restarting would
    // fail anyway. Offering it there would just be a button that does nothing.
    const offline = toTeachWorkItem(recording(), session('ingesting'), {
      uploading: false,
      online: false,
      stalledFor: TEACH_STUCK_AFTER_MS * 5,
    })

    expect(offline.canResume).toBe(false)
    expect(offline.headline).toMatch(/Waiting to reconnect/i)
  })

  it('surfaces a session that is waiting on the manager as something to open', () => {
    const item = toTeachWorkItem(recording(), session('evidence_ready'), {
      uploading: false,
      online: true,
    })

    expect(item.phase).toBe('needs_you')
    expect(item.canOpen).toBe(true)
    expect(item.problem).toBeNull()
  })
})

describe('summarizeTeachActivity', () => {
  it('shows nothing at all when Teach is idle', () => {
    // An indicator that is always present stops being read.
    expect(summarizeTeachActivity(input())).toBeNull()
  })

  it('puts a live recording above every other kind of work', () => {
    const summary = summarizeTeachActivity(
      input({
        recorder: { recording: true, startedAt: null, fileName: 'teach.mov' },
        recordings: [recording({ state: 'retryable' })],
      })
    )

    expect(summary?.phase).toBe('recording')
  })

  it('raises the recording Divo is waiting on above one still processing', () => {
    const summary = summarizeTeachActivity(
      input({
        recordings: [
          recording({ path: '/tmp/a.mov', sessionId: 'a' }),
          recording({ path: '/tmp/b.mov', sessionId: 'b' }),
        ],
        sessions: {
          a: { ...session('queued'), id: 'a' },
          b: { ...session('evidence_ready'), id: 'b' },
        },
      })
    )

    expect(summary?.phase).toBe('needs_you')
    expect(summary?.sessionId).toBe('b')
    expect(summary?.count).toBe(2)
  })
})

describe('reconnecting after the backend goes away', () => {
  it('probes quickly at first so a restarted backend is picked up in seconds', () => {
    expect(teachReconnectDelayMs(0)).toBe(2_000)
    expect(teachReconnectDelayMs(1)).toBeLessThan(teachReconnectDelayMs(2))
  })

  it('stops backing off at a ceiling instead of drifting towards never', () => {
    expect(teachReconnectDelayMs(4)).toBe(30_000)
    expect(teachReconnectDelayMs(99)).toBe(30_000)
  })

  it('treats a dropped connection as retryable and a rejected file as not', () => {
    // The first must never reach an error screen; the reconciler recovers it.
    expect(
      isTransientTeachError(
        new Error('Teach recording upload failed: tcp connect error: Connection refused')
      )
    ).toBe(true)
    expect(isTransientTeachError('Teach upload returned HTTP 503')).toBe(true)
    expect(isTransientTeachError('Teach upload returned HTTP 429')).toBe(true)
    // Retrying these only wastes the manager's bandwidth.
    expect(isTransientTeachError('Teach upload returned HTTP 413')).toBe(false)
    expect(isTransientTeachError('Teach upload returned HTTP 401')).toBe(false)
  })
})

describe('explainTeachProblem', () => {
  it('turns transport noise into something a manager can act on', () => {
    expect(
      explainTeachProblem(
        'error sending request for url (https://api.divo/video): connection closed'
      )
    ).toMatch(/could not reach the internet/i)
    expect(explainTeachProblem('Teach upload returned HTTP 413')).toMatch(
      /too large/i
    )
    expect(explainTeachProblem(null)).toBeNull()
  })
})
