import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asUserFacing, userFacingMessageOf } from '../../src/shared/user-facing-error.ts';

describe('userFacingMessageOf', () => {
  it('returns nothing for an ordinary error', () => {
    // The default has to be silence. Most failures carry provider payloads and
    // internal identifiers, and showing them by accident is worse than a
    // generic apology.
    assert.equal(userFacingMessageOf(new Error('ECONNRESET at 10.0.0.4:5432')), null);
  });

  it('returns the message an error opted into', () => {
    const error = asUserFacing(new Error('denied'), 'Pro is not enabled for this account.');
    assert.equal(userFacingMessageOf(error), 'Pro is not enabled for this account.');
  });

  it('finds it through a wrapper', () => {
    // The error that reaches the surface is rarely the one that knew why: a
    // policy refusal arrives wrapped in an orchestration error.
    const inner = asUserFacing(new Error('denied'), 'Monthly budget reached.');
    const outer = new Error('Supervisor LLM failed: denied', { cause: inner });
    assert.equal(userFacingMessageOf(outer), 'Monthly budget reached.');
  });

  it('does not treat an enumerable message property as consent', () => {
    // Only the symbol counts. A plain `userMessage` field on some upstream
    // payload must not become something Divo repeats to a user.
    const impostor = Object.assign(new Error('nope'), {
      userMessage: 'internal: token abc123',
    });
    assert.equal(userFacingMessageOf(impostor), null);
  });

  it('ignores an empty marker', () => {
    assert.equal(userFacingMessageOf(asUserFacing(new Error('x'), '   ')), null);
  });

  it('terminates on a self-referencing cause', () => {
    const looped: Error & { cause?: unknown } = new Error('loop');
    looped.cause = looped;
    assert.equal(userFacingMessageOf(looped), null);
  });

  it('does not leak the marker into serialization', () => {
    const error = asUserFacing(new Error('denied'), 'shown to the user');
    assert.deepEqual(Object.keys(error), []);
  });
});
