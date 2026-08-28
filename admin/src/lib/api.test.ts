import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ApiError, api } from './api'

it('uses a route detail as the human error instead of its machine code', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'chat_unknown_chat',
    detail: 'Divo has never been in that Lark room. Add Divo to it and try again.',
  }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  try {
    await assert.rejects(
      () => api.get('/test-detail', undefined, { quiet: true, retries: 0 }),
      error => {
        assert.ok(error instanceof ApiError)
        assert.equal(
          error.message,
          'Divo has never been in that Lark room. Add Divo to it and try again.',
        )
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})
