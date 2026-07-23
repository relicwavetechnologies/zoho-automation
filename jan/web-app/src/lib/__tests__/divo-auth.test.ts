import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: h.openUrl }))

import {
  DivoAuthCancelledError,
  isDivoAuthCancelled,
  signInDivoWithLark,
} from '../divo-auth'

describe('signInDivoWithLark cancel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('detects cancel and abort errors', () => {
    expect(isDivoAuthCancelled(new DivoAuthCancelledError())).toBe(true)
    expect(isDivoAuthCancelled(new DOMException('Aborted', 'AbortError'))).toBe(true)
    expect(isDivoAuthCancelled(new Error('nope'))).toBe(false)
  })

  it('stops waiting when the AbortSignal fires during poll', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/authorize-url')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              authorizeUrl: 'https://lark.example/authorize',
              nonce: 'nonce-1',
            },
          }),
        }
      }
      if (url.includes('/poll')) {
        queueMicrotask(() => controller.abort())
        return {
          ok: true,
          json: async () => ({ success: true, pending: true }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('open', vi.fn())
    h.openUrl.mockResolvedValue(undefined)

    await expect(
      signInDivoWithLark('http://localhost:8000', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(DivoAuthCancelledError)

    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      signInDivoWithLark('http://localhost:8000', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(DivoAuthCancelledError)
  })
})
