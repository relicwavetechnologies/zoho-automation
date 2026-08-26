import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BODY, MAX_RECIPIENTS, filterCandidates, firstName, isFinished, pacingLabel,
  parsePasted, pickedFrom, poolFor, progressPct, refusalFor, renderBody,
  summarizeReach, toggleAll, toggleOne,
} from './broadcast-compose'
import type { Candidate } from './use-broadcast'

const DAY = 86_400_000
const NOW = new Date('2026-08-26T12:00:00Z').getTime()
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

const chat = (over: Partial<Candidate> = {}): Candidate => ({
  waChatId: '919845010001@c.us',
  name: 'Ritu Malhotra',
  isGroup: false,
  lastMessageAt: ago(1),
  sessionId: 'n1',
  sessionLabel: 'Priya Nair',
  openFollowUps: 0,
  weOwe: false,
  waitingOn: false,
  ...over,
})

describe('poolFor', () => {
  const chats = [
    chat({ waChatId: 'a@c.us', weOwe: true }),
    chat({ waChatId: 'b@c.us', waitingOn: true }),
    chat({ waChatId: 'c@c.us' }),
  ]

  it('offers everything for the chats source', () => {
    assert.equal(poolFor(chats, 'chats', 'weowe').length, 3)
  })

  /**
   * "Everyone we are waiting on" is a real audience somebody can describe in one
   * breath. Building it by hand means reading fourteen follow-ups and
   * remembering which chats they came from.
   */
  it('narrows to the chats behind the chosen follow-up list', () => {
    assert.deepEqual(poolFor(chats, 'followups', 'weowe').map(c => c.waChatId), ['a@c.us'])
    assert.deepEqual(poolFor(chats, 'followups', 'waiting').map(c => c.waChatId), ['b@c.us'])
  })

  it('leaves the paste source alone — its recipients do not come from here', () => {
    assert.equal(poolFor(chats, 'paste', 'weowe').length, 3)
  })
})

describe('filterCandidates', () => {
  const pool = [
    chat({ waChatId: '919845010001@c.us', name: 'Ritu Malhotra', lastMessageAt: ago(1) }),
    chat({ waChatId: '1203630@g.us', name: 'Sangeet — Core', isGroup: true, lastMessageAt: ago(3) }),
    chat({ waChatId: '919845010003@c.us', name: 'Tent House', lastMessageAt: ago(20) }),
    chat({ waChatId: '919845010004@c.us', name: 'Never spoken', lastMessageAt: null }),
  ]

  it('matches on name, case-insensitively', () => {
    assert.deepEqual(filterCandidates(pool, 'ritu', 'all', NOW).map(c => c.name), ['Ritu Malhotra'])
  })

  it('matches on the WhatsApp id, so a number can be pasted into the search', () => {
    assert.equal(filterCandidates(pool, '1203630', 'all', NOW).length, 1)
  })

  it('separates groups from direct messages', () => {
    assert.equal(filterCandidates(pool, '', 'group', NOW).length, 1)
    assert.equal(filterCandidates(pool, '', 'dm', NOW).length, 3)
  })

  it('reads recent and quiet from the last message date', () => {
    assert.deepEqual(
      filterCandidates(pool, '', 'recent', NOW).map(c => c.name),
      ['Ritu Malhotra', 'Sangeet — Core'],
    )
    assert.deepEqual(filterCandidates(pool, '', 'quiet', NOW).map(c => c.name), ['Tent House', 'Never spoken'])
  })

  /**
   * A chat with no last message is infinitely quiet, not recently active. Read
   * the other way, a never-used chat would appear in "active this week".
   */
  it('treats a chat that has never had a message as quiet', () => {
    const never = filterCandidates(pool, '', 'quiet', NOW).map(c => c.name)
    assert.ok(never.includes('Never spoken'))
    assert.ok(!filterCandidates(pool, '', 'recent', NOW).map(c => c.name).includes('Never spoken'))
  })

  it('applies search and filter together, not one or the other', () => {
    assert.equal(filterCandidates(pool, 'sangeet', 'dm', NOW).length, 0)
    assert.equal(filterCandidates(pool, 'sangeet', 'group', NOW).length, 1)
  })
})

describe('toggleAll', () => {
  const visible = [chat({ waChatId: 'a@c.us' }), chat({ waChatId: 'b@c.us' })]

  it('selects every visible row when none is selected', () => {
    assert.deepEqual([...toggleAll(new Set(), visible)].sort(), ['a@c.us', 'b@c.us'])
  })

  it('deselects them when all are already selected', () => {
    const all = new Set(['a@c.us', 'b@c.us'])
    assert.equal(toggleAll(all, visible).size, 0)
  })

  /**
   * The one that bites. Somebody picks four vendors, searches for "Sharma",
   * hits select-all, then clears the search — their original four must still be
   * there. A select-all scoped to the whole pool would be discovered at the
   * review step, or not at all.
   */
  it('never touches a selection that is not currently visible', () => {
    const withHidden = new Set(['hidden@c.us'])
    const after = toggleAll(withHidden, visible)
    assert.ok(after.has('hidden@c.us'))
    assert.equal(after.size, 3)
  })

  it('selects rather than deselects when the visible set is only partly chosen', () => {
    const partial = new Set(['a@c.us'])
    assert.equal(toggleAll(partial, visible).size, 2)
  })

  it('does nothing when there is nothing shown', () => {
    assert.equal(toggleAll(new Set(['x@c.us']), []).size, 1)
  })
})

describe('toggleOne', () => {
  it('adds then removes', () => {
    const added = toggleOne(new Set(), 'a@c.us')
    assert.ok(added.has('a@c.us'))
    assert.equal(toggleOne(added, 'a@c.us').size, 0)
  })

  it('does not mutate the set it was given', () => {
    const original = new Set(['a@c.us'])
    toggleOne(original, 'b@c.us')
    assert.equal(original.size, 1)
  })
})

describe('parsePasted', () => {
  const known = new Map([['919845010001@c.us', 'Ritu Malhotra']])

  it('splits on newlines, commas and semicolons', () => {
    const { recipients } = parsePasted('+919845010002\n+919845010003, +919845010004; +919845010005', known)
    assert.equal(recipients.length, 4)
  })

  it('strips formatting to digits and builds a chat id', () => {
    const { recipients } = parsePasted('+91 98450 10002', known)
    assert.equal(recipients[0]!.waChatId, '919845010002@c.us')
    assert.equal(recipients[0]!.name, '+919845010002')
  })

  /**
   * The gateway would accept `98450` and report a successful delivery to
   * nobody, so a number that cannot be one is rejected here where it can still
   * be shown back to the person who typed it.
   */
  it('rejects anything too short or too long to be a phone number', () => {
    const { recipients, rejected } = parsePasted('98450\n+919845010002\n1234567890123456789', known)
    assert.equal(recipients.length, 1)
    assert.deepEqual(rejected, ['98450', '1234567890123456789'])
  })

  /**
   * A pasted number that is really an existing client must not be reported as a
   * cold contact — that figure is the one the review step asks somebody to
   * accept risk on, and overstating it teaches them to ignore it.
   */
  it('recognises a pasted number Divo has already spoken to', () => {
    const { recipients } = parsePasted('+919845010001', known)
    assert.equal(recipients[0]!.cold, false)
    assert.equal(recipients[0]!.name, 'Ritu Malhotra')
  })

  it('marks a genuinely unknown number cold', () => {
    const { recipients } = parsePasted('+447700900123', known)
    assert.equal(recipients[0]!.cold, true)
  })

  it('collapses the same number pasted twice', () => {
    const { recipients } = parsePasted('+919845010002\n+91 98450 10002', known)
    assert.equal(recipients.length, 1)
  })

  it('ignores blank lines rather than rejecting them', () => {
    const { recipients, rejected } = parsePasted('\n\n+919845010002\n\n', known)
    assert.equal(recipients.length, 1)
    assert.deepEqual(rejected, [])
  })
})

describe('summarizeReach', () => {
  it('counts groups and cold contacts', () => {
    const reach = summarizeReach([
      { waChatId: 'a@c.us', name: 'A', isGroup: false, cold: false },
      { waChatId: 'b@g.us', name: 'B', isGroup: true, cold: false },
      { waChatId: 'c@c.us', name: 'C', isGroup: false, cold: true },
    ])
    assert.deepEqual(reach, { recipients: 3, groups: 1, cold: 1 })
  })

  /** Group sizes are not something Divo knows, and a plausible guess is worse. */
  it('does not claim to know how many people a group holds', () => {
    assert.equal('people' in summarizeReach([]), false)
  })
})

describe('renderBody', () => {
  it('substitutes the first name', () => {
    assert.equal(renderBody('Hi {{name}}!', 'Ritu Malhotra'), 'Hi Ritu!')
  })

  it('tolerates spacing inside the braces and repeats', () => {
    assert.equal(renderBody('{{ name }} — {{name}}', 'Ritu'), 'Ritu — Ritu')
  })

  /**
   * Must match the server's `renderBody` exactly. A preview that differs from
   * what is sent is worse than no preview, and the two failure modes here — a
   * name containing `{{name}}`, and one containing `$&` — both silently produce
   * different text under a naive string replace.
   */
  it('never expands the value it just substituted', () => {
    assert.equal(renderBody('Hi {{name}}', '{{name}} Corp'), 'Hi {{name}}')
    assert.equal(renderBody('Hi {{name}}', '$& Traders'), 'Hi $&')
  })

  it('leaves a template with no placeholder alone', () => {
    assert.equal(renderBody('No variables.', 'Ritu'), 'No variables.')
  })
})

describe('firstName', () => {
  it('takes the first word of a person name', () => {
    assert.equal(firstName('Ritu Malhotra'), 'Ritu')
  })

  it('keeps the phrase before a spaced dash, for a group', () => {
    assert.equal(firstName('Sharma Sangeet — Core'), 'Sharma Sangeet')
  })

  it('does not cut a hyphenated given name', () => {
    assert.equal(firstName('Jean-Pierre Dubois'), 'Jean-Pierre')
  })

  it('falls back to a greeting rather than an empty string', () => {
    assert.equal(firstName('  '), 'there')
  })
})

describe('refusalFor', () => {
  const one = [{ waChatId: 'a@c.us', name: 'A', isGroup: false, cold: false }]

  it('allows an ordinary send', () => {
    assert.equal(refusalFor(one, 'Hello'), null)
  })

  it('refuses an empty selection and an empty message', () => {
    assert.match(refusalFor([], 'Hi') ?? '', /at least one recipient/i)
    assert.match(refusalFor(one, '   ') ?? '', /write the message/i)
  })

  it('refuses one over the cap, not at it', () => {
    const at = Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({
      waChatId: `${i}@c.us`, name: `P${i}`, isGroup: false, cold: false,
    }))
    assert.equal(refusalFor(at, 'Hi'), null)
    assert.match(refusalFor([...at, one[0]!], 'Hi') ?? '', /over the limit/i)
  })

  it('measures the body after trimming', () => {
    assert.equal(refusalFor(one, `${'x'.repeat(MAX_BODY)}   `), null)
    assert.match(refusalFor(one, 'x'.repeat(MAX_BODY + 1)) ?? '', /WhatsApp takes/)
  })
})

describe('pacingLabel', () => {
  it('says a moment for a send with nothing to wait between', () => {
    assert.equal(pacingLabel(1), 'a moment')
    assert.equal(pacingLabel(0), 'a moment')
  })

  it('counts the gaps, at the upper end of the jittered range', () => {
    // Three gaps at 3s + up to 2s of jitter.
    assert.equal(pacingLabel(4), 'about 15 seconds')
  })

  it('switches to minutes once seconds stop being readable', () => {
    assert.equal(pacingLabel(30), 'about 2 minutes')
  })

  it('says one minute in the singular', () => {
    assert.equal(pacingLabel(14), 'about 1 minute')
  })
})

describe('progressPct', () => {
  it('counts failures as settled, not as outstanding', () => {
    assert.equal(progressPct(5, 5, 10), 100)
  })

  it('is zero rather than NaN for an empty broadcast', () => {
    assert.equal(progressPct(0, 0, 0), 0)
  })

  /**
   * The gateway's counters can briefly exceed the total it reported — its
   * progress and its results array are persisted at different moments. A bar
   * over 100% reads as a bug in the send itself.
   */
  it('never exceeds a full bar', () => {
    assert.equal(progressPct(12, 0, 10), 100)
  })
})

describe('isFinished', () => {
  it('is true only for states the screen can stop polling on', () => {
    assert.equal(isFinished('completed'), true)
    assert.equal(isFinished('cancelled'), true)
    assert.equal(isFinished('failed'), true)
    assert.equal(isFinished('sending'), false)
    assert.equal(isFinished('queued'), false)
  })

  /** Unknown keeps polling — a stuck spinner is recoverable, a stopped one is not. */
  it('keeps polling on a status it does not recognise', () => {
    assert.equal(isFinished('throttled'), false)
  })
})

describe('pickedFrom', () => {
  it('keeps only the selected chats, as recipients', () => {
    const pool = [chat({ waChatId: 'a@c.us', name: 'A' }), chat({ waChatId: 'b@c.us', name: 'B' })]
    const picked = pickedFrom(pool, new Set(['b@c.us']))
    assert.deepEqual(picked, [{ waChatId: 'b@c.us', name: 'B', isGroup: false, cold: false }])
  })

  /** A tracked chat has exchanged messages by definition, so it is never cold. */
  it('never marks a tracked chat as a cold contact', () => {
    const picked = pickedFrom([chat({ waChatId: 'a@c.us' })], new Set(['a@c.us']))
    assert.equal(picked[0]!.cold, false)
  })
})
