import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  ensureConversation: vi.fn(),
  finalizeLocal: vi.fn(),
  getSession: vi.fn(),
  isUploadActive: vi.fn(),
  listLocal: vi.fn(),
  recorderStatus: vi.fn(),
  upload: vi.fn(),
  toastSuccess: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: h.listen,
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))

vi.mock('@/lib/divo-teach-thread', () => ({
  ensureDivoTeachConversation: h.ensureConversation,
}))

vi.mock('@/lib/divo-teach', () => ({
  finalizeLocalTeachRecording: h.finalizeLocal,
  getTeachRecorderStatus: h.recorderStatus,
  getTeachSession: h.getSession,
  isTeachUploadActive: h.isUploadActive,
  listLocalTeachRecordings: h.listLocal,
  uploadTeachRecording: h.upload,
}))

vi.mock('sonner', () => ({
  toast: { success: h.toastSuccess },
}))

import { TeachReliabilityProvider } from '../TeachReliabilityProvider'
import { useTeachActivity } from '@/hooks/useTeachActivity'

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
    useTeachActivity.setState({
      recorder: { recording: false, startedAt: null, fileName: null },
      recordings: [],
      sessions: {},
      uploading: [],
      uploadPercent: {},
      online: true,
    })
    h.listen.mockResolvedValue(() => undefined)
    h.recorderStatus.mockResolvedValue({
      recording: false,
      startedAt: null,
      fileName: null,
    })
    h.listLocal.mockResolvedValue([recording])
    h.isUploadActive.mockResolvedValue(false)
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
      expect.objectContaining({
        description: expect.stringContaining('saved in Chats'),
      })
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

  it('never starts a second upload while Rust is still streaming the first', async () => {
    h.listLocal.mockResolvedValue([{ ...recording, state: 'uploading' }])
    h.getSession.mockResolvedValue({
      id: 'teach-session-1',
      status: 'awaiting_upload',
    })
    // The webview reloaded, so JavaScript has forgotten — but Rust has not.
    h.isUploadActive.mockResolvedValue(true)
    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(useTeachActivity.getState().uploading).toEqual(['teach-session-1'])
    })
    expect(h.upload).not.toHaveBeenCalled()
    view.unmount()
  })

  it('retries a send that failed, without the manager asking', async () => {
    h.listLocal.mockResolvedValue([
      { ...recording, state: 'retryable', lastError: 'connection closed' },
    ])
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

  it('reports the backend as unreachable without discarding local work', async () => {
    h.getSession.mockRejectedValue(new Error('connection refused'))
    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(useTeachActivity.getState().online).toBe(false)
    })
    // The recording is still listed, so nothing is presented as lost.
    expect(useTeachActivity.getState().recordings).toHaveLength(1)
    expect(h.finalizeLocal).not.toHaveBeenCalled()
    view.unmount()
  })

  it('resumes a stalled send as soon as the backend answers again', async () => {
    // The exact case of restarting the backend: the first send fails while it
    // is down, and the retry must not sit out its backoff once it is back.
    h.listLocal.mockResolvedValue([
      { ...recording, state: 'retryable', lastError: 'Connection refused' },
    ])
    h.getSession
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValue({ id: 'teach-session-1', status: 'awaiting_upload' })

    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(useTeachActivity.getState().online).toBe(false)
    })
    await waitFor(
      () => {
        expect(useTeachActivity.getState().online).toBe(true)
      },
      { timeout: 5_000 }
    )
    await waitFor(() => {
      expect(h.upload).toHaveBeenCalledWith(
        'teach-session-1',
        expect.objectContaining({ path: '/tmp/teach.mov' })
      )
    })
    view.unmount()
  })

  it('publishes a live recording so any screen can show it', async () => {
    h.recorderStatus.mockResolvedValue({
      recording: true,
      startedAt: '2026-07-19T00:00:00.000Z',
      fileName: 'teach-abc.mov',
    })
    h.listLocal.mockResolvedValue([])
    const view = render(<TeachReliabilityProvider />)

    await waitFor(() => {
      expect(useTeachActivity.getState().recorder.recording).toBe(true)
    })
    view.unmount()
  })
})
