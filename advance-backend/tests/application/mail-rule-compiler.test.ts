import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJson } from '../../src/application/mail-ops/mail-rule-compiler';

describe('extractJson', () => {
  it('reads a bare object', () => {
    assert.deepEqual(extractJson('{"understood":false,"reason":"x"}'), {
      understood: false, reason: 'x',
    });
  });

  it('reads it out of a code fence', () => {
    // Models fence JSON however firmly they are told not to, and a rule that
    // fails because of three backticks is a rule the member has to describe
    // twice for no reason they can see.
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  it('reads it out from behind a sentence', () => {
    assert.deepEqual(extractJson('Here you go:\n{"a":1}'), { a: 1 });
  });

  it('throws when there is no object at all', () => {
    assert.throws(() => extractJson('I could not do that.'));
  });
});
