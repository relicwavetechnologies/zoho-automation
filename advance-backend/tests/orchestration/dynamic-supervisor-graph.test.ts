import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ok } from '../../src/shared/result.ts';
import { asToolId, asCompanyId, asUserId } from '../../src/shared/ids.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import { buildDynamicSupervisorGraph } from '../../src/application/orchestration/graphs/dynamic-supervisor.graph.ts';
import type { DynamicAgentDescriptor } from '../../src/application/agents/dynamic-agent-descriptor.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  nowMs: () => 0,
};

function makeTool(id: string): Tool<unknown, unknown> {
  return {
    id: asToolId(id as any),
    family: 'context',
    actionGroups: new Set(['read']) as any,
    argsSchema: z.object({}),
    resultSchema: z.string(),
    description: `${id} description`,
    parameterDocs: '',
    permissionCheck: () => ok('read' as any),
    execute: async () => ok(`${id} result`),
  };
}

function makeAgent(overrides: Partial<DynamicAgentDescriptor>): DynamicAgentDescriptor {
  return {
    id: 'agent-1',
    companyId: 'co-1',
    slug: 'agent-1',
    name: 'Agent 1',
    capabilityDescription: 'Handles one capability.',
    toolIds: [],
    childAgentIds: [],
    systemPrompt: 'You are an agent.',
    hookId: null,
    modelId: null,
    provider: null,
    maxSteps: 8,
    temperature: 0,
    isActive: true,
    isRootAgent: false,
    parentId: null,
    ...overrides,
  };
}

const perm = {
  allowedToolIds: new Set(['contextSearch'].map(id => asToolId(id as any))),
  allowedActionsByTool: new Map(),
  decisions: [],
} as any;

const runContext = {
  companyId: asCompanyId('co-1'),
  userId: asUserId('user-1'),
  companyRole: 'MEMBER',
  channel: 'test',
} as any;

describe('dynamic supervisor graph', () => {
  it('builds dynamic child-agent tools and returns graph output', async () => {
    const root = makeAgent({
      id: 'root',
      slug: 'divo-supervisor',
      isRootAgent: true,
      childAgentIds: ['child'],
    });
    const child = makeAgent({
      id: 'child',
      slug: 'lark-ops',
      parentId: 'root',
      capabilityDescription: 'Handles Lark operations',
    });

    let toolNames: string[] = [];
    const graph = buildDynamicSupervisorGraph({
      model: {} as any,
      agentCatalogCache: {
        getForCompany: async () => [root, child],
      } as any,
      todoRepo: {} as any,
      prisma: {} as any,
      logger: noopLogger,
      clock,
      executeText: async ({ tools }) => {
        toolNames = Object.keys(tools);
        return { text: 'graph done', toolCalls: ['agent_lark_ops'] };
      },
    });

    const output = await graph.invoke({
      userMessage: 'create a task',
      conversationHistory: [],
      companyId: 'co-1',
      perm,
      runContext,
      permittedTools: [makeTool('contextSearch')],
      chatId: 'chat-1',
    });

    assert.ok(toolNames.includes('agent_lark_ops'));
    assert.ok(toolNames.includes('manageTodos'));
    assert.equal(output.supervisorResult, 'graph done');
    assert.deepEqual(output.toolCallsMade, ['agent_lark_ops']);
    assert.equal(output.agentDelegations[0]?.slug, 'lark_ops');
  });

  it('returns an error state when no root agent exists', async () => {
    const graph = buildDynamicSupervisorGraph({
      model: {} as any,
      agentCatalogCache: {
        getForCompany: async () => [],
      } as any,
      todoRepo: {} as any,
      prisma: {} as any,
      logger: noopLogger,
      clock,
      executeText: async () => {
        throw new Error('should not execute without root');
      },
    });

    const output = await graph.invoke({
      userMessage: 'hello',
      conversationHistory: [],
      companyId: 'co-1',
      perm,
      runContext,
      permittedTools: [],
      chatId: null,
    });

    assert.equal(output.status, 'error');
    assert.match(output.error ?? '', /No active root dynamic agent/);
  });
});
