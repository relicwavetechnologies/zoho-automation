import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  initialArtifactPublishState,
  reduceArtifactPublishState,
} from './publish'

describe('artifact publish state', () => {
  it('moves through publishing to a URL-only published state', () => {
    const pending = reduceArtifactPublishState(initialArtifactPublishState, { type: 'start' })
    assert.deepEqual(pending, { kind: 'publishing' })
    assert.deepEqual(reduceArtifactPublishState(pending, {
      type: 'success',
      url: 'https://published.example/',
    }), { kind: 'published', url: 'https://published.example/' })
  })

  it('keeps a failed reason visible and allows a retry', () => {
    const failed = reduceArtifactPublishState(initialArtifactPublishState, {
      type: 'failure',
      message: 'Vercel unavailable',
    })
    assert.deepEqual(failed, { kind: 'failed', message: 'Vercel unavailable' })
    assert.deepEqual(reduceArtifactPublishState(failed, { type: 'start' }), { kind: 'publishing' })
  })
})
