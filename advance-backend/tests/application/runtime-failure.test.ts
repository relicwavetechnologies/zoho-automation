import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GENERIC_RUNTIME_FAILURE_MESSAGE,
  explainRuntimeFailure,
} from '../../src/application/runtime/runtime-failure';

/** Exactly what a workspace with no model key produced, wrapper and all. */
const NO_KEY_DETAIL =
  'Assistant error: 503: {"message":"The AI proxy has no DeepSeek key configured. Add one in Guardrails.","type":"not_configured"}';

describe('explainRuntimeFailure', () => {
  it('says which key is missing and where to add it', () => {
    const failure = explainRuntimeFailure('model_continuation_failed', NO_KEY_DETAIL);
    assert.match(failure.message, /DeepSeek key/);
    assert.match(failure.message, /Guardrails/);
    assert.equal(failure.retryable, false);
  });

  it('does not invite a retry that cannot possibly work', () => {
    /* The bug this module exists for: the reader was told "Please try again"
       under a missing API key, three times, over ten seconds. */
    const failure = explainRuntimeFailure('model_continuation_failed', NO_KEY_DETAIL);
    assert.doesNotMatch(failure.message, /try again/i);
  });

  it('says nothing reached a model, because nothing did', () => {
    const failure = explainRuntimeFailure('model_continuation_failed', NO_KEY_DETAIL);
    assert.match(failure.message, /Nothing was sent to a model/);
  });

  it('prefers the cause over the shape of the failure', () => {
    /* Same controller code, different gateway type: the answer must come from
       the type, or every refusal reads as a lost connection again. */
    const configured = explainRuntimeFailure('model_continuation_failed', NO_KEY_DETAIL);
    const denied = explainRuntimeFailure(
      'model_continuation_failed',
      'Assistant error: 403: {"message":"Model deepseek-v4 is off for Support","type":"guardrails"}',
    );
    assert.notEqual(configured.message, denied.message);
    assert.match(denied.message, /Model deepseek-v4 is off for Support/);
  });

  it('reads the gateway body whether or not it is wrapped in `error`', () => {
    const wrapped = explainRuntimeFailure(
      'model_continuation_failed',
      '{"error":{"message":"The AI proxy has no DeepSeek key configured.","type":"not_configured"}}',
    );
    assert.match(wrapped.message, /DeepSeek key/);
  });

  it('tells somebody to sign in again when the session is the problem', () => {
    const failure = explainRuntimeFailure('x', '401: {"message":"Unauthenticated","type":"auth"}');
    assert.match(failure.message, /Sign out and back in/);
    assert.equal(failure.retryable, false);
  });

  it('keeps an upstream blip retryable, because it is', () => {
    const failure = explainRuntimeFailure('x', '502: {"message":"Upstream unreachable","type":"upstream"}');
    assert.equal(failure.retryable, true);
    assert.match(failure.message, /try again/i);
  });

  it('still answers the codes that carry no gateway body', () => {
    assert.match(explainRuntimeFailure('capacity_full').message, /full capacity/);
    assert.match(explainRuntimeFailure('user_busy').message, /previous request/);
    assert.match(explainRuntimeFailure('model_continuation_failed').message, /lost the model connection/);
    assert.equal(explainRuntimeFailure('anything_else').message, GENERIC_RUNTIME_FAILURE_MESSAGE);
  });

  it('keeps the after-an-action warning, which is about duplicates not keys', () => {
    const failure = explainRuntimeFailure(
      'model_continuation_failed',
      'The model provider failed after a company action was issued.',
    );
    assert.match(failure.message, /would not duplicate the action/);
    assert.equal(failure.retryable, false);
  });

  it('never throws on a detail it cannot read', () => {
    for (const detail of [undefined, '', 'no json here', '{', '{"type":', 'null', '{"nope":1}', '[]']) {
      const failure = explainRuntimeFailure('model_continuation_failed', detail);
      assert.equal(typeof failure.message, 'string');
      assert.ok(failure.message.length > 0, JSON.stringify(detail));
    }
  });
});
