import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ago,
  choose,
  complete,
  currentIndex,
  EMPTY,
  expiryLabel,
  firstOpen,
  said,
  settlesEarly,
  write,
  type Decision,
  type DecisionQuestion,
} from './decision'

const FLAVOURS = {
  id: 'flavours',
  ask: 'How many flavours?',
  pick: 'one' as const,
  options: [{ value: 'three', label: 'Three' }, { value: 'five', label: 'Five' }],
}
const MIXINS = {
  id: 'mixins',
  ask: 'Which mix-ins?',
  pick: 'many' as const,
  options: [{ value: 'chips', label: 'Chips' }, { value: 'waffle', label: 'Waffle' }],
  allowText: true,
}
const NAME: DecisionQuestion = { id: 'name', ask: 'Call it what?', text: {} }
const CONFIRM = {
  id: 'confirm',
  ask: 'Send this?',
  pick: 'one' as const,
  options: [
    { value: 'yes', label: 'Approve', settles: 'approved' as const },
    { value: 'no', label: 'Reject', settles: 'rejected' as const },
  ],
}

describe('choosing', () => {
  it('replaces on a single-choice question', () => {
    const one = choose(EMPTY, FLAVOURS, 'three')
    const two = choose(one, FLAVOURS, 'five')
    assert.deepEqual(two.responses, [{ questionId: 'flavours', chose: ['five'] }])
  })

  it('toggles on a multi-choice question', () => {
    const one = choose(choose(EMPTY, MIXINS, 'chips'), MIXINS, 'waffle')
    assert.deepEqual(one.responses[0]!.chose, ['chips', 'waffle'])
    assert.deepEqual(choose(one, MIXINS, 'chips').responses[0]!.chose, ['waffle'])
  })

  it('lets a single choice be taken back', () => {
    /* Pressing the option you already picked unpicks it, so a radio group is
       not a trap on a question that turns out to be optional. */
    assert.deepEqual(choose(choose(EMPTY, FLAVOURS, 'three'), FLAVOURS, 'three').responses[0]!.chose, [])
  })

  it('clears typed words when a listed option is picked', () => {
    /* Sending both would be an answer that says two things. */
    const typed = write(EMPTY, 'mixins', 'Honeycomb')
    assert.equal(choose(typed, MIXINS, 'chips').responses[0]!.said, undefined)
  })

  it('clears the choices when words are typed instead', () => {
    const picked = choose(EMPTY, MIXINS, 'chips')
    assert.deepEqual(write(picked, 'mixins', 'Honeycomb').responses[0]!.chose, [])
  })

  it('treats whitespace as nothing typed', () => {
    assert.equal(said(write(EMPTY, 'name', '   '), 'name'), false)
  })
})

describe('completeness', () => {
  it('needs every question before it will send', () => {
    const questions = [FLAVOURS, MIXINS, NAME]
    assert.equal(complete(questions, choose(EMPTY, FLAVOURS, 'three')), false)
    const all = write(choose(choose(EMPTY, FLAVOURS, 'three'), MIXINS, 'chips'), 'name', 'Sundae')
    assert.equal(complete(questions, all), true)
  })

  it('does not wait on an optional question', () => {
    assert.equal(complete([FLAVOURS, { ...NAME, optional: true }], choose(EMPTY, FLAVOURS, 'five')), true)
  })

  it('is finished the moment a choice ends the decision', () => {
    /* A Reject on page one is an answer, not an abandoned form — the pages
       after it are no longer being asked. */
    const stopped = choose(EMPTY, CONFIRM, 'no')
    assert.equal(settlesEarly([CONFIRM, MIXINS], stopped), true)
    assert.equal(complete([CONFIRM, MIXINS], stopped), true)
  })
})

describe('the pager', () => {
  it('sits on the first question nothing has been said about', () => {
    assert.equal(currentIndex([FLAVOURS, MIXINS, NAME], choose(EMPTY, FLAVOURS, 'three')), 1)
  })

  it('stays on the last question once everything is answered', () => {
    /* Rather than running off the end and rendering nothing. */
    const all = write(choose(EMPTY, FLAVOURS, 'three'), 'name', 'Sundae')
    assert.equal(currentIndex([FLAVOURS, NAME], all), 1)
  })
})

describe('which decision the thread shows', () => {
  const decision = (id: string, requestedAt: string): Decision => ({
    id, title: id, source: 'Divo', questions: [FLAVOURS], requestedAt, expiresAt: null,
  })

  it('takes the oldest, so a queue does not turn into a stack', () => {
    assert.equal(firstOpen([
      decision('new', '2026-08-17T12:00:00Z'),
      decision('old', '2026-08-17T09:00:00Z'),
    ])?.id, 'old')
  })

  it('is nothing when nothing is open', () => {
    assert.equal(firstOpen([]), null)
  })
})

describe('the clock', () => {
  const now = Date.parse('2026-08-17T15:00:00Z')

  it('counts down in the unit a reader can act on', () => {
    assert.deepEqual(expiryLabel('2026-08-17T15:30:00Z', now), { text: 'in 30 min', expired: false })
    assert.deepEqual(expiryLabel('2026-08-17T19:00:00Z', now), { text: 'in 4 hours', expired: false })
    assert.deepEqual(expiryLabel('2026-08-19T15:00:00Z', now), { text: 'in 2 days', expired: false })
  })

  it('says expired rather than counting backwards', () => {
    assert.deepEqual(expiryLabel('2026-08-17T14:00:00Z', now), { text: 'Expired', expired: true })
  })

  it('is nothing at all when there is no deadline', () => {
    assert.equal(expiryLabel(null, now), null)
  })

  it('reads an age in the largest unit that is still true', () => {
    assert.equal(ago('2026-08-17T14:51:00Z', now), '9 minutes ago')
    assert.equal(ago('2026-08-17T11:00:00Z', now), '4 hours ago')
    assert.equal(ago('2026-08-17T14:59:40Z', now), 'just now')
  })
})
