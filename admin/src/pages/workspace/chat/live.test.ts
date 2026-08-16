import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { exchangesFrom, traceFrom } from './live'
import type { LedgerRow, Timeline } from './stream'

const thought = (id: string, label: string, open = false): LedgerRow =>
  ({ id, kind: 'thought', label, count: 1, status: open ? 'running' : 'done' })
const said = (id: string, label: string, aside?: true): LedgerRow =>
  ({ id, kind: 'say', label, count: 1, status: 'done', ...(aside ? { aside } : {}) })
const call = (id: string, label: string): LedgerRow =>
  ({ id, kind: 'tool', label, count: 1, status: 'done', toolName: 'read' })

const ledger = (...rows: LedgerRow[]): Timeline => ({ ledger: rows })

/**
 * The work log, in the order a reader would see it.
 *
 * It takes no answer, and that is the point: the log and the reply are built
 * from different values now, so "does the log change when the answer stream
 * fills?" is not a question this signature can express. It used to take one,
 * because the two were one array.
 */
const shown = (timeline: Timeline): string[] =>
  traceFrom(timeline).map(step => {
    if (step.kind === 'thought') return `think${step.live ? '*' : ''}:${step.text}`
    if (step.kind === 'narration') return `aside:${step.text}`
    if (step.kind === 'agents') return 'agents'
    return `step:${step.beat.title}`
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

  it('files what the model said on the way, and leaves the reply out of the log', () => {
    assert.deepEqual(shown(midRun), [
      'think:Where are the invoices?',
      'aside:Let me check Zoho Books.',
      'step:Zoho Books',
    ])
  })

  /* "hi" once came back as "Hi! How can I help you today?" twice, one line
     apart: the sentence was in the ledger and in the answer. A sentence the run
     ended on is the reply, and the reply is drawn under the log, not inside it. */
  it('never prints the reply twice', () => {
    assert.deepEqual(shown(ledger(said('s1', 'Hi! How can I help?'))), [])
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

})

/*
 * Identity is what lets a renderer leave a row alone. A sentence being marked
 * an aside inserts a beat above the rows below it, and a renderer keyed on
 * position rebuilds every one of them.
 */
describe('what a row in the log is called', () => {
  it('carries the row\'s own id, so a row keeps its name as the list grows', () => {
    const keys = (timeline: Timeline) => traceFrom(timeline).map(step => step.key)

    const before = ledger(thought('t1', 'Hm.'), said('s1', 'Checking.'), call('c1', 'Files'))
    const after = ledger(thought('t1', 'Hm.'), said('s1', 'Checking.', true), call('c1', 'Files'))

    // The aside appears; nothing else is renamed by its arrival.
    assert.deepEqual(keys(before), ['t1', 'c1'])
    assert.deepEqual(keys(after), ['t1', 's1', 'c1'])
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
    const [step] = traceFrom(ledger(row))
    assert.equal(step!.kind, 'agents')
    assert.equal(step!.key, 'c9')
    assert.deepEqual(
      step!.kind === 'agents' && step.beat.run.agents.map(a => a.role),
      ['scout', 'reviewer'],
    )
  })

  it('leaves every other call a step', () => {
    const [step] = traceFrom(ledger(call('c1', 'Files')))
    assert.equal(step!.kind, 'tool')
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
  ])[0]!
  const replayLog = (...rows: LedgerRow[]) => replay(...rows).trace.map(step => (
    step.kind === 'narration' ? `aside:${step.text}` : `step:${step.kind}`
  ))

  it('keeps what the model said on the way, and still prints the reply once', () => {
    const exchange = replay(
      said('s1', 'Let me check Zoho Books.'),
      call('c1', 'Zoho Books'),
      said('s2', 'Three invoices are overdue.'),
    )
    assert.deepEqual(
      replayLog(
        said('s1', 'Let me check Zoho Books.'),
        call('c1', 'Zoho Books'),
        said('s2', 'Three invoices are overdue.'),
      ),
      ['aside:Let me check Zoho Books.', 'step:tool'],
    )
    // The reply is the turn's own text, held apart from the log rather than
    // sitting at the end of it.
    assert.equal(exchange.answer, 'Three invoices are overdue.')
  })

  it('leaves a record that does carry the mark exactly as it was written', () => {
    assert.deepEqual(
      replayLog(said('s1', 'Only an aside.', true), call('c1', 'Files'), said('s2', 'The reply.')),
      ['aside:Only an aside.', 'step:tool'],
    )
  })
})
