import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  ensureConversation: vi.fn(),
  finalizeLocal: vi.fn(),
  getSession: vi.fn(),
  isUploadActive: vi.fn(),
  listLocal: vi.fn(),
  upload: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/lib/divo-teach-thread', () => ({
  ensureDivoTeachConversation: h.ensureConversation,
}))

vi.mock('@/lib/divo-teach', () => ({
  finalizeLocalTeachRecording: h.finalizeLocal,
  getTeachSession: h.getSession,
  isTeachUploadActive: h.isUploadActive,
  listLocalTeachRecordings: h.listLocal,
  uploadTeachRecording: h.upload,
}))

vi.mock('sonner', () => ({
  toast: { success: h.toastSuccess },
}))

import { TeachReliabilityProvider } from '../TeachReliabilityProvider'

const recording = {
  path: '/tmp/teach.mov',
  fileName: 'teach.mov',
  mimeType: 'video/quicktime',
  size: 100,
  localOwned: true,
  sessionId: 'teach-session-1',
  state: 'processing',
  lastError: null,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
}

describe('TeachReliabilityProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'IS_TAURI', {
      value: true,
      configurable: true,
    })
    h.listLocal.mockResolvedValue([recording])
    h.isUploadActive.mockReturnValue(false)
    h.ensureConversation.mockResolvedValue({
      id: 'teach-thread-1',
      title: 'Teach: workflow',
    })
  })

  it('creates a durable normal chat when background evidence becomes ready', async () => {
    h.getSession.mockResolvedValue({
      id: 'teach-session-1',
      status: 'evidence_ready',
    })
    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(h.ensureConversation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'teach-session-1' })
      )
    })
    expect(h.toastSuccess).toHaveBeenCalledWith(
      'Teaching evidence is ready',
      expect.objectContaining({ description: expect.stringContaining('saved in Chats') })
    )
    view.unmount()
  })

  it('resumes an upload left in progress by a webview refresh', async () => {
    h.listLocal.mockResolvedValue([{ ...recording, state: 'uploading' }])
    h.getSession.mockResolvedValue({
      id: 'teach-session-1',
      status: 'awaiting_upload',
    })
    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(h.upload).toHaveBeenCalledWith(
        'teach-session-1',
        expect.objectContaining({ path: '/tmp/teach.mov' })
      )
    })
    view.unmount()
  })

  it('deletes the managed retry copy only after Teach completes', async () => {
    h.getSession.mockResolvedValue({
      id: 'teach-session-1',
      status: 'completed',
    })
    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(h.finalizeLocal).toHaveBeenCalledWith(
        '/tmp/teach.mov',
        'teach-session-1'
      )
    })
    view.unmount()
  })
})
