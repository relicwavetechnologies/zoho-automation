import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coalesceSegments, traceSteps } from './lifecycle'
import type { Beat } from './beats'

const call = (title: string, key: Extract<Beat, { t: 'step' }>['tool'] = 'zohoBooks'): Beat => ({
  t: 'step', tool: key, title, done: 'Done',
})
const agents = (): Beat => ({
  t: 'agents',
  run: { running: true, agents: [], done: 0, total: 0, active: 0, failed: 0 },
})
const thought = (text: string): Beat => ({ t: 'think', text })
const narration = (text: string): Beat => ({ t: 'say', text, narration: true })

describe('reading a turn as what it did', () => {
  it('names each kind of thing the run did on the way', () => {
    const trace = traceSteps([
      thought('Which system holds invoices?'),
      narration('Let me check.'),
      call('Zoho Books'),
      agents(),
    ])
    assert.deepEqual(trace.map(s => s.kind), ['thought', 'narration', 'tool', 'agents'])
  })

  /* Total, which it did not use to be. This took a list holding the log AND the
     answer and pulled them apart — having been handed them glued together one
     step earlier. They are now built separately and never meet, so every beat
     that arrives here has a step to become and nothing is dropped. */
  it('keeps every beat, at its own index', () => {
    const trace = traceSteps([narration('hi'), call('Gmail'), thought('bye')])
    assert.deepEqual(trace.map(s => s.index), [0, 1, 2])
  })

  it('has no trace for a turn that answered without working', () => {
    assert.deepEqual(traceSteps([]), [])
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
    const trace = traceSteps([call('Zoho Books'), call('Zoho Books'), call('Zoho Books')])
    const segments = coalesceSegments(trace)
    assert.equal(segments.length, 1)
    assert.equal(segments[0]!.kind === 'tools' && segments[0]!.steps.length, 3)
  })

  /* The defect from the screenshot: four unrelated calls with nothing said
     between them are one burst, and the summary has to admit that rather than
     claim they were one act against one system. */
  it('breaks a burst wherever the model said or thought something', () => {
    const trace = traceSteps([
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
    const trace = traceSteps([call('Zoho Books'), thought('   '), call('Zoho Books')])
    const segments = coalesceSegments(trace)
    assert.equal(segments.length, 1)
    assert.equal(segments[0]!.kind === 'tools' && segments[0]!.steps.length, 2)
  })

  it('has nothing to collect in a turn that did nothing', () => {
    assert.deepEqual(coalesceSegments([]), [])
  })

  /* A burst folds to "Ran 3 commands". Folding the agents in would hide a live
     list of four of them behind a count and a chevron — the one row in the log
     whose whole content is underneath it. It breaks the burst rather than
     joining it, so the calls either side keep the order they happened in. */
  it('never folds the agents a call spawned into a burst', () => {
    const trace = traceSteps([call('Files'), agents(), call('Zoho Books')])
    assert.deepEqual(
      coalesceSegments(trace).map(s => s.kind === 'tools' ? s.steps.length : s.kind),
      [1, 'agents', 1],
    )
  })
})
