import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { crowded, mentionedApps, splitMentions } from './mentions'

/** The invariant the overlay depends on: nothing added, nothing dropped. */
const rejoin = (draft: string): string =>
  splitMentions(draft).map((run) => run.text).join('')

describe('splitMentions', () => {
  it('finds an app in the middle of a sentence', () => {
    /* The mention is the name and nothing else. It used to take the space after
       it as somewhere to put padding; the tile now pays for its own out of a
       negative margin, so the space belongs to the sentence again. */
    assert.deepEqual(splitMentions('pull @Gmail threads'), [
      { kind: 'text', text: 'pull ' },
      { kind: 'mention', text: '@Gmail', name: 'Gmail', key: 'gmail' },
      { kind: 'text', text: ' threads' },
    ])
  })

  it('prefers the long name over the short one inside it', () => {
    const runs = splitMentions('@Google Sheets')
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0], {
      kind: 'mention', text: '@Google Sheets', name: 'Google Sheets', key: 'sheets',
    })
  })

  it('reads the short name the app tray writes', () => {
    assert.deepEqual(splitMentions('@Sheets')[0], {
      kind: 'mention', text: '@Sheets', name: 'Sheets', key: 'sheets',
    })
  })

  it('sends two spellings of one app to the same mark', () => {
    const long = splitMentions('@Zoho Books')[0]
    const short = splitMentions('@Books')[0]
    assert.equal(long?.kind === 'mention' && long.key, 'zohoBooks')
    assert.equal(short?.kind === 'mention' && short.key, 'zohoBooks')
  })

  it('does not care how it was capitalised', () => {
    assert.deepEqual(splitMentions('@gmail')[0], {
      kind: 'mention', text: '@gmail', name: 'Gmail', key: 'gmail',
    })
  })

  it('keeps the text exactly as typed, not as catalogued', () => {
    /* The overlay draws this behind the real characters. Correcting the
       capitalisation here would shift every letter after it. */
    const run = splitMentions('@gMaIl')[0]
    assert.equal(run?.kind === 'mention' && run.text, '@gMaIl')
  })

  it('leaves a word that merely starts with an app name alone', () => {
    assert.deepEqual(splitMentions('@Larkspur'), [{ kind: 'text', text: '@Larkspur' }])
  })

  it('ignores an @ glued to the end of a word', () => {
    assert.deepEqual(splitMentions('me@Gmail'), [{ kind: 'text', text: 'me@Gmail' }])
  })

  it('ignores an @ followed by nothing it knows', () => {
    assert.deepEqual(splitMentions('@Nowhere'), [{ kind: 'text', text: '@Nowhere' }])
  })

  it('still marks an app that has no logo to draw', () => {
    assert.deepEqual(splitMentions('@AITable')[0], {
      kind: 'mention', text: '@AITable', name: 'AITable', key: null,
    })
  })

  it('handles a draft that is nothing but apps', () => {
    assert.deepEqual(
      splitMentions('@Gmail @Books').filter((r) => r.kind === 'mention').map((r) => r.text),
      ['@Gmail', '@Books'],
    )
  })

  it('has nothing to say about an empty draft', () => {
    assert.deepEqual(splitMentions(''), [])
  })
})

describe('crowded', () => {
  it('is true for a tile with one space and another tile behind it', () => {
    const runs = splitMentions('@Gmail @Books')
    assert.equal(crowded(runs, 0), true)
  })

  it('is true for the second of a pair as well as the first', () => {
    /* Both give way, or the one that did not still pushes a full pad into the
       space they share and the pair overlaps. */
    const runs = splitMentions('@Gmail @Books')
    assert.equal(crowded(runs, 2), true)
  })

  it('is false for a lone tile with words on both sides', () => {
    const runs = splitMentions('pull @Gmail threads')
    assert.equal(crowded(runs, 1), false)
  })

  it('is false when a word sits between two tiles', () => {
    /* There is a whole word of room here. Tightening would be the layout
       flinching at something that is not happening. */
    const runs = splitMentions('@Gmail and @Books')
    assert.equal(crowded(runs, 0), false)
  })

  it('is false when the gap is wider than one space', () => {
    const runs = splitMentions('@Gmail  @Books')
    assert.equal(crowded(runs, 0), false)
  })

  it('is false for a newline between them, which is not a gap but a break', () => {
    const runs = splitMentions('@Gmail\n@Books')
    assert.equal(crowded(runs, 0), false)
  })

  it('is false for plain text and for an index nobody filled', () => {
    const runs = splitMentions('just words')
    assert.equal(crowded(runs, 0), false)
    assert.equal(crowded(runs, 99), false)
  })
})

describe('splitMentions round trip', () => {
  for (const draft of [
    '',
    'no apps here',
    '@Gmail',
    'pull @Gmail and @Google Sheets, then tell @Lark',
    '@@Gmail',
    'me@Gmail.com is my address',
    '@Gmail\n@Books',
    'trailing @',
    '@gMaIl mixed case',
  ]) {
    it(`rebuilds ${JSON.stringify(draft)} character for character`, () => {
      assert.equal(rejoin(draft), draft)
    })
  }
})

describe('mentionedApps', () => {
  it('lists each app once, in the order they appear', () => {
    assert.deepEqual(
      mentionedApps('@Books then @Gmail then @Books again').map((a) => a.name),
      ['Books', 'Gmail'],
    )
  })

  it('treats the long and short spelling as different names', () => {
    /* Deliberate. They are two different strings in the box, and collapsing
       them would make the row disagree with what the reader can see. */
    assert.deepEqual(
      mentionedApps('@Books and @Zoho Books').map((a) => a.name),
      ['Books', 'Zoho Books'],
    )
  })

  it('finds nothing in a plain sentence', () => {
    assert.deepEqual(mentionedApps('export last month'), [])
  })
})
