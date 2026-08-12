import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupBeats } from './log'
import type { Beat } from './transcripts'

const step = (title: string): Beat => ({
  t: 'step', tool: 'gmail', title, ms: 0, lines: [], done: 'Done',
})
const narration = (text: string): Beat => ({ t: 'say', text, narration: true })
const answer = (text: string): Beat => ({ t: 'say', text })

describe('separating the work from the reply', () => {
  /* The defect this file exists for: a run that talks between its tool calls
     used to print every aside in the same column as the answer, at the same
     weight, so a turn ended in four paragraphs and nothing said which was the
     conclusion. */
  it('files what the model said mid-run with the work, not with the answer', () => {
    const groups = groupBeats([
      narration('Let me check the invoices first'),
      step('Zoho Books'),
      narration('Three of those are overdue'),
      step('Gmail'),
      answer('Here are the four unpaid invoices.'),
    ])

    assert.equal(groups.length, 2)
    assert.equal(groups[0]!.kind, 'log')
    assert.deepEqual(
      groups[0]!.kind === 'log' ? groups[0]!.items.map(i => i.index) : [],
      [0, 1, 2, 3],
    )
    // Exactly one thing is left in the conversation, and it is the reply.
    assert.equal(groups[1]!.kind, 'beat')
    assert.equal(
      groups[1]!.kind === 'beat' && groups[1]!.item.beat.t === 'say'
        ? groups[1]!.item.beat.text
        : null,
      'Here are the four unpaid invoices.',
    )
  })

  /* Indices address the original list — the exchange's own state (which beats
     have played, which one is gated) is keyed by them, so a group that
     renumbered its contents would answer questions about the wrong beat. */
  it('keeps every beat at its original index', () => {
    const groups = groupBeats([answer('hi'), step('Gmail'), answer('bye')])
    assert.deepEqual(
      groups.map(g => g.kind === 'log' ? g.items.map(i => i.index) : g.item.index),
      [0, [1], 2],
    )
  })

  /* Order carries meaning: the invoice run draws its ageing chart before it
     asks to send anything. Sorting by kind printed the chart underneath the
     approval it existed to inform. */
  it('leaves anything that is not work exactly where the run put it', () => {
    const chart: Beat = {
      t: 'block',
      block: { kind: 'artifact', tool: 'sheets', title: 'Ageing', meta: '4 rows' },
    }
    const approval: Beat = {
      t: 'approve', tool: 'gmail', title: 'Send?', body: '', facts: [],
      confirm: 'Send', declined: 'Declined.',
    }
    const groups = groupBeats([step('Zoho Books'), chart, approval, answer('Sent.')])
    assert.deepEqual(groups.map(g => g.kind), ['log', 'beat', 'beat', 'beat'])
  })

  /* One fold over one stretch of work. A block per beat would give a finished
     run a column of chevrons instead of a single "Worked for 12s". */
  it('coalesces a run of work into one block, and breaks it where the run did', () => {
    const groups = groupBeats([
      step('Gmail'), step('Gmail'),
      answer('Halfway there.'),
      step('Sheets'),
    ])
    assert.deepEqual(groups.map(g => g.kind), ['log', 'beat', 'log'])
  })

  it('has nothing to group in a turn that answered without working', () => {
    assert.deepEqual(groupBeats([]), [])
    assert.deepEqual(groupBeats([answer('Hi! How can I help?')]).map(g => g.kind), ['beat'])
  })
})
