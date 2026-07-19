import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TeachMode } from './TeachMode'

const h = vi.hoisted(() => ({
  cancelRecording: vi.fn(),
  cancelSession: vi.fn(),
  createSession: vi.fn(),
  deleteLocal: vi.fn(),
  getSession: vi.fn(),
  getPersonaTree: vi.fn(),
  getStatus: vi.fn(),
  finalizeLocal: vi.fn(),
  listLocal: vi.fn(),
  listRecent: vi.fn(),
  listen: vi.fn(),
  pickRecording: vi.fn(),
  recordScreen: vi.fn(),
  undoPersona: vi.fn(),
  uploadRecording: vi.fn(),
  navigate: vi.fn(),
  ensureConversation: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: h.listen,
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
  finalizeLocalTeachRecording: h.finalizeLocal,
  listLocalTeachRecordings: h.listLocal,
  listRecentTeachLearnings: h.listRecent,
  pickTeachRecording: h.pickRecording,
  recordTeachScreen: h.recordScreen,
  undoManagerPersona: h.undoPersona,
  uploadTeachRecording: h.uploadRecording,
}))

const recording = {
  path: '/tmp/manager-demo.mov',
  fileName: 'manager-demo.mov',
  mimeType: 'video/quicktime' as const,
  size: 10 * 1024 * 1024,
  localOwned: false,
}

const teachSession = (status: 'awaiting_upload' | 'queued' | 'evidence_ready' | 'agent_processing' | 'completed' | 'persona_processing' | 'persona_updated' | 'no_learning' | 'failed') => ({
  id: 'teach-session-1',
  departmentId: 'department-1',
  source: 'upload' as const,
  status,
  progress: ['completed', 'persona_updated', 'no_learning'].includes(status) ? 100 : ['agent_processing', 'persona_processing'].includes(status) ? 80 : status === 'failed' ? 75 : 25,
  processingStep: ['completed', 'persona_updated', 'no_learning'].includes(status)
    ? 'complete' as const
    : ['agent_processing', 'persona_processing'].includes(status) ? 'agent_reasoning' as const
      : status === 'evidence_ready' ? 'evidence_ready' as const
      : status === 'failed' ? 'failed' as const : status === 'awaiting_upload' ? 'awaiting_upload' as const : 'recording_received' as const,
  originalFileName: recording.fileName,
  mimeType: recording.mimeType,
  fileSize: recording.size,
  lastError: status === 'failed' ? 'Failed to process successful response' : null,
  understanding: ['completed', 'persona_updated'].includes(status)
    ? 'Divo learned how the manager reviews weekly reports.'
    : status === 'no_learning' ? 'No durable rule was clear enough to save.' : null,
  appliedChanges: ['completed', 'persona_updated'].includes(status) ? [
    {
      operation: 'create' as const,
      kind: 'workflow',
      scopeKey: 'reporting.weekly',
      ruleKey: 'weekly-report.review',
      instruction: 'Review weekly reports with risks first.',
      confidence: 0.97,
      evidenceRefs: ['transcript:1', 'frame:2'],
    },
    {
      operation: 'create' as const,
      kind: 'preference',
      scopeKey: 'reporting.weekly',
      ruleKey: 'weekly-report.concise',
      instruction: 'Keep the review concise.',
      confidence: 0.94,
      evidenceRefs: ['transcript:1'],
    },
  ] : [],
  appliedSkills: [],
  evidence: {
    durationSeconds: 74,
    frameCount: 8,
    transcriptSegmentCount: 2,
    warningCount: 0,
    transcriptionProvider: 'openai',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    ocrModels: ['qwen/qwen2.5-vl-32b-instruct'],
  },
  modelProvider: ['completed', 'persona_updated'].includes(status) ? 'deepseek' : null,
  modelId: ['completed', 'persona_updated'].includes(status) ? 'deepseek-v4-pro' : null,
  parentSessionId: null,
  managerCorrection: null,
  appliedChangeCount: ['completed', 'persona_updated'].includes(status) ? 2 : 0,
  personaRevision: ['completed', 'persona_updated'].includes(status) ? 3 : null,
  remainingUndos: ['completed', 'persona_updated'].includes(status) ? 2 : 0,
  canCancel: !['completed', 'persona_updated', 'no_learning', 'failed'].includes(status),
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
})

describe('TeachMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.listen.mockResolvedValue(vi.fn())
    h.cancelRecording.mockResolvedValue(undefined)
    h.cancelSession.mockResolvedValue(teachSession('queued'))
    h.deleteLocal.mockResolvedValue(undefined)
    h.getStatus.mockResolvedValue({ configured: true, departmentId: 'department-1' })
    h.finalizeLocal.mockResolvedValue(undefined)
    h.listLocal.mockResolvedValue([])
    h.listRecent.mockResolvedValue([])
    h.pickRecording.mockResolvedValue(recording)
    h.createSession.mockResolvedValue(teachSession('awaiting_upload'))
    h.uploadRecording.mockResolvedValue(teachSession('queued'))
    h.getSession.mockResolvedValue(teachSession('completed'))
    h.getPersonaTree.mockResolvedValue(null)
    h.undoPersona.mockResolvedValue({ revision: 2, remainingUndos: 1 })
    h.navigate.mockResolvedValue(undefined)
    h.ensureConversation.mockResolvedValue({
      id: 'normal-teach-thread-1',
      title: 'Teach: manager-demo',
      metadata: {
        divoTeachProfile: {
          kind: 'teach',
          teachSessionId: 'teach-session-1',
          departmentId: 'department-1',
        },
      },
    })
    sessionStorage.clear()
  })

  it('requires a selected managed department before teaching', async () => {
    h.getStatus.mockResolvedValue({ configured: false })
    render(<TeachMode />)

    expect(await screen.findByText('Select a department you manage before starting Teach.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record teaching' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Upload recording' })).toBeDisabled()
  })

  it('shows retryable local recordings and recent database learnings', async () => {
    const localRecording = {
      ...recording,
      path: '/tmp/local-teach.mov',
      fileName: 'local-teach.mov',
      localOwned: true,
      sessionId: null,
      state: 'ready' as const,
      lastError: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }
    h.listLocal.mockResolvedValue([localRecording])
    h.listRecent.mockResolvedValue([teachSession('persona_updated')])
    h.getPersonaTree.mockResolvedValue({
      revision: 4,
      updatedAt: '2026-07-18T00:00:00.000Z',
      nodes: [{
        id: 'persona-node-1',
        kind: 'workflow',
        scopeKey: 'data-presentation',
        ruleKey: 'html-dashboard',
        instruction: 'Create an HTML dashboard when data benefits from visual review.',
        confidence: 0.97,
        learningSources: [{
          source: 'teach',
          sourceId: 'teach-session-1',
          decision: 'create',
          rationale: 'The manager explicitly demonstrated this presentation preference.',
          evidenceRefs: ['transcript:1'],
          learnedAt: '2026-07-18T00:00:00.000Z',
        }],
        linkedSkills: [{
          id: 'skill-1',
          slug: 'cursor-design-html-dashboard',
          name: 'Cursor Design HTML Dashboard',
          summary: 'Build a dashboard.',
          revision: 1,
          toolIds: ['dataProcessor'],
        }],
      }],
    })
    const user = userEvent.setup()
    render(<TeachMode />)

    expect(await screen.findByText('local-teach.mov')).toBeInTheDocument()
    expect(screen.getByText('Recent Teach learnings')).toBeInTheDocument()
    expect(screen.getByText('Department persona graph')).toBeInTheDocument()
    expect(screen.getByText('Cursor Design HTML Dashboard')).toBeInTheDocument()
    expect(screen.getAllByText('html-dashboard')).toHaveLength(2)
    expect(screen.getByText('97% confidence')).toBeInTheDocument()
    expect(screen.getByText('Learned from')).toBeInTheDocument()
    expect(screen.getByText('Review weekly reports with risks first.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(h.createSession).toHaveBeenCalledWith('department-1', 'recording', localRecording)
    expect(h.uploadRecording).toHaveBeenCalledWith('teach-session-1', localRecording)
  })

  it('confirms before permanently deleting a local recording', async () => {
    h.listLocal.mockResolvedValue([{
      ...recording,
      path: '/tmp/delete-me.mov',
      fileName: 'delete-me.mov',
      localOwned: true,
      sessionId: null,
      state: 'ready',
      lastError: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }])
    const user = userEvent.setup()
    render(<TeachMode />)

    await user.click(await screen.findByRole('button', { name: 'Delete delete-me.mov' }))
    expect(screen.getByText('Delete local recording?')).toBeInTheDocument()
    expect(h.deleteLocal).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete recording' }))
    expect(h.deleteLocal).toHaveBeenCalledWith('/tmp/delete-me.mov')
    await waitFor(() => expect(screen.queryByText('delete-me.mov')).not.toBeInTheDocument())
  })

  it('starts the native recorder and gives actionable permission guidance on failure', async () => {
    h.recordScreen.mockRejectedValue('macOS screen recorder failed')
    const user = userEvent.setup()
    render(<TeachMode />)

    const recordButton = await screen.findByRole('button', { name: 'Record teaching' })
    await waitFor(() => expect(recordButton).toBeEnabled())
    await user.click(recordButton)

    expect(h.recordScreen).toHaveBeenCalledOnce()
    expect(await screen.findByText('Screen recorder could not start')).toBeInTheDocument()
    expect(screen.getByText(/Screen & System Audio Recording and Microphone access/)).toBeInTheDocument()
  })

  it('does not cancel an active native recording when Teach is unmounted', async () => {
    h.recordScreen.mockReturnValue(new Promise(() => undefined))
    const user = userEvent.setup()
    const view = render(<TeachMode />)

    const recordButton = await screen.findByRole('button', { name: 'Record teaching' })
    await waitFor(() => expect(recordButton).toBeEnabled())
    await user.click(recordButton)
    expect(await screen.findByText('Recording in progress')).toBeInTheDocument()

    view.unmount()

    expect(h.cancelRecording).not.toHaveBeenCalled()
  })

  it('states that upload failed without blaming the completed recording', async () => {
    h.createSession.mockRejectedValue('Teach service unavailable')
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    expect(await screen.findByText('Upload failed')).toBeInTheDocument()
    expect(screen.getByText(/recording was completed and saved locally/i)).toBeInTheDocument()
    expect(screen.queryByText('Recording not prepared')).not.toBeInTheDocument()
  })

  it('states that persona processing failed after a successful recording upload', async () => {
    h.getSession.mockResolvedValue(teachSession('failed'))
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    expect(await screen.findByText('Persona update failed')).toBeInTheDocument()
    expect(screen.getByText(/recording was processed.*could not validate/i)).toBeInTheDocument()
    expect(screen.queryByText('Recording not prepared')).not.toBeInTheDocument()
  })

  it('shows that processing status is unknown when polling loses connection', async () => {
    h.getSession.mockRejectedValue('database unavailable')
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    expect(await screen.findByText(/Status temporarily unavailable/)).toBeInTheDocument()
    expect(screen.getByText(/has not reported success or failure yet/)).toBeInTheDocument()
  })

  it('uploads a selected recording and hands it to a persistent normal chat thread', async () => {
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    expect(h.createSession).toHaveBeenCalledWith('department-1', 'upload', recording)
    expect(h.uploadRecording).toHaveBeenCalledWith('teach-session-1', recording)
    await act(async () => {
      await vi.waitFor(() => expect(h.getSession).toHaveBeenCalledWith('teach-session-1'))
    })
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'normal-teach-thread-1' },
    }))
    expect(h.ensureConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'teach-session-1' })
    )
  })

  it('removes a Divo-owned recording only after persona processing succeeds', async () => {
    const ownedRecording = { ...recording, localOwned: true }
    h.recordScreen.mockResolvedValue(ownedRecording)
    const user = userEvent.setup()
    render(<TeachMode />)

    const recordButton = await screen.findByRole('button', { name: 'Record teaching' })
    await waitFor(() => expect(recordButton).toBeEnabled())
    await user.click(recordButton)

    await waitFor(() => expect(h.finalizeLocal).toHaveBeenCalledWith(ownedRecording.path, 'teach-session-1'))
  })

  it('moves into the standard chat route after evidence is ready', async () => {
    h.getSession.mockResolvedValue(teachSession('evidence_ready'))
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'normal-teach-thread-1' },
    }))
    expect(screen.queryByTestId('teach-agent-chat')).not.toBeInTheDocument()
  })

  it('reopens an existing Teach thread instead of creating a duplicate conversation', async () => {
    h.ensureConversation.mockResolvedValue({ id: 'existing-teach-thread' })
    h.getSession.mockResolvedValue(teachSession('evidence_ready'))
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'existing-teach-thread' },
    }))
    expect(h.ensureConversation).toHaveBeenCalledOnce()
  })

  it('undoes the most recent learning only after confirmation', async () => {
    h.listRecent.mockResolvedValue([teachSession('persona_updated')])
    const user = userEvent.setup()
    render(<TeachMode />)

    await user.click(await screen.findByRole('button', { name: /Undo this learning/ }))
    expect(h.undoPersona).not.toHaveBeenCalled()
    // Undo rolls the whole department persona back a revision, so the dialog
    // has to say so rather than implying a single row is being removed.
    expect(screen.getByText(/rolls back to the revision before this/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Undo learning' }))
    expect(h.undoPersona).toHaveBeenCalledWith('department-1')
  })

  it('offers undo on only the newest learning, because undo pops a stack', async () => {
    // The backend endpoint is POST /persona/{department}/undo — it reverts the
    // latest revision, not an addressable session. Offering it on an older row
    // would silently revert someone else's newer change.
    const newer = { ...teachSession('persona_updated'), id: 'newer', updatedAt: '2026-07-19T00:00:00.000Z' }
    const older = { ...teachSession('persona_updated'), id: 'older', updatedAt: '2026-07-17T00:00:00.000Z' }
    h.listRecent.mockResolvedValue([newer, older])
    render(<TeachMode />)

    expect(await screen.findAllByText(/Only the most recent learning can be undone/)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Undo this learning/ })).toHaveLength(1)
  })

  it('hides undo when the session has no undos left', async () => {
    h.listRecent.mockResolvedValue([
      { ...teachSession('persona_updated'), remainingUndos: 0 },
    ])
    render(<TeachMode />)

    expect(await screen.findByText('No undos remaining')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Undo this learning/ })).not.toBeInTheDocument()
  })

  it('keeps the persona unchanged and says so when undo fails', async () => {
    h.listRecent.mockResolvedValue([teachSession('persona_updated')])
    h.undoPersona.mockRejectedValue('persona service unavailable')
    const user = userEvent.setup()
    render(<TeachMode />)

    await user.click(await screen.findByRole('button', { name: /Undo this learning/ }))
    await user.click(screen.getByRole('button', { name: 'Undo learning' }))

    expect(
      await screen.findByText('That learning could not be undone. Your persona is unchanged.')
    ).toBeInTheDocument()
  })

  it('lets a failed recorder retry in place instead of returning to the start', async () => {
    h.recordScreen.mockRejectedValue('macOS screen recorder failed')
    const user = userEvent.setup()
    render(<TeachMode />)

    const recordButton = await screen.findByRole('button', { name: 'Record teaching' })
    await waitFor(() => expect(recordButton).toBeEnabled())
    await user.click(recordButton)

    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(h.recordScreen).toHaveBeenCalledTimes(2)
  })

  it('tells the user the recording survived an upload failure, and retries it', async () => {
    h.createSession.mockRejectedValueOnce('Teach service unavailable')
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    expect(await screen.findByText('Upload failed')).toBeInTheDocument()
    expect(screen.getByText(/Your recording is safe on this Mac/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry upload' }))
    expect(h.createSession).toHaveBeenCalledTimes(2)
  })

  it('explains the flow in a dialog instead of a permanent panel', async () => {
    const user = userEvent.setup()
    h.listRecent.mockResolvedValue([teachSession('persona_updated')])
    render(<TeachMode />)

    await user.click(await screen.findByRole('button', { name: 'How it works' }))
    expect(await screen.findByText('How Teach works')).toBeInTheDocument()
    expect(
      screen.getByText(/Nothing is recorded in the background/)
    ).toBeInTheDocument()
  })
})
