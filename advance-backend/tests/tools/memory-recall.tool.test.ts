import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryRecallTool,
  MEMORY_RECALL_MAX_DEPARTMENT_PREFERENCES,
  MEMORY_RECALL_MAX_FACT_CHARS,
  MEMORY_RECALL_MAX_FACTS,
  MEMORY_RECALL_MAX_QUERY_CHARS,
  MEMORY_RECALL_MAX_TOTAL_CHARS,
} from '../../src/application/tools/families/memory-recall.tool.ts';
import { makeAllowedPerm, makeCtx } from './tool-test.helpers.ts';

const activeMemberships = [{ departmentId: 'dept-finance', departmentName: 'Finance' }];

function makeTool(mem0: Parameters<typeof createMemoryRecallTool>[0]['mem0']) {
  return createMemoryRecallTool({
    mem0,
    departmentRepo: { listActiveMemberships: async () => ({ ok: true as const, value: activeMemberships }) },
  });
}

describe('memoryRecall tool', () => {
  it('accepts only a bounded query and bounded department names', () => {
    const tool = makeTool(null);

    assert.equal(tool.argsSchema.safeParse({ query: 'prior reporting format', departmentPreferences: ['Finance'] }).success, true);
    assert.equal(tool.argsSchema.safeParse({ query: '   ' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ query: 'x'.repeat(MEMORY_RECALL_MAX_QUERY_CHARS + 1) }).success, false);
    assert.equal(tool.argsSchema.safeParse({ query: 'history', departmentId: 'dept-other' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ query: 'history', departmentPreferences: ['4f6dd0dc-6fdc-4b72-a1fd-68b7f1d46b8c'] }).success, false);
    assert.equal(tool.argsSchema.safeParse({
      query: 'history',
      departmentPreferences: Array.from({ length: MEMORY_RECALL_MAX_DEPARTMENT_PREFERENCES + 1 }, () => 'Finance'),
    }).success, false);
  });

  it('enforces per-fact and total returned-text budgets', () => {
    const tool = makeTool(null);
    const coverage = { personal: 'searched', departments: { searched: 1, failed: 0 }, company: 'searched' } as const;

    assert.equal(tool.resultSchema.safeParse({
      facts: [{ scope: 'personal', text: 'x'.repeat(MEMORY_RECALL_MAX_FACT_CHARS + 1) }], coverage, status: 'available',
    }).success, false);
    assert.equal(tool.resultSchema.safeParse({
      facts: Array.from({ length: 7 }, () => ({ scope: 'personal', text: 'x'.repeat(500) })), coverage, status: 'available',
    }).success, false);
  });

  it('reports storage unavailability without claiming no memory exists', async () => {
    const result = await makeTool(null).execute({ query: 'prior reporting format' }, makeCtx('memoryRecall', ['read']));

    assert.equal(result.ok, true);
    assert.deepEqual((result as any).value, {
      facts: [],
      coverage: { personal: 'failed', departments: { searched: 0, failed: 1 }, company: 'failed' },
      status: 'storage_unavailable',
    });
  });

  it('passes only server-derived active departments and name preferences to bounded recall', async () => {
    const calls: unknown[] = [];
    const tool = makeTool({
      searchForRecall: async (input: unknown) => {
        calls.push(input);
        return {
          facts: [{ scope: 'department' as const, text: 'Use tables for weekly reports.', department: { name: 'Finance' } }],
          coverage: { personal: 'searched' as const, departments: { searched: 1, failed: 0 }, company: 'searched' as const },
          status: 'available' as const,
        };
      },
    });

    const result = await tool.execute({ query: 'weekly reports', departmentPreferences: ['Finance'] }, makeCtx('memoryRecall', ['read']));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      query: 'weekly reports', userId: 'user-test', companyId: 'co-test',
      departments: [{ id: 'dept-finance', name: 'Finance' }],
      departmentPreferences: ['Finance'],
      limit: MEMORY_RECALL_MAX_FACTS,
      maxFactChars: MEMORY_RECALL_MAX_FACT_CHARS,
      maxTotalChars: MEMORY_RECALL_MAX_TOTAL_CHARS,
    }]);
  });

  it('requires the gateway-injected read access rather than accepting an arbitrary direct invocation', () => {
    assert.equal(makeTool(null).permissionCheck({ query: 'history' }, makeAllowedPerm('webSearch', ['read'])).ok, false);
  });
});
