import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeRecallService } from '../../src/application/knowledge/knowledge-recall.service';

function service(options: {
  readonly semanticFacts: readonly Record<string, unknown>[];
  readonly resources?: readonly Record<string, unknown>[];
  readonly keywordResources?: readonly Record<string, unknown>[];
}) {
  const requestedResourceIds: string[][] = [];
  return {
    requestedResourceIds,
    recall: new KnowledgeRecallService({
      permissions: {
        canInvoke: async () => ({ ok: true, value: true }),
      } as never,
      departments: {
        listActiveMemberships: async () => ({
          ok: true,
          value: [{ departmentId: 'dept-1', departmentName: 'Tech Testing' }],
        }),
      } as never,
      memory: {
        searchForRecall: async () => ({
          status: 'available' as const,
          coverage: {
            personal: 'searched' as const,
            departments: { searched: 1, failed: 0 },
            company: 'searched' as const,
          },
          facts: options.semanticFacts,
        }),
      } as never,
      resources: {
        getManyMemories: async (input: { resourceIds: string[] }) => {
          requestedResourceIds.push(input.resourceIds);
          return options.resources ?? [];
        },
        searchMemories: async () => options.keywordResources ?? [],
      } as never,
    }),
  };
}

const identity = {
  query: 'weekly report formatting preferences',
  companyId: 'company-1',
  userId: 'user-1',
  companyRole: 'member',
  channel: 'lark' as const,
};

describe('KnowledgeRecallService canonical hydration', () => {
  it('hydrates every fact in a matched resource instead of returning a semantically incomplete subset', async () => {
    const { recall, requestedResourceIds } = service({
      semanticFacts: [
        { scope: 'personal', text: 'Weekly reports should be a two-column table.', resourceId: 'resource-1' },
        { scope: 'personal', text: 'The right column header is Update.', resourceId: 'resource-1' },
      ],
      resources: [{
        resourceId: 'resource-1',
        kind: 'memory',
        scope: 'personal',
        logicalKey: 'reports.weekly.format',
        currentVersion: 1,
        title: 'reports.weekly.format',
        summary: '3 durable facts',
        updatedAt: '2026-07-31T00:00:00.000Z',
        content: {
          facts: [
            'Weekly reports should be formatted as a two-column table.',
            "The left column header is 'Topic'.",
            "The right column header is 'Update'.",
          ],
        },
      }],
    });

    const result = await recall.recall(identity);

    assert.deepEqual(requestedResourceIds, [['resource-1']]);
    assert.deepEqual(result.facts, [
      { scope: 'personal', text: 'Weekly reports should be formatted as a two-column table.' },
      { scope: 'personal', text: "The left column header is 'Topic'." },
      { scope: 'personal', text: "The right column header is 'Update'." },
    ]);
    assert.equal(JSON.stringify(result).includes('resource-1'), false);
  });

  it('does not trust a stale or unreadable semantic resource reference', async () => {
    const { recall } = service({
      semanticFacts: [
        { scope: 'company', text: 'Stale company claim.', resourceId: 'missing-resource' },
        { scope: 'personal', text: 'Legacy personal fact without a resource reference.' },
      ],
    });

    const result = await recall.recall(identity);

    assert.deepEqual(result.facts, []);
  });

  it('recalls authorized canonical Postgres memory when semantic storage is down', async () => {
    const recall = new KnowledgeRecallService({
      permissions: { canInvoke: async () => ({ ok: true, value: true }) } as never,
      departments: {
        listActiveMemberships: async () => ({
          ok: true,
          value: [{ departmentId: 'dept-1', departmentName: 'Tech Testing' }],
        }),
      } as never,
      memory: { searchForRecall: async () => { throw new Error('Hindsight unavailable'); } } as never,
      resources: {
        searchMemories: async () => [{
          score: 0.9,
          coverage: 1,
          resource: {
            resourceId: 'resource-1',
            kind: 'memory',
            scope: 'personal',
            logicalKey: 'reports.weekly.format',
            currentVersion: 1,
            title: 'reports.weekly.format',
            summary: '1 durable fact',
            updatedAt: '2026-07-31T00:00:00.000Z',
            content: { facts: ['Weekly reports use a two-column table.'] },
          },
        }],
        getManyMemories: async () => [],
      } as never,
    });

    const result = await recall.recall(identity);

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.facts, [
      { scope: 'personal', text: 'Weekly reports use a two-column table.' },
    ]);
    assert.deepEqual(result.coverage, {
      personal: 'searched',
      departments: { searched: 1, failed: 0 },
      company: 'searched',
    });
  });

  it('reports storage unavailable only when both canonical and semantic retrieval fail', async () => {
    const recall = new KnowledgeRecallService({
      permissions: { canInvoke: async () => ({ ok: true, value: true }) } as never,
      departments: {
        listActiveMemberships: async () => ({ ok: true, value: [] }),
      } as never,
      memory: { searchForRecall: async () => { throw new Error('semantic down'); } } as never,
      resources: {
        searchMemories: async () => { throw new Error('postgres down'); },
        getManyMemories: async () => [],
      } as never,
    });

    const result = await recall.recall(identity);
    assert.equal(result.status, 'storage_unavailable');
    assert.deepEqual(result.facts, []);

    const sharedResult = await recall.recall({ ...identity, audience: 'shared' });
    assert.equal(sharedResult.status, 'storage_unavailable');
    assert.equal(sharedResult.personalScope, 'skipped');
  });

  it('excludes personal facts before canonical hydration for a shared audience', async () => {
    const { recall, requestedResourceIds } = service({
      semanticFacts: [
        { scope: 'personal', text: 'Private preference.', resourceId: 'personal-resource' },
        { scope: 'company', text: 'Company policy.', resourceId: 'company-resource' },
      ],
      resources: [
        {
          resourceId: 'personal-resource',
          kind: 'memory',
          scope: 'personal',
          logicalKey: 'private.preference',
          currentVersion: 1,
          title: 'private.preference',
          summary: 'private',
          updatedAt: '2026-07-31T00:00:00.000Z',
          content: { facts: ['Private preference.'] },
        },
        {
          resourceId: 'company-resource',
          kind: 'memory',
          scope: 'company',
          logicalKey: 'company.policy',
          currentVersion: 1,
          title: 'company.policy',
          summary: 'company',
          updatedAt: '2026-07-31T00:00:00.000Z',
          content: { facts: ['Company policy.'] },
        },
      ],
      keywordResources: [{
        score: 1,
        coverage: 1,
        resource: {
          resourceId: 'personal-resource',
          kind: 'memory',
          scope: 'personal',
          logicalKey: 'private.preference',
          currentVersion: 1,
          title: 'private.preference',
          summary: 'private',
          updatedAt: '2026-07-31T00:00:00.000Z',
          content: { facts: ['Private preference.'] },
        },
      }],
    });

    const result = await recall.recall({ ...identity, audience: 'shared' });

    assert.equal(result.personalScope, 'skipped');
    assert.deepEqual(requestedResourceIds, [['company-resource']]);
    assert.deepEqual(result.facts, [{ scope: 'company', text: 'Company policy.' }]);
  });

  it('uses company, department, personal precedence without dropping provenance', async () => {
    const { recall } = service({
      semanticFacts: [
        { scope: 'personal', text: 'Personal fallback.', resourceId: 'personal-resource' },
        {
          scope: 'department',
          text: 'Department rule.',
          department: { name: 'Tech Testing' },
          resourceId: 'department-resource',
        },
        { scope: 'company', text: 'Company rule.', resourceId: 'company-resource' },
      ],
      resources: [
        {
          resourceId: 'personal-resource', scope: 'personal', kind: 'memory', logicalKey: 'p',
          currentVersion: 1, title: 'p', summary: 'p', updatedAt: '2026-07-31T00:00:00.000Z',
          content: { facts: ['Personal fallback.'] },
        },
        {
          resourceId: 'department-resource', scope: 'department', department: { name: 'Tech Testing' },
          kind: 'memory', logicalKey: 'd', currentVersion: 1, title: 'd', summary: 'd',
          updatedAt: '2026-07-31T00:00:00.000Z', content: { facts: ['Department rule.'] },
        },
        {
          resourceId: 'company-resource', scope: 'company', kind: 'memory', logicalKey: 'c',
          currentVersion: 1, title: 'c', summary: 'c', updatedAt: '2026-07-31T00:00:00.000Z',
          content: { facts: ['Company rule.'] },
        },
      ],
    });

    const result = await recall.recall(identity);

    assert.deepEqual(result.facts, [
      { scope: 'company', text: 'Company rule.' },
      { scope: 'department', text: 'Department rule.', department: { name: 'Tech Testing' } },
      { scope: 'personal', text: 'Personal fallback.' },
    ]);
  });

  it('returns an explicit degradation when canonical semantic hydration fails', async () => {
    const recall = new KnowledgeRecallService({
      permissions: { canInvoke: async () => ({ ok: true, value: true }) } as never,
      departments: {
        listActiveMemberships: async () => ({
          ok: true as const,
          value: [{ departmentId: 'dept-1', departmentName: 'Tech Testing' }],
        }),
      } as never,
      memory: {
        searchForRecall: async () => ({
          status: 'available' as const,
          coverage: {
            personal: 'searched' as const,
            departments: { searched: 1, failed: 0 },
            company: 'searched' as const,
          },
          facts: [{ scope: 'company' as const, text: 'Semantic fact.', resourceId: 'resource-1' }],
        }),
      } as never,
      resources: {
        searchMemories: async () => [{
          score: 1,
          coverage: 1,
          resource: {
            resourceId: 'keyword-resource', kind: 'memory' as const, scope: 'company' as const,
            logicalKey: 'keyword', currentVersion: 1, title: 'keyword', summary: 'keyword',
            updatedAt: '2026-07-31T00:00:00.000Z', content: { facts: ['Canonical keyword fact.'] },
          },
        }],
        getManyMemories: async () => { throw new Error('canonical store unavailable'); },
      } as never,
    });

    const result = await recall.recall(identity);

    assert.equal(result.status, 'partial');
    assert.equal(result.degradation, 'canonical_hydration_failed');
    assert.deepEqual(result.facts, [{ scope: 'company', text: 'Canonical keyword fact.' }]);
  });

  it('honors cancellation while retrieval engines are still pending', async () => {
    const controller = new AbortController();
    const recall = new KnowledgeRecallService({
      permissions: { canInvoke: async () => ({ ok: true, value: true }) } as never,
      departments: {
        listActiveMemberships: async () => ({ ok: true as const, value: [] }),
      } as never,
      memory: { searchForRecall: async () => new Promise<never>(() => {}) } as never,
      resources: { searchMemories: async () => new Promise<never>(() => {}), getManyMemories: async () => [] } as never,
    });

    const pending = recall.recall({ ...identity, abortSignal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError');
  });
});
