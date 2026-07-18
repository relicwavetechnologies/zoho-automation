import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TeachMode } from './TeachMode'

const h = vi.hoisted(() => ({
  cancelRecording: vi.fn(),
  cancelSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getStatus: vi.fn(),
  listen: vi.fn(),
  pickRecording: vi.fn(),
  recordScreen: vi.fn(),
  refineSession: vi.fn(),
  uploadRecording: vi.fn(),
  undoPersona: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: h.listen,
}))

vi.mock('@/lib/divo-teach', () => ({
  cancelTeachRecording: h.cancelRecording,
  cancelTeachSession: h.cancelSession,
  createTeachSession: h.createSession,
  getDivoSessionStatus: h.getStatus,
  getTeachSession: h.getSession,
  pickTeachRecording: h.pickRecording,
  recordTeachScreen: h.recordScreen,
  refineTeachSession: h.refineSession,
  uploadTeachRecording: h.uploadRecording,
  undoManagerPersona: h.undoPersona,
}))

const recording = {
  path: '/tmp/manager-demo.mov',
  fileName: 'manager-demo.mov',
  mimeType: 'video/quicktime' as const,
  size: 10 * 1024 * 1024,
  localOwned: false,
}

const teachSession = (status: 'awaiting_upload' | 'queued' | 'persona_processing' | 'persona_updated' | 'no_learning' | 'failed') => ({
  id: 'teach-session-1',
  departmentId: 'department-1',
  source: 'upload' as const,
  status,
  progress: ['persona_updated', 'no_learning'].includes(status) ? 100 : status === 'persona_processing' ? 80 : status === 'failed' ? 75 : 25,
  processingStep: ['persona_updated', 'no_learning'].includes(status)
    ? 'complete' as const
    : status === 'persona_processing' ? 'deepseek_reviewing' as const
      : status === 'failed' ? 'failed' as const : status === 'awaiting_upload' ? 'awaiting_upload' as const : 'recording_received' as const,
  originalFileName: recording.fileName,
  mimeType: recording.mimeType,
  fileSize: recording.size,
  lastError: status === 'failed' ? 'Failed to process successful response' : null,
  understanding: status === 'persona_updated'
    ? 'Divo learned how the manager reviews weekly reports.'
    : status === 'no_learning' ? 'No durable rule was clear enough to save.' : null,
  appliedChanges: status === 'persona_updated' ? [
    {
      operation: 'add' as const,
      kind: 'workflow',
      scopeKey: 'reporting.weekly',
      ruleKey: 'weekly-report.review',
      instruction: 'Review weekly reports with risks first.',
      confidence: 0.97,
      evidenceRefs: ['transcript:1', 'frame:2'],
    },
    {
      operation: 'add' as const,
      kind: 'preference',
      scopeKey: 'reporting.weekly',
      ruleKey: 'weekly-report.concise',
      instruction: 'Keep the review concise.',
      confidence: 0.94,
      evidenceRefs: ['transcript:1'],
    },
  ] : [],
  evidence: {
    durationSeconds: 74,
    frameCount: 8,
    transcriptSegmentCount: 2,
    warningCount: 0,
    transcriptionProvider: 'openai',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    ocrModels: ['qwen/qwen2.5-vl-32b-instruct'],
  },
  modelProvider: status === 'persona_updated' ? 'deepseek' : null,
  modelId: status === 'persona_updated' ? 'deepseek-v4-pro' : null,
  parentSessionId: null,
  managerCorrection: null,
  appliedChangeCount: status === 'persona_updated' ? 2 : 0,
  personaRevision: status === 'persona_updated' ? 3 : null,
  remainingUndos: status === 'persona_updated' ? 2 : 0,
  canCancel: !['persona_updated', 'no_learning', 'failed'].includes(status),
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
})

describe('TeachMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.listen.mockResolvedValue(vi.fn())
    h.cancelRecording.mockResolvedValue(undefined)
    h.cancelSession.mockResolvedValue(teachSession('queued'))
    h.getStatus.mockResolvedValue({ configured: true, departmentId: 'department-1' })
    h.pickRecording.mockResolvedValue(recording)
    h.createSession.mockResolvedValue(teachSession('awaiting_upload'))
    h.uploadRecording.mockResolvedValue(teachSession('queued'))
    h.getSession.mockResolvedValue(teachSession('persona_updated'))
    h.refineSession.mockResolvedValue({
      ...teachSession('persona_processing'),
      id: 'teach-session-2',
      parentSessionId: 'teach-session-1',
      managerCorrection: 'Put risks first only for executive reports.',
    })
    h.undoPersona.mockResolvedValue({ revision: 4, remainingUndos: 1 })
  })

  it('requires a selected managed department before teaching', async () => {
    h.getStatus.mockResolvedValue({ configured: false })
    render(<TeachMode />)

    expect(await screen.findByText('Select a department you manage before starting Teach.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record teaching' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Upload recording' })).toBeDisabled()
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

  it('uploads a selected recording, learns persona rules and supports Undo', async () => {
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
    expect(await screen.findByText('2 persona rules updated')).toBeInTheDocument()
    expect(screen.getByText(/reviews weekly reports/i)).toBeInTheDocument()
    expect(screen.getByText('Review weekly reports with risks first.')).toBeInTheDocument()
    expect(screen.getByText('deepseek-v4-pro')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Undo (2 left)' }))
    expect(h.undoPersona).toHaveBeenCalledWith('department-1')
    expect(await screen.findByText('Persona change undone.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo (1 left)' })).toBeInTheDocument()
  })

  it('creates a linked real refinement from the result correction bar', async () => {
    h.getSession.mockImplementation(async (sessionId: string) => sessionId === 'teach-session-2'
      ? {
          ...teachSession('persona_processing'),
          id: 'teach-session-2',
          parentSessionId: 'teach-session-1',
          managerCorrection: 'Put risks first only for executive reports.',
        }
      : teachSession('persona_updated'))
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)
    expect(await screen.findByText('2 persona rules updated')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Refine what Divo learned' }), 'Put risks first only for executive reports.')
    await user.click(screen.getByRole('button', { name: 'Send correction' }))

    expect(h.refineSession).toHaveBeenCalledWith('teach-session-1', 'Put risks first only for executive reports.')
    expect(await screen.findByText('Learning from your demonstration')).toBeInTheDocument()
    expect(screen.getByText(/Refining the prior result/)).toBeInTheDocument()
  })

  it('shows a clean no-learning result without an Undo action', async () => {
    h.getSession.mockResolvedValue(teachSession('no_learning'))
    const user = userEvent.setup()
    render(<TeachMode />)

    const uploadButton = await screen.findByRole('button', { name: 'Upload recording' })
    await waitFor(() => expect(uploadButton).toBeEnabled())
    await user.click(uploadButton)

    expect(await screen.findByText('Teaching reviewed')).toBeInTheDocument()
    expect(screen.getByText(/no durable rule was clear enough/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument()
  })
})
