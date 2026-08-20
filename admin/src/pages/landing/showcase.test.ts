import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { REEL_LENGTH, RUNS, frameAt, runLength, stopOf, tickOf } from './showcase'

describe('frameAt', () => {
  it('starts on the first run with one step showing', () => {
    assert.deepEqual(frameAt(0), { run: 0, steps: 1 })
  })

  it('reveals one step per tick', () => {
    assert.equal(frameAt(0).steps, 1)
    assert.equal(frameAt(1).steps, 2)
  })

  it('holds the finished run rather than jumping straight on', () => {
    const first = RUNS[0]!
    /* Still on run 0, still showing all of it, for the whole hold. */
    for (let tick = first.steps.length - 1; tick < runLength(first) - 1; tick += 1) {
      assert.deepEqual(frameAt(tick), { run: 0, steps: first.steps.length }, `tick ${tick}`)
    }
  })

  it('moves to the next run when the hold is up', () => {
    assert.equal(frameAt(runLength(RUNS[0]!)).run, 1)
  })

  it('never shows more steps than the run has', () => {
    for (let tick = 0; tick < REEL_LENGTH * 2; tick += 1) {
      const frame = frameAt(tick)
      assert.ok(frame.steps <= RUNS[frame.run]!.steps.length, `tick ${tick}`)
      assert.ok(frame.steps >= 1, `tick ${tick}`)
    }
  })

  it('wraps rather than running off the end', () => {
    assert.deepEqual(frameAt(REEL_LENGTH), frameAt(0))
    assert.deepEqual(frameAt(REEL_LENGTH * 3 + 2), frameAt(2))
  })

  it('survives a timer that ran while the tab was hidden', () => {
    assert.deepEqual(frameAt(1e6), frameAt(1e6 % REEL_LENGTH))
  })

  it('answers for nonsense rather than throwing', () => {
    assert.deepEqual(frameAt(-1), { run: 0, steps: 0 })
    assert.deepEqual(frameAt(Number.NaN), { run: 0, steps: 0 })
    assert.deepEqual(frameAt(Number.POSITIVE_INFINITY), { run: 0, steps: 0 })
  })
})

describe('tickOf', () => {
  it('lands on the first frame of the run it names', () => {
    RUNS.forEach((_, index) => {
      assert.equal(frameAt(tickOf(index)).run, index)
      assert.equal(frameAt(tickOf(index)).steps, 1)
    })
  })

  it('starts the reel at zero', () => {
    assert.equal(tickOf(0), 0)
  })
})

describe('stopOf', () => {
  it('reports nothing for a run that finished on its own', () => {
    assert.equal(stopOf(RUNS.find((r) => r.id === 'runs')!), null)
  })

  it('tells a held action apart from a denied one', () => {
    assert.equal(stopOf(RUNS.find((r) => r.id === 'you')!), 'held')
    assert.equal(stopOf(RUNS.find((r) => r.id === 'approver')!), 'held')
    assert.equal(stopOf(RUNS.find((r) => r.id === 'blocked')!), 'denied')
  })
})

describe('the reel itself', () => {
  it('covers all four gate outcomes, which is the whole point of it', () => {
    /* Runs, you confirm, your approver confirms, blocked. Losing one of these
       turns the panel back into a demo of the happy path. */
    assert.deepEqual(RUNS.map((run) => run.id), ['runs', 'you', 'approver', 'blocked'])
  })

  it('explains every stop it shows', () => {
    for (const run of RUNS) {
      for (const step of run.steps) {
        if (step.tone === 'ran') continue
        assert.ok(step.note, `${run.id}: a stop with no reason is the bug this reel is about`)
      }
    }
  })

  it('gives every run a lesson and a named seat', () => {
    for (const run of RUNS) {
      assert.ok(run.lesson.length > 0, run.id)
      assert.ok(run.who.length > 0, run.id)
    }
  })
})
