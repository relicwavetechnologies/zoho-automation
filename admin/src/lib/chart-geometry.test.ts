import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHART_GEOMETRY_SOURCE, dotColumns, hexCells, niceScale, shareAssignment,
} from './chart-geometry'

/** The geometry as a document frame receives it: source text, evaluated. */
function evaluated(): Record<string, (...args: never[]) => unknown> {
  const names = ['niceNum', 'niceScale', 'hexCells', 'shareAssignment', 'dotColumns']
  return new Function(
    `${CHART_GEOMETRY_SOURCE}\nreturn { ${names.join(', ')} };`,
  )() as Record<string, (...args: never[]) => unknown>
}

describe('chart geometry', () => {
  it('survives being serialised for the document frame', () => {
    /* The assertion the whole arrangement rests on. These functions are pasted
       into a sandboxed frame as text, so any reference to an import, a closure
       or a module-level constant resolves to nothing there while looking
       perfectly fine in this file. Running the serialised text is the only way
       to find that out. */
    const frame = evaluated()

    for (const name of ['niceNum', 'niceScale', 'hexCells', 'shareAssignment', 'dotColumns']) {
      assert.equal(typeof frame[name], 'function', `${name} did not survive serialisation`)
    }

    // And it computes the same answers, not merely the same shapes.
    assert.deepEqual(frame.niceScale?.(0 as never, 47 as never, 5 as never), niceScale(0, 47, 5))
    assert.deepEqual(
      frame.shareAssignment?.([9, 51] as never, 100 as never, 0.58 as never),
      shareAssignment([9, 51], 100, 0.58),
    )
    assert.deepEqual(
      frame.dotColumns?.([0, 100] as never, 0 as never, 100 as never, 8 as never, 22 as never),
      dotColumns([0, 100], 0, 100, 8, 22),
    )
    assert.deepEqual(frame.hexCells?.(4 as never, 3 as never, 10 as never), hexCells(4, 3, 10))
  })

  it('rounds an axis outward to a step a person would have picked', () => {
    // 0..47 is not a scale anyone draws by hand; 0..50 by 10 is.
    assert.deepEqual(niceScale(0, 47, 5), { min: 0, max: 50, step: 10 })
    // A flat series still gets a usable axis rather than a zero-height one.
    assert.equal(niceScale(5, 5, 5).max > 5, true)
  })

  it('orders hex cells from the centre outward', () => {
    const cells = hexCells(10, 7, 10)
    const middle = { x: cells[0]!.width / 2, y: cells[0]!.height / 2 }
    const near = Math.hypot(cells[0]!.x - middle.x, cells[0]!.y - middle.y)
    const far = Math.hypot(
      cells[cells.length - 1]!.x - middle.x, cells[cells.length - 1]!.y - middle.y,
    )
    assert.equal(cells.length, 70)
    assert.ok(near < far, 'the first cell must be nearer the centre than the last')
  })

  it('gives the smallest share the core and the largest the remainder', () => {
    const assignment = shareAssignment([51, 9], 100, 0.58)
    const filled = assignment.filter(one => one >= 0)

    assert.equal(assignment[0], 1, 'index 1 is the smaller value, so it takes the core')
    assert.equal(filled.length, 58)
    // 9 of 60 is 15% of 58 tiles, rounded; the larger share takes what is left,
    // so the two always total the filled count exactly.
    assert.equal(assignment.filter(one => one === 1).length, 9)
    assert.equal(assignment.filter(one => one === 0).length, 49)
  })

  it('lights a dot column in proportion to its value', () => {
    const lit = dotColumns([0, 100], 0, 100, 5, 20)
    assert.deepEqual(lit, [0, 5, 10, 15, 20])
  })
})
