import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LARK_ENGLISH_OUTPUT_POLICY } from '../../src/application/orchestration/lark-language-policy.ts';
import { buildBrainSystemPrompt } from '../../src/application/orchestration/brain-prompt.ts';
import { buildSupervisorSystemPrompt } from '../../src/application/orchestration/agents/supervisor.prompt.ts';
import { LARK_RUNNER_SYSTEM } from '../../src/application/orchestration/agent-runners/prompts/lark.prompt.ts';

describe('Lark English output policy', () => {
  it('is present in every primary server Lark prompt', () => {
    const brain = buildBrainSystemPrompt({ skillCatalog: '- Lark Docs', currentDateTime: 'now' });
    const supervisor = buildSupervisorSystemPrompt();

    assert.match(LARK_ENGLISH_OUTPUT_POLICY, /Always reply in English/);
    assert.match(LARK_ENGLISH_OUTPUT_POLICY, /Never switch to Chinese/);
    assert.ok(brain.includes(LARK_ENGLISH_OUTPUT_POLICY));
    assert.ok(supervisor.includes(LARK_ENGLISH_OUTPUT_POLICY));
    assert.ok(LARK_RUNNER_SYSTEM.includes(LARK_ENGLISH_OUTPUT_POLICY));
  });
});
