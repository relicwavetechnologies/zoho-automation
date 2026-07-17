import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GOOGLE_RUNNER_SYSTEM } from '../../src/application/orchestration/agent-runners/prompts/google.prompt.ts';

describe('Google runner system prompt', () => {
  it('uses direct governed product guidance rather than desktop staged planning', () => {
    assert.doesNotMatch(GOOGLE_RUNNER_SYSTEM, /google\.plan/);
    assert.match(GOOGLE_RUNNER_SYSTEM, /selected product tool/i);
    assert.match(GOOGLE_RUNNER_SYSTEM, /PRODUCT ROUTING AND APPROVED OPERATIONS/);
    assert.match(GOOGLE_RUNNER_SYSTEM, /googleGmail/);
    assert.match(GOOGLE_RUNNER_SYSTEM, /create_doc -> modify_doc_text/);
  });
});
