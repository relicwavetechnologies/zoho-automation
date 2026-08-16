/**
 * How a card lays out what the server sent. Nothing here renders anything.
 *
 * The stripping this used to assert now lives in `domain/artifact/preview.ts`,
 * where the body is — see its tests for what a preview contains. What is left
 * is the reader's own two rules, and both are the kind that break silently:
 * a thumbnail that repeats the title looks like a design choice, and a document
 * from a server that sends no preview should not take the page down with it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { kindLabel, madeItems, previewLines } from './made'
import type { ArtifactSummary } from '../artifacts/data'

describe('previewLines', () => {
  it('drops a first line that only repeats the title', () => {
    assert.deepEqual(
      previewLines('Q3 review\nRevenue held flat.', 'Q3 review'),
      ['Revenue held flat.'],
    )
  })

  it('keeps the title where the document quotes itself later on', () => {
    assert.deepEqual(
      previewLines('Opening note.\nQ3 review', 'Q3 review'),
      ['Opening note.', 'Q3 review'],
    )
  })

  it('stops at the line budget', () => {
    assert.deepEqual(previewLines(['a', 'b', 'c', 'd'].join('\n'), 'x', 3), ['a', 'b', 'c'])
  })
})

describe('kindLabel', () => {
  it('names a type this build knows', () => {
    assert.equal(kindLabel('text/html'), 'Page')
  })

  it('calls anything else a document rather than showing its mime', () => {
    assert.equal(kindLabel('application/x-newer-thing'), 'Document')
  })
})

describe('madeItems', () => {
  const summary = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
    artifactId: 'a1',
    title: 'Notes',
    mime: 'text/markdown',
    version: 1,
    createdAt: '2026-08-16T09:00:00.000Z',
    updatedAt: '2026-08-16T09:00:00.000Z',
    preview: 'Something happened.',
    ...over,
  })

  it('calls a document revised only once it has been written twice', () => {
    assert.equal(madeItems([summary()])[0]!.revised, false)
    assert.equal(madeItems([summary({ version: 2 })])[0]!.revised, true)
  })

  it('survives a row from a server that has no preview to give', () => {
    const item = madeItems([summary({ preview: undefined as unknown as string })])[0]!
    assert.deepEqual(item.lines, [])
    assert.equal(item.title, 'Notes')
  })

  it('keeps the order the route returned', () => {
    const items = madeItems([summary({ artifactId: 'a' }), summary({ artifactId: 'b' })])
    assert.deepEqual(items.map((i) => i.artifactId), ['a', 'b'])
  })
})
