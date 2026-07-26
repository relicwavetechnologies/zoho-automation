import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  cancelRecording: vi.fn(),
  cancelSession: vi.fn(),
  createSession: vi.fn(),
  deleteLocal: vi.fn(),
  getSession: vi.fn(),
  getPersonaTree: vi.fn(),
  getStatus: vi.fn(),
  listRecent: vi.fn(),
  pickRecording: vi.fn(),
  recordScreen: vi.fn(),
  resumeSession: vi.fn(),
  stopRecording: vi.fn(),
  undoPersona: vi.fn(),
  uploadRecording: vi.fn(),
  navigate: vi.fn(),
  ensureConversation: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: h.navigate }),
}))

vi.mock('@/lib/divo-teach-thread', () => ({
  ensureDivoTeachConversation: h.ensureConversation,
}))

vi.mock('@/lib/divo-teach', () => ({
  cancelTeachRecording: h.cancelRecording,
  cancelTeachSession: h.cancelSession,
  createTeachSession: h.createSession,
  deleteLocalTeachRecording: h.deleteLocal,
  getDivoSessionStatus: h.getStatus,
  getTeachSession: h.getSession,
  getManagerPersonaTree: h.getPersonaTree,
  listRecentTeachLearnings: h.listRecent,
  pickTeachRecording: h.pickRecording,
  recordTeachScreen: h.recordScreen,
  resumeTeachSession: h.resumeSession,
  stopTeachRecording: h.stopRecording,
  undoManagerPersona: h.undoPersona,
  uploadTeachRecording: h.uploadRecording,
}))

import { TeachMode } from './TeachMode'
import { useTeachActivity } from '@/hooks/useTeachActivity'

const recording = {
  path: '/tmp/manager-demo.mov',
  fileName: 'manager-demo.mov',
  mimeType: 'video/quicktime' as const,
  size: 10 * 1024 * 1024,
  localOwned: false,
}

const localRecording = (overrides: Record<string, unknown> = {}) => ({
  ...recording,
  localOwned: true,
  sessionId: 'teach-session-1',
  state: 'retryable',
  lastError: null,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  ...overrides,
})

const teachSession = (status: string) =>
  ({
    id: 'teach-session-1',
    departmentId: 'department-1',
    source: 'upload',
    status,
    progress: status === 'persona_updated' ? 100 : 25,
    processingStep:
      status === 'evidence_ready' ? 'evidence_ready' : 'recording_received',
    originalFileName: recording.fileName,
    mimeType: recording.mimeType,
    fileSize: recording.size,
    lastError: null,
    understanding:
      status === 'persona_updated'
        ? 'Divo learned how the manager reviews weekly reports.'
        : null,
    appliedChanges:
      status === 'persona_updated'
        ? [
            {
              operation: 'create',
              kind: 'workflow',
              scopeKey: 'reporting.weekly',
              ruleKey: 'weekly-report.review',
              instruction: 'Review weekly reports with risks first.',
              confidence: 0.97,
              evidenceRefs: [],
            },
          ]
        : [],
    appliedSkills: [],
    evidence: null,
    modelProvider: null,
    modelId: null,
    parentSessionId: null,
    managerCorrection: null,
    appliedChangeCount: status === 'persona_updated' ? 1 : 0,
    personaRevision: status === 'persona_updated' ? 3 : null,
    remainingUndos: status === 'persona_updated' ? 2 : 0,
    canCancel: status !== 'persona_updated',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }) as never

const resetActivity = (overrides: Record<string, unknown> = {}) =>
  useTeachActivity.setState({
    recorder: { recording: false, startedAt: null, fileName: null },
    recordings: [],
    sessions: {},
    uploading: [],
    uploadPercent: {},
    progressSeenAt: {},
    online: true,
    ...overrides,
  })

/**
 * Only behaviour that needs a rendered component to prove is tested here.
 * How a recording's state is decided lives in `teach-activity`, and is tested
 * directly there — re-asserting it through rendered copy would test wording.
 */
describe('TeachMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetActivity()
    h.getStatus.mockResolvedValue({
      configured: true,
      departmentId: 'department-1',
    })
    h.listRecent.mockResolvedValue([])
    h.getPersonaTree.mockResolvedValue(null)
    h.ensureConversation.mockResolvedValue({ id: 'thread-1', title: 'Teach: demo' })
    h.createSession.mockResolvedValue(teachSession('awaiting_upload'))
    h.uploadRecording.mockResolvedValue(teachSession('queued'))
    h.stopRecording.mockResolvedValue(true)
  })

  it('separates being unable to reach Divo from not managing a department', async () => {
    // One message for both used to send people hunting through department
    // settings for what was actually a dropped connection.
    h.getStatus.mockRejectedValue(new Error('connection refused'))
    render(<TeachMode />)

    expect(
      await screen.findByText(/Divo cannot be reached right now/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/department you manage/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('start-teach-recording')).toBeDisabled()
  })

  it('shows a live recording when Teach is reopened from another screen', async () => {
    // Nothing in this component started it. Teach is a mode toggle that
    // unmounts on any other click, so without the shared store the manager
    // came back to an idle launcher over a running recorder.
    resetActivity({
      recorder: {
        recording: true,
        startedAt: new Date().toISOString(),
        fileName: 'teach-abc.mov',
      },
    })
    render(<TeachMode />)

    expect(await screen.findByText('Recording your screen')).toBeInTheDocument()
    expect(screen.getByTestId('stop-teach-recording')).toBeInTheDocument()
  })

  it('keeps the recording when the manager stops it', async () => {
    // Stopping and discarding were the same action, so the one button on
    // screen destroyed the demonstration the manager had just given.
    resetActivity({
      recorder: { recording: true, startedAt: null, fileName: 'teach-abc.mov' },
    })
    render(<TeachMode />)

    await userEvent.click(await screen.findByTestId('stop-teach-recording'))

    expect(h.stopRecording).toHaveBeenCalled()
    expect(h.cancelRecording).not.toHaveBeenCalled()
  })

  it('asks before throwing a running recording away', async () => {
    resetActivity({
      recorder: { recording: true, startedAt: null, fileName: 'teach-abc.mov' },
    })
    render(<TeachMode />)

    await userEvent.click(
      await screen.findByRole('button', { name: /Discard this recording/i })
    )
    expect(h.cancelRecording).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /Discard it/i }))
    expect(h.cancelRecording).toHaveBeenCalled()
  })

  it('asks before permanently deleting a recording from this Mac', async () => {
    resetActivity({ recordings: [localRecording()] })
    render(<TeachMode />)

    await userEvent.click(
      await screen.findByRole('button', { name: /Delete manager-demo\.mov/i })
    )
    expect(h.deleteLocal).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /Delete recording/i }))
    await waitFor(() => {
      expect(h.deleteLocal).toHaveBeenCalledWith('/tmp/manager-demo.mov')
    })
  })

  it('keeps a dropped connection on the waiting screen instead of calling it a failure', async () => {
    // Restarting the backend mid-send must not produce an error screen: Divo
    // holds a local copy and the reconciler is already retrying it.
    h.pickRecording.mockResolvedValue({ ...recording, localOwned: true })
    h.uploadRecording.mockRejectedValue(
      new Error('Teach recording upload failed: tcp connect error: Connection refused')
    )
    render(<TeachMode />)

    await userEvent.click(await screen.findByTestId('upload-teach-recording'))

    expect(
      await screen.findByText(/Divo keeps trying on its own/i)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Could not send your recording/i)
    ).not.toBeInTheDocument()
    expect(h.cancelSession).not.toHaveBeenCalled()
  })

  it('states the recording survived a rejected send, and can retry it', async () => {
    h.pickRecording.mockResolvedValue(recording)
    h.uploadRecording.mockRejectedValue(
      new Error('Teach upload returned HTTP 413')
    )
    render(<TeachMode />)

    await userEvent.click(await screen.findByTestId('upload-teach-recording'))

    expect(
      await screen.findByText(/Could not send your recording/i)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Your recording is safe on this Mac/i)
    ).toBeInTheDocument()

    h.uploadRecording.mockResolvedValue(teachSession('queued'))
    await userEvent.click(screen.getByRole('button', { name: /Send it again/i }))
    await waitFor(() => {
      expect(h.uploadRecording).toHaveBeenCalledTimes(2)
    })
  })

  it('cancels a half-started session only when Divo holds no copy of the video', async () => {
    // With no local copy there is nothing to retry, so the empty session is
    // cleaned up. The transient case above proves the opposite branch.
    h.pickRecording.mockResolvedValue(recording)
    h.uploadRecording.mockRejectedValue(
      new Error('Teach upload returned HTTP 413')
    )
    render(<TeachMode />)

    await userEvent.click(await screen.findByTestId('upload-teach-recording'))
    await screen.findByText(/Could not send your recording/i)

    expect(h.cancelSession).toHaveBeenCalledWith('teach-session-1')
  })

  it('hands off to the standard chat route once evidence is ready', async () => {
    h.pickRecording.mockResolvedValue(recording)
    render(<TeachMode />)
    await userEvent.click(await screen.findByTestId('upload-teach-recording'))
    await screen.findByTestId('teach-processing-experience')

    // The background engine publishes the new status; this screen reacts to it
    // rather than polling for it.
    useTeachActivity.getState().mergeSession(teachSession('evidence_ready'))

    await waitFor(() => {
      expect(h.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ params: { threadId: 'thread-1' } })
      )
    })
  })

  it('does not present a dropped connection as a failed teaching', async () => {
    h.pickRecording.mockResolvedValue(recording)
    render(<TeachMode />)
    await userEvent.click(await screen.findByTestId('upload-teach-recording'))
    await screen.findByTestId('teach-processing-experience')

    useTeachActivity.setState({ online: false })

    expect(
      await screen.findByText(/pick up again automatically/i)
    ).toBeInTheDocument()
    expect(screen.getByTestId('teach-processing-experience')).toBeInTheDocument()
  })

  it('opens the waiting conversation for a recording Divo needs help with', async () => {
    resetActivity({
      recordings: [localRecording({ state: 'agent_ready' })],
      sessions: { 'teach-session-1': teachSession('evidence_ready') },
    })
    render(<TeachMode />)

    await userEvent.click(
      await screen.findByRole('button', { name: /Open the chat/i })
    )

    await waitFor(() => {
      expect(h.ensureConversation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'teach-session-1' })
      )
    })
  })

  it('lets the manager restart an ingestion that stopped moving', async () => {
    // A frozen progress bar with no way out was the reported problem. The
    // server's own sweep waits ten minutes; this is the manual way out.
    resetActivity({
      recordings: [localRecording({ state: 'processing' })],
      sessions: { 'teach-session-1': teachSession('ingesting') },
      progressSeenAt: { 'teach-session-1': Date.now() - 5 * 60_000 },
    })
    h.resumeSession.mockResolvedValue(teachSession('queued'))
    render(<TeachMode />)

    expect(await screen.findByText(/This looks stuck/i)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('resume-teach-recording'))

    await waitFor(() => {
      expect(h.resumeSession).toHaveBeenCalledWith('teach-session-1')
    })
  })

  it('offers undo on only the newest session, because undo pops a stack', async () => {
    // Undo reverts the whole persona one revision. Offering it per row would
    // silently revert a different session's changes.
    h.listRecent.mockResolvedValue([
      teachSession('persona_updated'),
      { ...(teachSession('persona_updated') as object), id: 'teach-session-0' },
    ])
    render(<TeachMode />)

    expect(
      await screen.findByText(/Only the most recent session can be undone/i)
    ).toBeInTheDocument()
  })

  it('undoes a learning only after confirmation', async () => {
    h.listRecent.mockResolvedValue([teachSession('persona_updated')])
    h.undoPersona.mockResolvedValue({ revision: 2, remainingUndos: 1 })
    render(<TeachMode />)

    await userEvent.click(
      await screen.findByRole('button', { name: /Undo this session/i })
    )
    expect(h.undoPersona).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: /^Undo this session$/i })
    )
    await waitFor(() => {
      expect(h.undoPersona).toHaveBeenCalledWith('department-1')
    })
  })
})
