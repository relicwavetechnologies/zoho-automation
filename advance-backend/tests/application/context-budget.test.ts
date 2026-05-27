import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enforceContextBudget } from '../../src/application/orchestration/engine/context-budget-enforcer.ts';
import type { Turn } from '../../src/domain/conversation/turn.ts';
import { CONTEXT_BUDGET } from '../../src/domain/conversation/context-budget.ts';

function makeTurn(id: string, role: Turn['role'], content: string): Turn {
  return { id, role, content, timestamp: new Date().toISOString() };
}

describe('enforceContextBudget', () => {
  it('passes through all components when within budget', () => {
    const result = enforceContextBudget({
      systemPrompt: 'System prompt',
      conversationSummary: 'Summary',
      memoryContext: 'Memory facts',
      historyTurns: [
        makeTurn('1', 'user', 'Hello'),
        makeTurn('2', 'assistant', 'Hi'),
      ],
      currentMessage: 'What is the weather?',
    });

    assert.equal(result.systemPrompt, 'System prompt');
    assert.equal(result.conversationSummary, 'Summary');
    assert.equal(result.memoryContext, 'Memory facts');
    assert.equal(result.historyTurns.length, 2);
    assert.equal(result.allocation.trimActions.length, 0);
  });

  it('caps group context when it exceeds GROUP_CONTEXT_MAX', () => {
    const bigGroupContext = 'x'.repeat(CONTEXT_BUDGET.GROUP_CONTEXT_MAX * 5);
    const result = enforceContextBudget({
      systemPrompt: 'System',
      groupContext: bigGroupContext,
      historyTurns: [],
      currentMessage: 'Hello',
    });

    assert.ok(result.allocation.groupContextTokens <= CONTEXT_BUDGET.GROUP_CONTEXT_MAX);
    assert.ok(result.allocation.trimActions.some(a => a.includes('group_context')));
  });

  it('trims history when budget is exhausted by other components', () => {
    const bigSummary = 'S'.repeat(CONTEXT_BUDGET.CONVERSATION_SUMMARY_MAX * 4);
    const bigGroupCtx = 'G'.repeat(CONTEXT_BUDGET.GROUP_CONTEXT_MAX * 4);
    const bigMemory = 'M'.repeat(CONTEXT_BUDGET.MEMORY_CONTEXT_MAX * 4);

    const historyTurns = Array.from({ length: 100 }, (_, i) =>
      makeTurn(`t${i}`, i % 2 === 0 ? 'user' : 'assistant', 'Some message content '.repeat(200)),
    );

    const result = enforceContextBudget({
      systemPrompt: 'System prompt',
      conversationSummary: bigSummary,
      memoryContext: bigMemory,
      groupContext: bigGroupCtx,
      historyTurns,
      currentMessage: 'Hello',
    });

    assert.ok(result.historyTurns.length < historyTurns.length, 'History should be trimmed');
    assert.ok(result.allocation.trimActions.some(a => a.includes('history')));
  });

  it('handles missing optional components gracefully', () => {
    const result = enforceContextBudget({
      systemPrompt: 'System',
      historyTurns: [makeTurn('1', 'user', 'Hello')],
      currentMessage: 'Hi',
    });

    assert.equal(result.conversationSummary, undefined);
    assert.equal(result.memoryContext, undefined);
    assert.equal(result.groupContext, undefined);
    assert.equal(result.allocation.summaryTokens, 0);
    assert.equal(result.allocation.memoryTokens, 0);
    assert.equal(result.allocation.groupContextTokens, 0);
  });

  it('records trim actions for observability', () => {
    const hugeSummary = 'x'.repeat(200_000);
    const result = enforceContextBudget({
      systemPrompt: 'System',
      conversationSummary: hugeSummary,
      historyTurns: [],
      currentMessage: 'Hi',
    });

    assert.ok(result.allocation.trimActions.length > 0);
    assert.ok(result.allocation.trimActions.some(a => a.includes('conversation_summary')));
  });

  it('total tokens never exceeds TOTAL_TARGET', () => {
    const result = enforceContextBudget({
      systemPrompt: 'x'.repeat(40_000),
      conversationSummary: 'x'.repeat(60_000),
      memoryContext: 'x'.repeat(20_000),
      groupContext: 'x'.repeat(100_000),
      historyTurns: Array.from({ length: 50 }, (_, i) =>
        makeTurn(`t${i}`, 'user', 'x'.repeat(2000)),
      ),
      currentMessage: 'x'.repeat(20_000),
    });

    const { systemPromptTokens, summaryTokens, memoryTokens, groupContextTokens, historyTokens, currentMessageTokens } = result.allocation;
    const total = systemPromptTokens + summaryTokens + memoryTokens + groupContextTokens + historyTokens + currentMessageTokens;
    assert.ok(total <= CONTEXT_BUDGET.TOTAL_TARGET, `Total ${total} should be <= ${CONTEXT_BUDGET.TOTAL_TARGET}`);
  });
});
