import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  sanitizePersonaLearningContext,
  sanitizePersonaLearningText,
  sanitizePersonaLearningToolSummaries,
} from '../../src/application/persona-learning/persona-learning.types';

describe('persona-learning evidence sanitization', () => {
  it('redacts obvious credentials before long-lived evidence is stored', () => {
    const text = sanitizePersonaLearningText(
      'Use this api_key=super-secret-value and Authorization: Bearer abcdefghijklmnopqrst.',
      500,
    );
    assert.equal(text.includes('super-secret-value'), false);
    assert.equal(text.includes('abcdefghijklmnopqrst'), false);
    assert.match(text, /\[REDACTED\]/);
  });

  it('bounds context and tool summaries to the learning contract', () => {
    const context = sanitizePersonaLearningContext({
      userMessages: ['a'.repeat(3_000), 'b'],
      assistantResponse: 'c'.repeat(5_000),
    });
    const tools = sanitizePersonaLearningToolSummaries(Array.from({ length: 25 }, (_unused, index) => ({
      toolName: `tool-${index}`,
      isError: false,
      summary: 's'.repeat(800),
    })));
    assert.equal(context.userMessages[0]?.length, 2_001);
    assert.equal(context.assistantResponse?.length, 4_001);
    assert.equal(tools.length, 20);
    assert.equal(tools[0]?.toolName, 'tool-5');
    assert.equal(tools[0]?.summary?.length, 501);
  });
});
