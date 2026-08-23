import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteImageLayers, remoteImagePhase, type RemoteImageState } from './remote-image'

test('keeps the fallback visible while a remote image loads', () => {
  const state: RemoteImageState = null
  const phase = remoteImagePhase('https://example.test/logo.png', state)
  assert.equal(phase, 'loading')
  assert.deepEqual(remoteImageLayers('https://example.test/logo.png', phase), {
    showFallback: true,
    showRemote: true,
  })
})

test('removes the fallback after the same remote image loads', () => {
  const src = 'https://example.test/logo.png'
  const phase = remoteImagePhase(src, { src, phase: 'shown' })
  assert.equal(phase, 'shown')
  assert.deepEqual(remoteImageLayers(src, phase), {
    showFallback: false,
    showRemote: true,
  })
})

test('keeps the fallback after a remote image fails', () => {
  const src = 'https://example.test/logo.png'
  const phase = remoteImagePhase(src, { src, phase: 'failed' })
  assert.equal(phase, 'failed')
  assert.deepEqual(remoteImageLayers(src, phase), {
    showFallback: true,
    showRemote: false,
  })
})

test('does not let an old URL hide the current fallback', () => {
  const phase = remoteImagePhase('https://example.test/new-logo.png', {
    src: 'https://example.test/old-logo.png',
    phase: 'shown',
  })
  assert.equal(phase, 'loading')
  assert.equal(remoteImageLayers('https://example.test/new-logo.png', phase).showFallback, true)
})
