import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LARK_RUNNER_SYSTEM, LARK_TOOL_IDS } from '../../src/application/orchestration/agent-runners/prompts/lark.prompt.ts';

describe('Lark runner prompt', () => {
  it('exposes contacts as a first-class Lark tool', () => {
    assert.equal(LARK_TOOL_IDS.has('larkContacts'), true);
    assert.match(LARK_RUNNER_SYSTEM, /larkContacts/);
    assert.match(LARK_RUNNER_SYSTEM, /Same-name users are ambiguity/i);
  });

  it('tells the agent to prefer markdown doc creation and return URLs', () => {
    assert.match(LARK_RUNNER_SYSTEM, /create_markdown/);
    assert.match(LARK_RUNNER_SYSTEM, /URL\/docUrl/);
  });
});
