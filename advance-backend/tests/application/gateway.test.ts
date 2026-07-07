/**
 * Unit tests for gateway dispatcher and tool executor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { GatewayDispatcher } from '../../src/application/gateway/gateway-dispatcher.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import { SkillRegistry } from '../../src/application/skills/skill-registry.ts';
import type { Skill } from '../../src/application/skills/skill.types.ts';
import { ok, err } from '../../src/shared/result.ts';
import { PermissionError, ToolError } from '../../src/shared/errors.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeDeniedPerm, noopLogger } from '../tools/tool-test.helpers.ts';
import type { PermissionService } from '../../src/application/permissions/permission.service.ts';
import type { GatewayMemberContext } from '../../src/application/gateway/gateway.types.ts';

const member: GatewayMemberContext = {
  companyId: 'co-test',
  userId: 'user-test',
  aiRole: 'MEMBER',
  email: 'user@example.com',
  larkOpenId: 'ou_test',
  sessionId: 'sess-test',
};

function makeFakeTool(overrides: Partial<Tool<{ query: string }, { result: string }>> = {}): Tool<{ query: string }, { result: string }> {
  return {
    id: asToolId('fakeTool'),
    family: 'context',
    actionGroups: new Set(['read']),
    argsSchema: z.object({ query: z.string() }),
    resultSchema: z.object({ result: z.string() }),
    description: 'Fake tool for gateway tests',
    parameterDocs: 'query: string',
    permissionCheck: (_args, perm) => {
      const actions = perm.allowedActionsByTool.get(asToolId('fakeTool'));
      if (!actions?.has('read')) {
        return err(new PermissionError({ reason: 'not_allowed', toolId: 'fakeTool', message: 'fakeTool not allowed' }));
      }
      return ok('read');
    },
    execute: async (args) => ok({ result: `echo:${args.query}` }),
    ...overrides,
  };
}

function makePermissionService(perm = makeAllowedPerm('fakeTool', ['read'])): PermissionService {
  return {
    resolve: async () => ok(perm),
    canInvoke: async () => ok(true),
    invalidateCompany: async () => {},
    invalidateDept: async () => {},
  } as unknown as PermissionService;
}

function makeSkillRegistry(skills: Skill[]): SkillRegistry {
  return new SkillRegistry(skills);
}

describe('ToolExecutor', () => {
  it('returns unknown_tool for missing registry entry', async () => {
    const executor = new ToolExecutor({
      toolRegistry: new ToolRegistry(),
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      toolId: 'missingTool',
      args: {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown_tool');
  });

  it('returns invalid_args when schema validation fails', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool());

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      toolId: 'fakeTool',
      args: {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_args');
  });

  it('returns permission_denied when tool permission check fails', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool());

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeDeniedPerm()),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      toolId: 'fakeTool',
      args: { query: 'hello' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'permission_denied');
  });

  it('returns permission_denied for runCommand', async () => {
    const executor = new ToolExecutor({
      toolRegistry: new ToolRegistry(),
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      toolId: 'runCommand',
      args: { command: 'ls' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'permission_denied');
  });

  it('returns success with structured tool result', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool());

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      toolId: 'fakeTool',
      args: { query: 'hello' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.data, {
      toolId: 'fakeTool',
      action: 'read',
      result: { result: 'echo:hello' },
    });
  });

  it('returns tool_error when execute fails', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async () => err(new ToolError({ toolId: 'fakeTool', reason: 'upstream_failure', message: 'upstream down' })),
    }));

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      toolId: 'fakeTool',
      args: { query: 'hello' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'tool_error');
    assert.match(result.error?.message ?? '', /upstream down/);
  });
});

describe('GatewayDispatcher', () => {
  const allowedSkill: Skill = {
    id: 'allowed-skill',
    name: 'Allowed',
    description: 'Allowed skill',
    instructions: 'Do allowed things',
    toolIds: ['fakeTool'],
  };
  const blockedSkill: Skill = {
    id: 'blocked-skill',
    name: 'Blocked',
    description: 'Blocked skill',
    instructions: 'Do blocked things',
    toolIds: ['zohoCrm'],
  };

  function makeDispatcher(perm = makeAllowedPerm('fakeTool', ['read'])) {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool());

    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(perm),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    return new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: registry,
      skillRegistry: makeSkillRegistry([allowedSkill, blockedSkill]),
      toolExecutor,
      logger: noopLogger,
    });
  }

  it('returns unknown_op for unsupported operation', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({ op: 'nope.op' }, member);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown_op');
  });

  it('returns capabilities with RBAC-filtered tools and skills', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({ op: 'capabilities.get' }, member);

    assert.equal(result.ok, true);
    const data = result.data as {
      departments: unknown[];
      tools: Array<{ toolId: string }>;
      skills: Array<{ id: string }>;
    };
    assert.deepEqual(data.departments, []);
    assert.ok(data.tools.some((t) => t.toolId === 'fakeTool'));
    assert.ok(data.skills.some((s) => s.id === 'allowed-skill'));
    assert.equal(data.skills.some((s) => s.id === 'blocked-skill'), false);
  });

  it('returns tools.list filtered by RBAC and excludes runCommand', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool());
    registry.register({
      ...makeFakeTool(),
      id: asToolId('runCommand'),
      description: 'Run command',
    } as Tool<{ query: string }, { result: string }>);

    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(),
      toolRegistry: registry,
      skillRegistry: makeSkillRegistry([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({ op: 'tools.list' }, member);
    assert.equal(result.ok, true);
    const tools = (result.data as { tools: Array<{ id: string }> }).tools;
    assert.ok(tools.some((t) => t.id === 'fakeTool'));
    assert.equal(tools.some((t) => t.id === 'runCommand'), false);
  });

  it('returns skills.get with permission check', async () => {
    const dispatcher = makeDispatcher();
    const allowed = await dispatcher.dispatch({
      op: 'skills.get',
      payload: { skillId: 'allowed-skill' },
    }, member);
    assert.equal(allowed.ok, true);

    const denied = await dispatcher.dispatch({
      op: 'skills.get',
      payload: { skillId: 'blocked-skill' },
    }, member);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 'permission_denied');
  });

  it('invokes tools through ToolExecutor', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { toolId: 'fakeTool', args: { query: 'gateway' } },
    }, member);

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as { result: { result: string } }).result, { result: 'echo:gateway' });
  });
});
