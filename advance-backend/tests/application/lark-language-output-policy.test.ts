import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LARK_ENGLISH_OUTPUT_POLICY } from '../../src/application/orchestration/lark-language-policy.ts';
import { buildBrainSystemPrompt } from '../../src/application/orchestration/brain-prompt.ts';

describe('Lark English output policy', () => {
  it('is present in the governed Lark system prompt', () => {
    const brain = buildBrainSystemPrompt({ skillCatalog: '- Lark Docs', currentDateTime: 'now' });

    assert.match(LARK_ENGLISH_OUTPUT_POLICY, /Always reply in English/);
    assert.match(LARK_ENGLISH_OUTPUT_POLICY, /Never switch to Chinese/);
    assert.ok(brain.includes(LARK_ENGLISH_OUTPUT_POLICY));
  });
});
