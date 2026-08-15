import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { beatsFrom, exchangesFrom } from './live'
import type { LedgerRow, Timeline } from './stream'

const thought = (id: string, label: string, open = false): LedgerRow =>
  ({ id, kind: 'thought', label, count: 1, status: open ? 'running' : 'done' })
const said = (id: string, label: string, aside?: true): LedgerRow =>
  ({ id, kind: 'say', label, count: 1, status: 'done', ...(aside ? { aside } : {}) })
const call = (id: string, label: string): LedgerRow =>
  ({ id, kind: 'tool', label, count: 1, status: 'done', toolName: 'read' })

const ledger = (...rows: LedgerRow[]): Timeline => ({ ledger: rows })

/** What a reader would see, in the order they would see it. */
const shown = (timeline: Timeline, liveAnswer = ''): string[] =>
  beatsFrom(timeline, null, liveAnswer).map(beat => {
    if (beat.t === 'think') return `think${beat.running ? '*' : ''}:${beat.text}`
    if (beat.t === 'say') return `${beat.narration ? 'aside' : 'REPLY'}:${beat.text}`
    return `step:${beat.t === 'step' ? beat.title : ''}`
  })

/*
 * The defect this replaces: which sentences belonged in the work log was
 * decided by whether the live answer stream happened to be non-empty. The
 * backend clears that stream on every tool call, so the flag flipped several
 * times a turn — and the same sentence moved from the log to the answer and
 * back, remounting both and replaying both arrival animations.
 *
 * The run knows which sentences it went on working after. These say that
 * reading the mark gives the same picture whatever the answer stream is doing.
 */
describe('which prose belongs in the work log', () => {
  const midRun = ledger(
    thought('t1', 'Where are the invoices?'),
    said('s1', 'Let me check Zoho Books.', true),
    call('c1', 'Zoho Books'),
    said('s2', 'Three invoices are overdue.'),
  )

  it('files what the model said on the way, and leaves the reply to the answer', () => {
    assert.deepEqual(shown(midRun, 'Three invoices are overdue.'), [
      'think:Where are the invoices?',
      'aside:Let me check Zoho Books.',
      'step:Zoho Books',
      'REPLY:Three invoices are overdue.',
    ])
  })

  /* The answer stream empties on every tool call and refills a moment later.
     Nothing in the log may move when it does. */
  it('draws the same log whether the answer stream is full or empty', () => {
    assert.deepEqual(
      shown(midRun, '').filter(line => !line.startsWith('REPLY')),
      shown(midRun, 'Three invoices are overdue.').filter(line => !line.startsWith('REPLY')),
    )
  })

  /* "hi" once came back as "Hi! How can I help you today?" twice, one line
     apart: the sentence was in the ledger and in the answer. A sentence the run
     ended on is the reply, and the reply is drawn under the log, not inside it. */
  it('never prints the reply twice', () => {
    assert.deepEqual(shown(ledger(said('s1', 'Hi! How can I help?')), 'Hi! How can I help?'), [
      'REPLY:Hi! How can I help?',
    ])
  })
})

/*
 * A thought used to count as live because it was the last row in the list —
 * and the list was reshaped whenever the answer stream filled or emptied, so a
 * thought swapped its 68px live window for its folded line and back, three
 * times in six frames, for reasons that had nothing to do with the model.
 */
describe('whether the model is still thinking', () => {
  it('is the row\'s own answer, not its position', () => {
    const settled = ledger(thought('t1', 'Two things to check.'), said('s1', 'Checking.', true))
    const open = ledger(thought('t1', 'Two things to check.', true), said('s1', 'Checking.', true))

    assert.equal(shown(settled)[0], 'think:Two things to check.')
    assert.equal(shown(open)[0], 'think*:Two things to check.')
  })

  it('does not change when the answer stream fills', () => {
    const timeline = ledger(thought('t1', 'Two things to check.', true), said('s1', 'Checking.', true))
    assert.deepEqual(shown(timeline, ''), shown(timeline, 'Three are overdue.').slice(0, 2))
  })
})

/*
 * Identity is what lets a renderer leave a row alone. A sentence being marked
 * an aside inserts a beat above the rows below it, and a renderer keyed on
 * position rebuilds every one of them.
 */
describe('what a beat is called', () => {
  it('carries the row\'s own id, so a row keeps its name as the list grows', () => {
    const ids = (timeline: Timeline, answer: string) =>
      beatsFrom(timeline, null, answer).map(beat => beat.id)

    const before = ledger(thought('t1', 'Hm.'), said('s1', 'Checking.'), call('c1', 'Files'))
    const after = ledger(thought('t1', 'Hm.'), said('s1', 'Checking.', true), call('c1', 'Files'))

    // The aside appears; nothing else is renamed by its arrival.
    assert.deepEqual(ids(before, 'Done.'), ['t1', 'c1', 'answer'])
    assert.deepEqual(ids(after, 'Done.'), ['t1', 's1', 'c1', 'answer'])
  })

  /* One reply per run, and it is the same reply from its first word to its
     last — so it keeps one name while the log above it grows underneath. */
  it('gives the reply one name for the whole run', () => {
    const first = beatsFrom(ledger(said('s1', 'Working.', true)), null, 'Three')
    const later = beatsFrom(
      ledger(said('s1', 'Working.', true), call('c1', 'Files')), null, 'Three are overdue.',
    )
    assert.equal(first[first.length - 1]!.id, 'answer')
    assert.equal(later[later.length - 1]!.id, 'answer')
  })
})

/*
 * The row that spawns agents is the only one whose content is underneath it.
 * Read as an ordinary step it lost every agent's state, task and clock — four
 * identical grey words behind a chevron — so it gets its own beat.
 */
describe('a call that farmed its work out', () => {
  it('becomes the agents rather than a step about them', () => {
    const row: LedgerRow = {
      id: 'c9', kind: 'tool', label: 'Subagents', count: 1, status: 'running',
      toolName: 'divo_subagents',
      children: [
        { label: 'scout', status: 'running', outcome: 'read the export', elapsed: '12s' },
        { label: 'reviewer', status: 'done', outcome: 'check the totals' },
      ],
    }
    const [beat] = beatsFrom(ledger(row), null)
    assert.equal(beat!.t, 'agents')
    assert.equal(beat!.id, 'c9')
    assert.deepEqual(beat!.t === 'agents' && beat.run.agents.map(a => a.role), ['scout', 'reviewer'])
  })

  it('leaves every other call a step', () => {
    const [beat] = beatsFrom(ledger(call('c1', 'Files')), null)
    assert.equal(beat!.t, 'step')
  })
})

/*
 * Conversations older than this change were recorded before the run marked its
 * asides. Reading them by the new rule alone would drop every mid-run sentence
 * out of history — so a record with no mark on it is read the old way, which is
 * reliable once nothing is moving.
 */
describe('a conversation recorded before the run marked its asides', () => {
  const replay = (...rows: LedgerRow[]) => exchangesFrom([
    { id: 'u1', role: 'user', text: 'How are the invoices?', at: '' },
    { id: 'a1', role: 'assistant', text: 'Three invoices are overdue.', at: '', run: { ledger: rows, elapsedMs: 900 } },
  ])[0]!.beats.map(beat => (
    beat.t === 'say' ? `${beat.narration ? 'aside' : 'REPLY'}:${beat.text}` : `step:${beat.t}`
  ))

  it('keeps what the model said on the way, and still prints the reply once', () => {
    assert.deepEqual(
      replay(
        said('s1', 'Let me check Zoho Books.'),
        call('c1', 'Zoho Books'),
        said('s2', 'Three invoices are overdue.'),
      ),
      ['aside:Let me check Zoho Books.', 'step:step', 'REPLY:Three invoices are overdue.'],
    )
  })

  it('leaves a record that does carry the mark exactly as it was written', () => {
    assert.deepEqual(
      replay(said('s1', 'Only an aside.', true), call('c1', 'Files'), said('s2', 'The reply.')),
      ['aside:Only an aside.', 'step:step', 'REPLY:Three invoices are overdue.'],
    )
  })
})
