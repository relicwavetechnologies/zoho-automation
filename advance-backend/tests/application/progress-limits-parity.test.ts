import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boundProgressText,
  PROGRESS_BOUNDS,
  PROGRESS_LIST_LIMITS,
} from '../../src/application/runtime/progress-limits';
import {
  boundedProgressText as containerBoundedProgressText,
  PROGRESS_BOUNDS as CONTAINER_PROGRESS_BOUNDS,
  PROGRESS_LIST_LIMITS as CONTAINER_PROGRESS_LIST_LIMITS,
} from '../../../divo-pi/divo/runtime-progress-limits.mjs';

/**
 * The two ends of one wire, held to one table.
 *
 * The container cannot import backend code, so each side states the bounds
 * itself — which is exactly the arrangement that let two of them drift apart
 * unnoticed. This is the guard that makes drift loud: it reads both files and
 * fails on any difference, in the number or in the direction.
 *
 * The direction is checked by running text through both implementations rather
 * than by comparing the `keep` strings alone. Agreeing on the word "tail" and
 * disagreeing about what a tail is would pass a shallower test, and it is the
 * behaviour, not the label, that froze the reasoning window.
 */
describe('progress bound parity across the container wall', () => {
  it('states the same bounds on both sides', () => {
    assert.deepEqual(
      structuredClone(PROGRESS_BOUNDS),
      structuredClone(CONTAINER_PROGRESS_BOUNDS),
    );
    assert.deepEqual(
      structuredClone(PROGRESS_LIST_LIMITS),
      structuredClone(CONTAINER_PROGRESS_LIST_LIMITS),
    );
  });

  it('cuts identical text identically, bound for bound', () => {
    // Word-shaped, so a tail cut has boundaries to land on, and far longer than
    // the largest bound so every one of them actually fires.
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');

    for (const name of Object.keys(PROGRESS_BOUNDS) as (keyof typeof PROGRESS_BOUNDS)[]) {
      const mine = boundProgressText(long, name);
      const theirs = containerBoundedProgressText(long, CONTAINER_PROGRESS_BOUNDS[name]);
      assert.equal(mine, theirs, `${name} is cut differently on the two sides`);
      assert.ok(mine!.length <= PROGRESS_BOUNDS[name].max, `${name} exceeds its own bound`);
    }
  });

  /*
   * The bug this whole table exists to prevent, pinned as behaviour.
   *
   * Reasoning accumulates from the start and is re-sent in full on every delta.
   * Cut from the front, two different lengths of the same growing text produce
   * the same string — so the published value stops changing and the surface
   * draws a run that has visibly stopped. Cut from the back, they differ.
   */
  it('keeps a growing thought moving, and a growing label still', () => {
    const grow = (words: number) =>
      Array.from({ length: words }, (_, i) => `word${i}`).join(' ');

    assert.notEqual(
      boundProgressText(grow(400), 'thought'),
      boundProgressText(grow(800), 'thought'),
      'a thought must not freeze once it passes its bound',
    );
    assert.equal(
      boundProgressText(grow(400), 'label'),
      boundProgressText(grow(800), 'label'),
      'a label is a whole short thing; its front is the part worth keeping',
    );
  });

  it('marks which end was cut, so a window reads as a window', () => {
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    assert.ok(boundProgressText(long, 'label')!.endsWith('…'));
    assert.ok(boundProgressText(long, 'thought')!.startsWith('…'));
  });

  it('opens a cut thought on a whole word', () => {
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const cut = boundProgressText(long, 'thought')!;
    assert.match(cut, /^…word\d+ /);
  });

  /* An unbroken run of characters has no word boundary to open on. Dropping
     everything up to a space that is not there would return the ellipsis and
     nothing else. */
  it('keeps the tail of a value with no spaces in it at all', () => {
    const solid = 'x'.repeat(4_000);
    const cut = boundProgressText(solid, 'thought')!;
    assert.equal(cut, `…${'x'.repeat(PROGRESS_BOUNDS.thought.max - 1)}`);
  });
});
