import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fitsBesideThread, planOf, planStatus } from './plan'
import type { Timeline } from './stream'

const timeline = (
  items: { title: string; status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' }[],
): Timeline => ({
  /* Sent on the same value and deliberately wrong here, because nothing in this
     module is allowed to read them. */
  declared: { done: 99, total: 99, items },
})

describe('reading a plan off the wire', () => {
  it('says nothing when the model never declared one', () => {
    // The common case: a single lookup needs no checklist, and a panel that
    // appeared for every message would be furniture.
    assert.equal(planOf(null, true), null)
    assert.equal(planOf({}, true), null)
    assert.equal(planOf(timeline([]), true), null)
  })

  it('counts the list it is drawing, not the numbers sent beside it', () => {
    const plan = planOf(timeline([
      { title: 'Pull last week’s closed deals', status: 'done' },
      { title: 'Summarise by owner', status: 'running' },
      { title: 'Write it to a sheet', status: 'pending' },
    ]), true)!

    assert.equal(plan.total, 3)
    assert.equal(plan.done, 1)
    assert.equal(planStatus(plan), '2 steps left')
  })

  it('counts a skipped step as disposed of rather than as outstanding', () => {
    // The opposite call to the one `agents.ts` makes about a cancelled agent,
    // and on purpose: this is the model saying a step turned out not to be
    // needed, which is the plan progressing.
    const plan = planOf(timeline([
      { title: 'Check for an existing invoice', status: 'done' },
      { title: 'Create one', status: 'skipped' },
    ]), false)!

    assert.equal(plan.done, 2)
    assert.equal(planStatus(plan), 'Done')
  })

  it('keeps a failure out of the count and beside it', () => {
    const plan = planOf(timeline([
      { title: 'Read the sheet', status: 'done' },
      { title: 'Post to Zoho', status: 'failed' },
    ]), false)!

    assert.equal(plan.done, 1)
    assert.equal(plan.failed, 1)
    assert.equal(planStatus(plan), '1 of 2 failed')
  })
})

describe('which step is live', () => {
  it('marks exactly one, and the last to claim it', () => {
    // `divo_todos` demotes earlier ones itself; this agrees with the tool
    // rather than trusting a plan that reached here from somewhere that does
    // not. Two loaders in one panel is the failure being prevented.
    const plan = planOf(timeline([
      { title: 'One', status: 'running' },
      { title: 'Two', status: 'running' },
      { title: 'Three', status: 'pending' },
    ]), true)!

    assert.deepEqual(plan.steps.map(s => s.active), [false, true, false])
    assert.equal(plan.current, 1)
  })

  it('stops spinning the moment the run is over', () => {
    /* The bug this exists to prevent: a stopped run leaves its last timeline
       behind with a step still marked running, and a panel keying its loader
       off the state alone spins forever on a step nothing is doing. */
    const items = [
      { title: 'Fetch the orders', status: 'done' as const },
      { title: 'Reconcile them', status: 'running' as const },
    ]

    const live = planOf(timeline(items), true)!
    assert.equal(live.current, 0 + 1)
    assert.equal(live.steps[1]!.active, true)
    assert.equal(live.settled, false)

    const stopped = planOf(timeline(items), false)!
    assert.equal(stopped.current, null)
    assert.equal(stopped.steps[1]!.active, false)
    assert.equal(stopped.settled, true)
    // Still 'running' — the wire said so, and the panel needs to be able to
    // show a step that never finished as exactly that.
    assert.equal(stopped.steps[1]!.state, 'running')
    assert.equal(planStatus(stopped), 'Stopped · 1 left')
  })

  it('does not call a full plan done while the run is still writing', () => {
    // The model marks the last step done and then writes the answer. Saying
    // "Done" through the part the reader is actually waiting for is the panel
    // lying at the one moment they are looking at it.
    const items = [{ title: 'Draft the reply', status: 'done' as const }]
    assert.equal(planStatus(planOf(timeline(items), true)!), 'Finishing up')
    assert.equal(planStatus(planOf(timeline(items), false)!), 'Done')
  })
})

/**
 * The panel floats over the conversation, so "does it fit" decides whether it
 * opens showing its steps or collapsed to the ring and the count. Pure
 * arithmetic, and easy to get wrong in the direction nobody notices — a panel
 * that collapses on a window where it plainly fits.
 */
describe('whether the plan panel clears the thread', () => {
  it('fits on a wide window', () => {
    assert.equal(fitsBesideThread(1440), true)
    assert.equal(fitsBesideThread(1920), true)
  })

  it('fits at the width the spacing complaint came from', () => {
    // 1324px leaves a 42px gap. Measuring to the column's edge rather than to
    // its text makes this 302 against 312 and collapses it, which is exactly
    // the first attempt at this and the reason the padding is in the formula.
    assert.equal(fitsBesideThread(1324), true)
  })

  it('gives up on a laptop-width pane rather than sitting on the text', () => {
    // At 1180 the panel would overlap the conversation by 30px.
    assert.equal(fitsBesideThread(1180), false)
    assert.equal(fitsBesideThread(1024), false)
  })

  it('turns over exactly where the gap runs out', () => {
    assert.equal(fitsBesideThread(1288), true)
    assert.equal(fitsBesideThread(1286), false)
  })
})
