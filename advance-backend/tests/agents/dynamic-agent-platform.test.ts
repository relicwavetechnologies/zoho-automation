import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ok } from '../../src/shared/result.ts';
import { asToolId, asCompanyId, asUserId } from '../../src/shared/ids.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import { resolveAppToolsById } from '../../src/application/orchestration/tools/tool-resolver.ts';
import { buildCapabilitiesForAgent } from '../../src/application/orchestration/agent-runners/dynamic/agent-as-tool.ts';
import { runDynamicAgent } from '../../src/application/orchestration/agent-runners/dynamic/dynamic-agent.runner.ts';
import type { DynamicAgentDescriptor } from '../../src/application/agents/dynamic-agent-descriptor.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import { AgentCatalogCache } from '../../src/application/agents/agent-catalog.cache.ts';
import { textModel } from '../helpers/mock-model.ts';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const clock = {
  now:   () => new Date('2026-01-01T00:00:00.000Z'),
  nowMs: () => 0,
};

function makeTool(id: string): Tool<unknown, unknown> {
  return {
    id:              asToolId(id as any),
    family:          'context',
    actionGroups:    new Set(['read']) as any,
    argsSchema:      z.object({}),
    resultSchema:    z.string(),
    description:     `${id} description`,
    parameterDocs:   '',
    permissionCheck: () => ok('read' as any),
    execute:         async () => ok(`${id} result`),
  };
}

function makeAgent(overrides: Partial<DynamicAgentDescriptor>): DynamicAgentDescriptor {
  return {
    id:                    'agent-1',
    companyId:             'co-1',
    slug:                  'agent-1',
    name:                  'Agent 1',
    capabilityDescription: 'Handles one capability.',
    toolIds:               [],
    childAgentIds:         [],
    systemPrompt:          'You are an agent.',
    hookId:                null,
    modelId:               null,
    provider:              null,
    maxSteps:              8,
    temperature:           0,
    isActive:              true,
    isRootAgent:           false,
    parentId:              null,
    ...overrides,
  };
}

const perm: PermissionResult = {
  companyId:      asCompanyId('co-1'),
  userId:         asUserId('user-1'),
  companyRole:    'MEMBER',
  allowedToolIds: new Set(['contextSearch', 'webSearch'].map(id => asToolId(id as any))),
  actionGroups:   new Map(),
};

describe('dynamic agent platform', () => {
  it('resolves app tools by DB tool IDs and reports unknown IDs', () => {
    const { appTools, missingToolIds } = resolveAppToolsById(
      ['contextSearch', 'missingTool'],
      [makeTool('contextSearch'), makeTool('webSearch')],
      noopLogger,
    );

    assert.deepEqual(appTools.map(tool => String(tool.id)), ['contextSearch']);
    assert.deepEqual(missingToolIds, ['missingTool']);
  });

  it('builds direct tools plus child-agent tools for a parent agent', () => {
    const parent = makeAgent({
      id:            'parent',
      slug:          'parent',
      toolIds:       ['contextSearch'],
      isRootAgent:   true,
      childAgentIds: ['child'],
    });
    const child = makeAgent({
      id:       'child',
      slug:     'sales-research',
      parentId: 'parent',
    });

    const capabilities = buildCapabilitiesForAgent(parent, [parent, child], {
      model:      {} as any,
      allTools:   [makeTool('contextSearch'), makeTool('webSearch')],
      perm,
      runContext: {
        companyId: asCompanyId('co-1'),
        userId:    asUserId('user-1'),
        channel:   'test',
      },
      logger: noopLogger,
      clock,
    });

    assert.ok('contextSearch' in capabilities);
    assert.ok('agent_sales_research' in capabilities);
  });

  it('uses an agent-specific model when provider and modelId are configured', async () => {
    const calls: Array<{ provider: string; modelId: string; companyId: string; agentSlug?: string }> = [];
    const result = await runDynamicAgent({
      task:  'summarize',
      agent: makeAgent({ provider: 'openai', modelId: 'gpt-4o-mini', slug: 'finance-head' }),
      ctx:   {
        model:        textModel('default model'),
        resolveModel: async (input) => {
          calls.push(input);
          return textModel('agent model');
        },
        allTools:   [],
        perm,
        runContext: {
          companyId: asCompanyId('co-1'),
          userId:    asUserId('user-1'),
          channel:   'test',
        },
        logger: noopLogger,
        clock,
      },
    });

    assert.equal(result.status, 'success');
    assert.equal(result.result, 'agent model');
    assert.deepEqual(calls, [{
      provider:  'openai',
      modelId:   'gpt-4o-mini',
      companyId: 'co-1',
      agentSlug: 'finance-head',
    }]);
  });

  it('agent catalog cache reloads after explicit invalidation', async () => {
    let calls = 0;
    const service = {
      listActiveForCompany: async () => {
        calls++;
        return [makeAgent({ id: `agent-${calls}`, slug: `agent-${calls}` })];
      },
    } as any;
    const cache = new AgentCatalogCache(service, noopLogger, { ttlMs: 60_000 });

    const first = await cache.getForCompany('co-1');
    const second = await cache.getForCompany('co-1');
    cache.invalidate('co-1');
    const third = await cache.getForCompany('co-1');

    assert.equal(first[0]?.id, 'agent-1');
    assert.equal(second[0]?.id, 'agent-1');
    assert.equal(third[0]?.id, 'agent-2');
    assert.equal(calls, 2);
  });
});
