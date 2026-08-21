import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/* The store reads a remembered width from localStorage as it loads, so the
   browser it expects has to exist before the import. */
const remembered = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => remembered.get(key) ?? null,
    setItem: (key: string, value: string) => { remembered.set(key, value) },
  },
}

const {
  MAX_WIDTH, MIN_WIDTH, clampWidth, closeAll, closeTab, fillArtifact, focusTab,
  openArtifact, peek, restoreArtifacts,
} = await import('./store')

/** The artifact ids currently open, in tab order. */
const openIds = (): string[] =>
  peek().tabs.flatMap(tab => (tab.kind === 'artifact' ? [tab.artifactId] : []))

const only = () => {
  const [tab] = peek().tabs
  assert.ok(tab && tab.kind === 'artifact')
  return tab
}

describe('artifact panel state', () => {
  beforeEach(() => { closeAll() })

  it('shows a revised document in the tab that already holds it', () => {
    openArtifact({ artifactId: 'q3', title: 'Q3 review', version: 1, body: 'first' })
    openArtifact({ artifactId: 'q3', title: 'Q3 review', version: 2 })

    // One tab, not two. A model revising a report re-badges the same file, and
    // stacking would leave the reader several tabs all called "Q3 review".
    assert.equal(peek().tabs.length, 1)
    assert.equal(only().version, 2)
    // The old body must not stay on screen under the new version number while
    // the fetch for the new one is still in flight.
    assert.equal(only().body, undefined)
  })

  it('keeps a fetched body only while it is not already stale', () => {
    openArtifact({ artifactId: 'q3', title: 'Q3', version: 3 })

    // A slow fetch for v2 landing after v3 has opened must lose.
    fillArtifact('q3', 2, 'older text')
    assert.equal(only().body, undefined)

    fillArtifact('q3', 3, 'current text')
    assert.equal(only().body, 'current text')
  })

  it('clears a published link when a newer revision is opened', () => {
    openArtifact({
      artifactId: 'q3',
      title: 'Q3',
      version: 1,
      publishedUrl: 'https://published.example/q3',
    })
    openArtifact({ artifactId: 'q3', title: 'Q3', version: 2 })
    assert.equal(only().publishedUrl, undefined)
  })

  it('never trims away the document being read', () => {
    for (let index = 0; index < 12; index += 1) {
      openArtifact({ artifactId: `doc-${index}`, title: `Doc ${index}` })
    }
    assert.equal(peek().tabs.length, 8)
    // A long run producing documents is exactly when the reader is looking at
    // the newest one, so age alone must not decide what goes.
    assert.ok(openIds().includes('doc-11'))
    assert.ok(!openIds().includes('doc-0'))
  })

  it('lands on the neighbour when the open tab is closed', () => {
    for (const id of ['a', 'b', 'c', 'd']) openArtifact({ artifactId: id, title: id })
    focusTab('artifact:b')
    closeTab('artifact:b')
    // The tab that took its position, not the last one — closing the second of
    // four and landing on the fourth is a jump nobody asked for.
    assert.equal(peek().activeId, 'artifact:c')
  })

  it('closes the panel when the last document goes', () => {
    openArtifact({ artifactId: 'only', title: 'Only' })
    assert.equal(peek().open, true)
    closeTab('artifact:only')
    // An empty panel holding a third of the screen is a panel in the way.
    assert.equal(peek().open, false)
  })

  it('puts an old conversation’s documents back without taking the screen', () => {
    const summary = { artifactId: 'old', title: 'Last week', mime: 'text/markdown', version: 2 }
    restoreArtifacts([summary], 'web_thread-1')

    assert.equal(peek().tabs.length, 1)
    // Opening a thread from last week must not make a panel spring out at the
    // reader; they came back for the conversation.
    assert.equal(peek().open, false)

    // Restoring twice — a remount, a second fetch — must not duplicate anything.
    restoreArtifacts([summary], 'web_thread-1')
    assert.equal(peek().tabs.length, 1)
  })

  it('clamps a width dragged past either end', () => {
    assert.equal(clampWidth(5), MIN_WIDTH)
    assert.equal(clampWidth(95), MAX_WIDTH)
    assert.equal(clampWidth(Number.NaN), 38)
  })
})
