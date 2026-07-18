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
}))

const recording = {
  path: '/tmp/manager-demo.mov',
  fileName: 'manager-demo.mov',
  mimeType: 'video/quicktime' as const,
  size: 10 * 1024 * 1024,
  localOwned: false,
}

const teachSession = (status: 'awaiting_upload' | 'queued' | 'ready_for_processing') => ({
  id: 'teach-session-1',
  departmentId: 'department-1',
  source: 'upload' as const,
  status,
  progress: status === 'ready_for_processing' ? 100 : 25,
  originalFileName: recording.fileName,
  mimeType: recording.mimeType,
  fileSize: recording.size,
  lastError: null,
  canCancel: status !== 'ready_for_processing',
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
    h.getSession.mockResolvedValue(teachSession('ready_for_processing'))
  })

  it('requires a selected managed department before teaching', async () => {
    h.getStatus.mockResolvedValue({ configured: false })
    render(<TeachMode />)

    expect(await screen.findByText('Select a department you manage before starting Teach.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record teaching' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Upload recording' })).toBeDisabled()
  })

  it('uploads a selected recording and reaches the processing-ready state', async () => {
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
    expect(await screen.findByText('Teaching captured')).toBeInTheDocument()
    expect(screen.getByText(/prepared the screens, interface text and explanation/i)).toBeInTheDocument()
    expect(screen.getByText('manager-demo.mov')).toBeInTheDocument()
  })
})
