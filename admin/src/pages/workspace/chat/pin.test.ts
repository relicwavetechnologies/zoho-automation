import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reserveFor } from './pin'

/*
 * The one number in the pinned-prompt feature. Everything else is a measurement
 * the browser hands over; this is the judgement, and it is invisible when wrong
 * — too small and the message never reaches the top, too large and the reader
 * scrolls through blank space to find the end of the answer.
 */
describe('reserving room to pin a prompt to the top', () => {
  it('leaves exactly enough for a short exchange to reach the top', () => {
    // A 900px window, a 100px ask with a 60px reply under it, 52px of header.
    assert.equal(reserveFor({ viewport: 900, belowPin: 160, topGap: 52 }), 688)
    // 688 + 160 + 52 === 900: the pin lands precisely under the header.
  });

  /* The point at which the feature switches itself off. A reply that already
     fills the screen needs no help reaching the top, and reserving anything
     past this would be padding the reader has to scroll through. */
  it('reserves nothing once the reply already fills the screen', () => {
    assert.equal(reserveFor({ viewport: 900, belowPin: 848, topGap: 52 }), 0)
    assert.equal(reserveFor({ viewport: 900, belowPin: 4000, topGap: 52 }), 0)
  })

  // Never negative: a negative height is not a shorter thread, it is a crash.
  it('never asks for negative space', () => {
    assert.ok(reserveFor({ viewport: 100, belowPin: 5000, topGap: 52 }) >= 0)
    assert.ok(reserveFor({ viewport: 0, belowPin: 0, topGap: 52 }) >= 0)
  })

  /* The gap is what keeps the message clear of the header it would otherwise
     sit behind, so it has to come out of the reserve rather than be assumed. */
  it('keeps the header\'s own height clear of the pinned message', () => {
    const withHeader = reserveFor({ viewport: 900, belowPin: 160, topGap: 52 })
    const without = reserveFor({ viewport: 900, belowPin: 160, topGap: 0 })
    assert.equal(without - withHeader, 52)
  })
})
