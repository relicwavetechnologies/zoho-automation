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

const teachSession = (status: 'awaiting_upload' | 'queued' | 'persona_updated' | 'no_learning') => ({
  id: 'teach-session-1',
  departmentId: 'department-1',
  source: 'upload' as const,
  status,
  progress: ['persona_updated', 'no_learning'].includes(status) ? 100 : 25,
  originalFileName: recording.fileName,
  mimeType: recording.mimeType,
  fileSize: recording.size,
  lastError: null,
  understanding: status === 'persona_updated'
    ? 'Divo learned how the manager reviews weekly reports.'
    : status === 'no_learning' ? 'No durable rule was clear enough to save.' : null,
  appliedChangeCount: status === 'persona_updated' ? 2 : 0,
  personaRevision: status === 'persona_updated' ? 3 : null,
  remainingUndos: status === 'persona_updated' ? 2 : 0,
  canCancel: !['persona_updated', 'no_learning'].includes(status),
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
    expect(await screen.findByText('Divo learned your workflow')).toBeInTheDocument()
    expect(screen.getByText(/reviews weekly reports/i)).toBeInTheDocument()
    expect(screen.getByText('2 persona rules updated')).toBeInTheDocument()
    expect(screen.getByText('manager-demo.mov')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Undo (2 left)' }))
    expect(h.undoPersona).toHaveBeenCalledWith('department-1')
    expect(await screen.findByText('Persona change undone.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo (1 left)' })).toBeInTheDocument()
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
