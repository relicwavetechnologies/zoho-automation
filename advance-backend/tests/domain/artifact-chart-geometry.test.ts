import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHART_GEOMETRY_SOURCE, dotColumns, hexCells, niceScale, shareAssignment,
} from '../../src/domain/artifact/chart-geometry';

/**
 * The geometry as a document frame receives it: source text, evaluated.
 *
 * This test exists because the backend now owns the copy that reaches a
 * published page, and the port from `admin/` left it behind. Without it, the
 * one failure mode this arrangement has goes unwatched.
 */
function evaluated(): Record<string, (...args: never[]) => unknown> {
  const names = ['niceNum', 'niceScale', 'hexCells', 'shareAssignment', 'dotColumns'];
  return new Function(
    `${CHART_GEOMETRY_SOURCE}\nreturn { ${names.join(', ')} };`,
  )() as Record<string, (...args: never[]) => unknown>;
}

describe('chart geometry', () => {
  it('survives being serialised for the document frame', () => {
    /* The assertion the whole arrangement rests on. These functions are pasted
       into a page as text, so any reference to an import, a closure or a
       module-level constant resolves to nothing there while looking perfectly
       fine in this file. The same goes for TypeScript-only syntax: a `!` or a
       type annotation reads fine here and is a syntax error in the frame.
       Running the serialised text is the only way to find that out. */
    const frame = evaluated();

    for (const name of ['niceNum', 'niceScale', 'hexCells', 'shareAssignment', 'dotColumns']) {
      assert.equal(typeof frame[name], 'function', `${name} did not survive serialisation`);
    }
  });

  it('computes the same answers in the frame as it does here', () => {
    const frame = evaluated();

    assert.deepEqual(
      frame.niceScale?.(0 as never, 47 as never, 5 as never),
      niceScale(0, 47, 5),
    );
    assert.deepEqual(
      frame.hexCells?.(24 as never, 5 as never),
      hexCells(24, 5),
    );
    assert.deepEqual(
      frame.shareAssignment?.([3, 1, 6] as never, 40 as never, 0.75 as never),
      shareAssignment([3, 1, 6], 40, 0.75),
    );
    assert.deepEqual(
      frame.dotColumns?.([1, 9, 4, 7] as never, 0 as never, 10 as never, 12 as never, 6 as never),
      dotColumns([1, 9, 4, 7], 0, 10, 12, 6),
    );
  });

  it('draws an empty series without throwing', () => {
    /* The bounds the `noUncheckedIndexedAccess` fallbacks describe. A document
       whose chart has no data must still render as an empty chart rather than
       taking the whole page down with it — the frame has no error handling. */
    assert.doesNotThrow(() => dotColumns([], 0, 1, 8, 4));
    assert.doesNotThrow(() => shareAssignment([], 20, 0.5));
    assert.doesNotThrow(() => dotColumns([5], 0, 10, 8, 4));
  });
});
