import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { mentionedApps, splitMentions } from './mentions'

/** The invariant the overlay depends on: nothing added, nothing dropped. */
const rejoin = (draft: string): string =>
  splitMentions(draft).map((run) => run.text).join('')

describe('splitMentions', () => {
  it('finds an app in the middle of a sentence', () => {
    /* The space after the app belongs to the mention: it is the pebble's right
       padding, and it is the only place that padding can come from. */
    assert.deepEqual(splitMentions('pull @Gmail threads'), [
      { kind: 'text', text: 'pull ' },
      { kind: 'mention', text: '@Gmail ', name: 'Gmail', key: 'gmail' },
      { kind: 'text', text: 'threads' },
    ])
  })

  it('takes the space after the app, and only one of them', () => {
    const one = splitMentions('@Gmail then')[0]
    assert.equal(one?.kind === 'mention' && one.text, '@Gmail ')
    /* A second space is ordinary text again — swallowing a run of them would
       make one pebble wider than its neighbour for no reason a reader could
       see. */
    assert.deepEqual(splitMentions('@Gmail  then')[1], { kind: 'text', text: ' then' })
  })

  it('has no space to take at the end of a draft', () => {
    const run = splitMentions('send it with @Gmail')[1]
    assert.equal(run?.kind === 'mention' && run.text, '@Gmail')
  })

  it('does not swallow a newline, which is not padding', () => {
    assert.deepEqual(splitMentions('@Gmail\nthen'), [
      { kind: 'mention', text: '@Gmail', name: 'Gmail', key: 'gmail' },
      { kind: 'text', text: '\nthen' },
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
    /* The first takes the space between them as its own right padding; the
       second has nothing after it to take. */
    assert.deepEqual(
      splitMentions('@Gmail @Books').filter((r) => r.kind === 'mention').map((r) => r.text),
      ['@Gmail ', '@Books'],
    )
  })

  it('has nothing to say about an empty draft', () => {
    assert.deepEqual(splitMentions(''), [])
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
