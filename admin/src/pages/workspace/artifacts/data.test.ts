import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getArtifactDocument, withDocumentTheme } from './data'

/**
 * These read a route's response shape, which is the one thing `read<T>` cannot
 * check for itself: it casts `payload[key] as T` without looking, so a wrong
 * type here compiles and then returns `undefined` at runtime forever.
 *
 * That is not hypothetical. `getArtifactDocument` unwrapped the payload twice —
 * once in `read`, once again on the string it returned — and produced `null` for
 * every document ever fetched. The panel reported it as "This document could not
 * be loaded", which reads as a network fault and was a shape mismatch.
 */
const realFetch = globalThis.fetch

function respondWith(payload: unknown, ok = true) {
  globalThis.fetch = (async () => ({
    ok,
    json: async () => payload,
  })) as unknown as typeof fetch
}

afterEach(() => { globalThis.fetch = realFetch })

describe('getArtifactDocument', () => {
  test('returns the markup the route puts at `document`', async () => {
    respondWith({ ok: true, mode: 'panel', document: '<html data-theme="light">hi</html>' })
    assert.equal(
      await getArtifactDocument('a1', 't'),
      '<html data-theme="light">hi</html>',
    )
  })

  test('returns null when the route answers without a document', async () => {
    respondWith({ ok: true, mode: 'panel' })
    assert.equal(await getArtifactDocument('a1', 't'), null)
  })

  test('returns null on a failed response rather than throwing', async () => {
    respondWith({ ok: false, error: 'artifact_not_found' }, false)
    assert.equal(await getArtifactDocument('a1', 't'), null)
  })

  test('returns null when the network throws', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    assert.equal(await getArtifactDocument('a1', 't'), null)
  })
})

describe('withDocumentTheme', () => {
  test('swaps the theme on the root element', () => {
    const markup = '<html lang="en" data-theme="light"><body>x</body></html>'
    assert.match(withDocumentTheme(markup, 'dark'), /data-theme="dark"/)
  })

  test('leaves the body alone, so switching theme is not a re-render', () => {
    const markup = '<html data-theme="light"><body>the report</body></html>'
    assert.ok(withDocumentTheme(markup, 'dark').includes('<body>the report</body>'))
  })

  test('does not invent an attribute on markup that has none', () => {
    assert.equal(withDocumentTheme('<html><body>x</body></html>', 'dark'), '<html><body>x</body></html>')
  })
})
