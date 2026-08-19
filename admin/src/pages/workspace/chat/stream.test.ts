/**
 * The wire contract, asserted as a string.
 *
 * A URL is the one part of a client nothing else checks: types pass, the suite
 * passes, and the request 404s at runtime. This file exists because that is
 * exactly what happened — the video upload was aimed at a path no router
 * serves, and every attachment failed with a message about the recording.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { uploadVideo } from './stream'
import { API_BASE_URL } from '@/lib/api-base'

type Call = { url: string; init: RequestInit }

const realFetch = globalThis.fetch
let calls: Call[] = []

function stubFetch(response: { status?: number; body?: unknown }) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.body,
    }
  }) as unknown as typeof fetch
}

describe('uploadVideo', () => {
  beforeEach(() => { calls = [] })
  afterEach(() => { globalThis.fetch = realFetch })

  it('PUTs to the route the backend actually mounts', async () => {
    stubFetch({ body: { ok: true, video: { videoId: 'v-1' } } })
    const file = new File([''], 'workflow.mov', { type: 'video/quicktime' })

    const id = await uploadVideo({
      threadId: 'web_thread1234',
      file,
      mimeType: 'video/quicktime',
      token: 'token-1',
    })

    assert.equal(id, 'v-1')
    assert.equal(calls[0]!.url, `${API_BASE_URL}/api/web-chat/threads/web_thread1234/video`)
    assert.equal(calls[0]!.init.method, 'PUT')
  })

  it('sends the name encoded, so a space or an accent survives a header', async () => {
    stubFetch({ body: { ok: true, video: { videoId: 'v-2' } } })
    await uploadVideo({
      threadId: 'web_thread1234',
      file: new File([''], 'my demo — final.mov', { type: 'video/quicktime' }),
      mimeType: 'video/quicktime',
      token: 'token-1',
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(decodeURIComponent(headers['X-File-Name']!), 'my demo — final.mov')
    assert.equal(headers['Content-Type'], 'video/quicktime')
  })

  it('says what went wrong in words the composer can show', async () => {
    stubFetch({ status: 413, body: { ok: false, error: 'file_too_large' } })
    await assert.rejects(
      uploadVideo({
        threadId: 'web_thread1234',
        file: new File([''], 'big.mp4', { type: 'video/mp4' }),
        mimeType: 'video/mp4',
        token: 'token-1',
      }),
      /too large/,
    )
  })
})
