import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentHook } from '../../../src/application/orchestration/agent-runners/dynamic/agent-hook.ts';

const baseCtx = {
  agent: {
    id: 'outreach',
    companyId: 'co1',
    slug: 'context-agent',
    name: 'Context',
    capabilityDescription: 'Research',
    toolIds: ['contextSearch', 'webSearch'],
    childAgentIds: [],
    systemPrompt: 'You are Research.',
    hookId: 'outreach-read',
    modelId: null,
    provider: null,
    maxSteps: 8,
    temperature: 0,
    isActive: true,
    isRootAgent: false,
    parentId: null,
  },
  ctx: {},
  depth: 0,
  path: [],
} as any;

describe('OutreachReadHook', () => {
  it('extracts DA, DR, and niche filters before execution', async () => {
    const hook = resolveAgentHook('outreach-read');
    assert.ok(hook?.preExecute);

    const result = await hook.preExecute({
      ...baseCtx,
      task: 'find sites with DA > 50 and DR > 30 in niche tech',
    });

    assert.match(result.modifiedTask ?? '', /domainAuthority: 50/);
    assert.match(result.modifiedTask ?? '', /domainRating: 30/);
    assert.match(result.modifiedTask ?? '', /niche: tech/);
  });

  it('normalizes outreach metric formatting after execution', async () => {
    const hook = resolveAgentHook('outreach-read');
    assert.ok(hook?.postExecute);

    const result = await hook.postExecute({ ...baseCtx, task: 'find sites' }, 'example.com da=55 dr:44 price=120');

    assert.equal(result, 'example.com DA: 55 DR: 44 Price: $120');
  });
});
