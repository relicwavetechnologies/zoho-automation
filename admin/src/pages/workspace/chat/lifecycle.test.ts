import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coalesceSegments, splitTrace } from './lifecycle'
import type { Beat } from './transcripts'

const call = (title: string, key: Beat extends { tool: infer K } ? K : never = 'zohoBooks'): Beat => ({
  t: 'step', tool: key, title, ms: 0, lines: [], done: 'Done',
})
const thought = (text: string): Beat => ({ t: 'think', text })
const narration = (text: string): Beat => ({ t: 'say', text, narration: true })
const answer = (text: string): Beat => ({ t: 'say', text })

describe('splitting a turn into what it did and what it produced', () => {
  it('puts calls, thinking and mid-run talking in the trace, and nothing else', () => {
    const { trace, rest } = splitTrace([
      thought('Which system holds invoices?'),
      narration('Let me check.'),
      call('Zoho Books'),
      answer('Four are unpaid.'),
    ])
    assert.deepEqual(trace.map(s => s.kind), ['thought', 'narration', 'tool'])
    assert.deepEqual(rest.map(r => r.beat.t), ['say'])
  })

  /* The indices address the original beat list — the exchange's own state is
     keyed by them, so a split that renumbered would answer questions about the
     wrong beat. */
  it('keeps every beat at its original index', () => {
    const { trace, rest } = splitTrace([answer('hi'), call('Gmail'), answer('bye')])
    assert.deepEqual(trace.map(s => s.index), [1])
    assert.deepEqual(rest.map(r => r.index), [0, 2])
  })

  it('has no trace for a turn that answered without working', () => {
    const { trace, rest } = splitTrace([answer('Hi! How can I help?')])
    assert.deepEqual(trace, [])
    assert.equal(rest.length, 1)
  })
})

/*
 * The rule, and the thing that was wrong before it was ported literally:
 * adjacency decides a burst, and talking of either kind breaks it. It does NOT
 * group by vendor — which is why the model saying something between two groups
 * of calls is what actually separates them on screen.
 */
describe('collecting a run of calls into a burst', () => {
  it('collects calls that ran back to back', () => {
    const { trace } = splitTrace([call('Zoho Books'), call('Zoho Books'), call('Zoho Books')])
    const segments = coalesceSegments(trace)
    assert.equal(segments.length, 1)
    assert.equal(segments[0]!.kind === 'tools' && segments[0]!.steps.length, 3)
  })

  /* The defect from the screenshot: four unrelated calls with nothing said
     between them are one burst, and the summary has to admit that rather than
     claim they were one act against one system. */
  it('breaks a burst wherever the model said or thought something', () => {
    const { trace } = splitTrace([
      call('Files'), thought('Now the accounting system.'),
      call('Zoho Books'), call('Zoho Books'),
      narration('Both came back empty.'),
      call('Zoho Books'),
    ])
    assert.deepEqual(
      coalesceSegments(trace).map(s => s.kind === 'tools' ? s.steps.length : s.step.kind),
      [1, 'thought', 2, 'narration', 1],
    )
  })

  /* Empty talk is not a step. A reasoning block that arrived with nothing in it
     would otherwise split a burst in two and show a blank line doing it. */
  it('ignores talking with nothing in it', () => {
    const { trace } = splitTrace([call('Zoho Books'), thought('   '), call('Zoho Books')])
    const segments = coalesceSegments(trace)
    assert.equal(segments.length, 1)
    assert.equal(segments[0]!.kind === 'tools' && segments[0]!.steps.length, 2)
  })

  it('has nothing to collect in a turn that did nothing', () => {
    assert.deepEqual(coalesceSegments([]), [])
  })
})
