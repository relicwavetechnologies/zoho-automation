/**
 * Unit tests for gateway dispatcher and tool executor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { GatewayDispatcher } from '../../src/application/gateway/gateway-dispatcher.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import {
  InMemoryApprovalIntentRepository,
  LocalApprovalIntentService,
} from '../../src/application/gateway/local-approval-intent.service.ts';
import { ToolRegistry } from '../../src/application/tools/tool-registry.ts';
import type { Tool } from '../../src/application/tools/tool.contract.ts';
import { createWebSearchTool } from '../../src/application/tools/families/web-search.tool.ts';
import { createMailAutomationsTool } from '../../src/application/tools/families/mail-automations.tool.ts';
import type { CatalogSkill, SkillCatalogService } from '../../src/application/skills/skill-catalog.service.ts';
import { ok, err } from '../../src/shared/result.ts';
import { PermissionError, ToolError } from '../../src/shared/errors.ts';
import { asDepartmentId, asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeDeniedPerm, noopLogger } from '../tools/tool-test.helpers.ts';
import type { PermissionService } from '../../src/application/permissions/permission.service.ts';
import type { PermissionQuery, PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { GatewayMemberContext } from '../../src/application/gateway/gateway.types.ts';
import type { MediaOcrService } from '../../src/application/gateway/media-ocr.service.ts';
import type { Clock } from '../../src/shared/clock.ts';
import { MODEL_FACING_RESULT_MAX_BYTES } from '../../src/application/gateway/model-facing-result-limit.ts';
import { KnowledgeMutationError } from '../../src/application/knowledge/knowledge-mutation.errors.ts';

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

function makeScopedPermissionService(
  resolve: (query: PermissionQuery) => PermissionResult,
  queries: PermissionQuery[] = [],
): PermissionService {
  return {
    resolve: async (query: PermissionQuery) => {
      queries.push(query);
      return ok(resolve(query));
    },
    canInvoke: async () => ok(true),
    invalidateCompany: async () => {},
    invalidateDept: async () => {},
  } as unknown as PermissionService;
}

function makeSkillCatalog(skills: CatalogSkill[]): SkillCatalogService {
  const score = (skill: CatalogSkill, query: string) => {
    const haystack = [
      skill.id,
      skill.slug,
      skill.name,
      skill.description,
      skill.instructions,
      ...skill.toolIds,
    ].join(' ').toLowerCase();
    return query
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)
      .filter(Boolean)
      .reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
  };

  return {
    listVisible: async () => skills.filter((skill) => skill.id !== 'blocked-skill'),
    searchVisibleRouters: async ({ query, limit }: { query: string; limit: number }) =>
      skills
        .filter((skill) => skill.id !== 'blocked-skill' && skill.tags?.includes('router'))
        .map((skill) => ({
          skillId: skill.id,
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          score: score(skill, query),
          matchedTerms: [],
        }))
        .filter((result) => result.score > 0)
        .slice(0, limit),
    searchVisible: async ({ query, limit }: { query: string; limit: number }) =>
      skills
        .filter((skill) => skill.id !== 'blocked-skill')
        .map((skill) => ({ skill, score: score(skill, query) }))
        .filter((result) => result.score > 0)
        .slice(0, limit),
    getVisible: async ({ skillId }: { skillId: string }) =>
      skills.find((skill) => skill.id === skillId && skill.id !== 'blocked-skill') ?? null,
    authorizesTool: async ({ skillId, toolId }: { skillId: string; toolId: string }) => {
      const skill = skills.find((candidate) => candidate.id === skillId && candidate.id !== 'blocked-skill');
      return skill?.toolIds.includes(toolId) ?? false;
    },
    getInScope: async ({ skillId }: { skillId: string }) =>
      skills.find((skill) => skill.id === skillId) ?? null,
  } as unknown as SkillCatalogService;
}

function makeLocalApprovals(
  toolExecutor: ToolExecutor,
  clock: Clock = { now: () => new Date(), nowMs: () => Date.now() },
  intentTtlMs?: number,
  deps: {
    permissions?: PermissionService;
    skillCatalog?: SkillCatalogService;
  } = {},
): LocalApprovalIntentService {
  return new LocalApprovalIntentService({
    toolExecutor,
    permissions: deps.permissions ?? makePermissionService(),
    skillCatalog: deps.skillCatalog ?? ({
      authorizesTool: async () => true,
    } as unknown as SkillCatalogService),
    skillAccessEnforcement: {
      listGrantedSkillIds: async () => new Set(['allowed-skill']),
    },
    repository: new InMemoryApprovalIntentRepository(),
    clock,
    logger: noopLogger,
    ...(intentTtlMs !== undefined ? { intentTtlMs } : {}),
  });
}

describe('ToolExecutor', () => {
  it('fails closed when a tool returns data outside its declared result schema', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async () => ok({ result: 42 } as never),
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const response = await executor.invoke({ member, toolId: 'fakeTool', args: { query: 'invalid output' } });

    assert.equal(response.ok, false);
    assert.equal(response.status, 'tool_error');
    assert.match(response.error?.message ?? '', /returned an invalid result/);
  });

  it('fails closed on invalid runtime-channel tool output too', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({ execute: async () => ok({ result: 42 } as never) }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const perm = makeAllowedPerm('fakeTool', ['read']);

    const response = await executor.executeForRuntime({
      toolId: 'fakeTool',
      args: { query: 'invalid output' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        channel: 'lark',
        requestId: 'request-1',
      } as never,
      perm,
    });

    assert.equal(response.status, 'tool_error');
    assert.match(response.message ?? '', /returned an invalid result/);
  });

  it('marks a scheduled run so tools know the runtime owns its delivery', async () => {
    // Pi runs in its container and calls back through the gateway, so this is
    // the run context every tool actually sees — the one the scheduler builds
    // never reaches them. Without this the messaging guards are inert and a
    // scheduled result can be posted into a room by the model.
    const registry = new ToolRegistry();
    let seenDeliveryMode: unknown = 'unset';
    registry.register(makeFakeTool({
      execute: async (_args, ctx) => {
        seenDeliveryMode = ctx.runContext.deliveryMode;
        return ok({ result: 'done' });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    await executor.invoke({
      member: { ...member, authProvider: 'scheduled_workflow' },
      toolId: 'fakeTool',
      args: { query: 'scheduled' },
    });
    assert.equal(seenDeliveryMode, 'scheduled_runtime_delivery');

    await executor.invoke({
      member: { ...member, authProvider: 'lark' },
      toolId: 'fakeTool',
      args: { query: 'interactive' },
    });
    assert.equal(seenDeliveryMode, undefined);
  });

  it('applies the universal result ceiling before returning a governed tool result', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async () => ok({ result: 'x'.repeat(MODEL_FACING_RESULT_MAX_BYTES * 3) }),
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const response = await executor.invoke({
      member,
      toolId: 'fakeTool',
      args: { query: 'large result' },
    });
    const result = (response.data as { result: unknown }).result as {
      preview: string;
      truncation: { truncated: boolean; returnedBytes: number };
    };

    assert.equal(response.ok, true);
    assert.equal(result.truncation.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MODEL_FACING_RESULT_MAX_BYTES);
    assert.equal(result.truncation.returnedBytes, Buffer.byteLength(JSON.stringify(result), 'utf8'));
  });

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

  it('uses signed member channel provenance for permission and tool context', async () => {
    const queries: PermissionQuery[] = [];
    let executionChannel: string | undefined;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async (_args, ctx) => {
        executionChannel = ctx.runContext.channel;
        return ok({ result: 'done' });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makeScopedPermissionService(() => makeAllowedPerm('fakeTool', ['read']), queries),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member: { ...member, channel: 'lark' },
      toolId: 'fakeTool',
      args: { query: 'hello' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(queries.map(query => query.channel), ['lark']);
    assert.equal(executionChannel, 'lark');
  });

  it('preserves the trusted Lark tenant and thread target for cloud Pi approval', async () => {
    let approvalInput: any;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['send']),
      permissionCheck: () => ok('send'),
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      approvalGate: {
        check: async (input: unknown) => {
          approvalInput = input;
          return {
            kind: 'pending',
            approvalId: 'approval-cloud-pi',
            message: 'Waiting for manager',
          };
        },
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member: {
        ...member,
        channel: 'lark',
        larkOpenId: 'ou-requester',
        larkTenantKey: 'tenant-1',
        runtimeChatId: 'oc_runtime_chat',
        runtimeRunId: 'run-1',
      },
      toolId: 'fakeTool',
      args: { query: 'send it' },
      requestId: 'trace-1',
      execution: {
        version: 1,
        threadId: 'oc_chat:thread:om_root',
        runId: 'run-1',
        actionId: 'call-1',
      },
    });

    assert.equal(result.status, 'approval_required');
    assert.equal(approvalInput.runContext.tenantId, 'tenant-1');
    assert.equal(approvalInput.runContext.userExternalId, 'ou-requester');
    assert.equal(approvalInput.runContext.chatId, 'oc_runtime_chat');
    assert.equal(approvalInput.runContext.replyToMessageId, 'om_root');
    assert.equal(approvalInput.runContext.replyInThread, true);
    // Taken off the signed lease, and the only way a tool can reach the request
    // that started this run when it needs to ask for OAuth.
    assert.equal(approvalInput.runContext.runtimeRunId, 'run-1');
    assert.match(approvalInput.chatId, /^gateway:company:co-test:requester:user-test:/);
  });

  it('returns approval_rejected when an exact gateway action was rejected by the manager', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      permissionCheck: () => ok('create'),
    }));
    const permissions = makePermissionService({
      ...makeAllowedPerm('fakeTool', ['create']),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MEMBER' as never,
        zohoReadScope: 'personalized',
      },
    });

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      approvalGate: {
        check: async () => ({
          kind: 'rejected',
          approvalId: 'approval-1',
          message: 'This action was rejected by the manager.',
        }),
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'gateway' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'approval_rejected');
    assert.equal(result.approval?.approvalId, 'approval-1');
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

  it('persists a thrown approved mutation as uncertain and blocks the exact retry', async () => {
    let executions = 0;
    let failedExecution = false;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['send']),
      permissionCheck: () => ok('send'),
      execute: async () => {
        executions++;
        throw new Error('provider disconnected after accepting the request');
      },
    }));
    const approvalGate = {
      check: async () => failedExecution
        ? {
            kind: 'execution_failed',
            approvalId: 'approval-thrown',
            message: 'Provider outcome is uncertain. Do not run the exact action again.',
            authority: 'department_manager',
            approverName: 'Finance Manager',
            requestState: 'reused',
            nextAction: 'change_request',
            retry: 'change_request',
          }
        : {
            kind: 'allowed',
            executionGrant: { approvalId: 'approval-thrown' },
          },
      completeExecution: async () => true,
      failExecution: async () => {
        failedExecution = true;
        return true;
      },
    };
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      approvalGate: approvalGate as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const input = {
      member,
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'one exact send' },
    };

    const first = await executor.invoke(input);
    const retry = await executor.invoke(input);

    assert.equal(first.status, 'tool_error');
    assert.match(first.error?.message ?? '', /provider disconnected/i);
    assert.equal(retry.status, 'approval_execution_failed');
    assert.equal(retry.approval?.status, 'failed');
    assert.equal(executions, 1);
  });

  it('completes an approved execution grant after successful tool invocation', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['send']),
      permissionCheck: () => ok('send'),
    }));

    const completed: unknown[] = [];
    const approvalGate = {
      check: async () => ({
        kind: 'allowed',
        executionGrant: { approvalId: 'approval-1' },
      }),
      completeExecution: async (_grant: { approvalId: string }, resultJson: unknown) => {
        completed.push(resultJson);
        return true;
      },
      failExecution: async () => true,
    };
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      approvalGate: approvalGate as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'hello' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(completed, [{ status: 'success', result: { result: 'echo:hello' } }]);
  });

  it('does not report success when an approved mutation has no durable terminal checkpoint', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['send']),
      permissionCheck: () => ok('send'),
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      approvalGate: {
        check: async () => ({
          kind: 'allowed',
          executionGrant: { approvalId: 'approval-checkpoint-failed' },
        }),
        completeExecution: async () => false,
        failExecution: async () => false,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'one exact send' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'approval_execution_failed');
    assert.match(result.error?.message ?? '', /durably store its final state/i);
  });

  for (const blocked of [
    {
      decision: {
        kind: 'limited',
        policySource: 'manager_policy',
        check: { allowed: false, windows: [] },
        message: 'Connection budget reached.',
      },
      status: 'rate_limited',
    },
    {
      decision: { kind: 'unavailable', message: 'Connection budget unavailable.' },
      status: 'rate_limit_unavailable',
    },
  ] as const) {
    it(`releases a claimed gateway approval when final rate consumption returns ${blocked.status}`, async () => {
      let executions = 0;
      let releases = 0;
      const registry = new ToolRegistry();
      registry.register(makeFakeTool({
        actionGroups: new Set(['send']),
        permissionCheck: () => ok('send'),
        execute: async () => {
          executions++;
          return ok({ result: 'unexpected' });
        },
      }));
      const approvalGate = {
        check: async () => ({
          kind: 'allowed',
          executionGrant: { approvalId: 'approval-rate-gateway' },
        }),
        releaseExecution: async () => {
          releases++;
          return true;
        },
        completeExecution: async () => true,
        failExecution: async () => true,
      };
      const executor = new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
        approvalGate: approvalGate as never,
        connectionRateLimits: {
          preflight: async () => ({ kind: 'not_governed' }),
          consume: async () => blocked.decision,
        } as never,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      });

      const result = await executor.invoke({
        member,
        departmentId: 'dept-1',
        toolId: 'fakeTool',
        args: { query: 'hello' },
      });

      assert.equal(result.status, blocked.status);
      assert.equal(executions, 0);
      assert.equal(releases, 1);
    });

    it(`releases a claimed runtime approval when final rate consumption returns ${blocked.status}`, async () => {
      let executions = 0;
      let releases = 0;
      const registry = new ToolRegistry();
      registry.register(makeFakeTool({
        actionGroups: new Set(['send']),
        permissionCheck: () => ok('send'),
        execute: async () => {
          executions++;
          return ok({ result: 'unexpected' });
        },
      }));
      const approvalGate = {
        check: async () => ({
          kind: 'allowed',
          executionGrant: { approvalId: 'approval-rate-runtime' },
        }),
        releaseExecution: async () => {
          releases++;
          return true;
        },
        completeExecution: async () => true,
        failExecution: async () => true,
      };
      const executor = new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
        connectionRateLimits: {
          preflight: async () => ({ kind: 'not_governed' }),
          consume: async () => blocked.decision,
        } as never,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      });

      const result = await executor.executeForRuntime({
        toolId: 'fakeTool',
        args: { query: 'hello' },
        runContext: {
          companyId: 'co-test',
          userId: 'user-test',
          companyRole: 'MEMBER',
          channel: 'desktop',
          chatId: 'thread-1',
        } as never,
        perm: makeAllowedPerm('fakeTool', ['send']),
        approvalGate: approvalGate as never,
        chatId: 'thread-1',
      });

      assert.equal(result.status, blocked.status);
      assert.equal(executions, 0);
      assert.equal(releases, 1);
    });
  }

  it('does not start a runtime tool after its parent run is cancelled', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async () => {
        executions += 1;
        return ok({ result: 'unexpected' });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.executeForRuntime({
      toolId: 'fakeTool',
      args: { query: 'hello' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
      } as never,
      perm: makeAllowedPerm('fakeTool', ['read']),
      abortSignal: controller.signal,
    });

    assert.equal(result.status, 'tool_error');
    assert.match(result.message ?? '', /cancelled because the parent run ended/i);
    assert.equal(executions, 0);
  });

  // A tool saying "add accountId and retry" was reaching the model as a plain
  // tool_error, so it reported the request as denied rather than correcting the
  // one argument it had been asked to correct.
  it('reports a bad_args tool refusal as invalid_args, not tool_error', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async () => err(new ToolError({
        toolId: 'fakeTool',
        reason: 'bad_args',
        message: 'Add accountId and retry — this is a missing argument.',
      })),
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.executeForRuntime({
      toolId: 'fakeTool',
      args: { query: 'hello' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
      } as never,
      perm: makeAllowedPerm('fakeTool', ['read']),
    });

    assert.equal(result.status, 'invalid_args');
    assert.match(result.message ?? '', /add accountId/i);
  });

  it('still reports other tool failures as tool_error', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async () => err(new ToolError({
        toolId: 'fakeTool',
        reason: 'upstream_failure',
        message: 'Provider is down.',
      })),
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.executeForRuntime({
      toolId: 'fakeTool',
      args: { query: 'hello' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
      } as never,
      perm: makeAllowedPerm('fakeTool', ['read']),
    });

    assert.equal(result.status, 'tool_error');
  });

  it('passes the parent cancellation signal into runtime tool context', async () => {
    let receivedSignal: AbortSignal | undefined;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async (_args, context) => {
        receivedSignal = context.abortSignal;
        return ok({ result: 'done' });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const controller = new AbortController();

    const result = await executor.executeForRuntime({
      toolId: 'fakeTool',
      args: { query: 'hello' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
      } as never,
      perm: makeAllowedPerm('fakeTool', ['read']),
      abortSignal: controller.signal,
    });

    assert.equal(result.status, 'success');
    assert.equal(receivedSignal, controller.signal);
  });

  it('resolves the only accessible connected account before runtime validation', async () => {
    const connectionId = '00000000-0000-4000-8000-000000000001';
    let receivedConnectionId: string | undefined;
    const registry = new ToolRegistry();
    registry.register({
      id: asToolId('zohoCrm'),
      family: 'zoho',
      actionGroups: new Set(['read']),
      argsSchema: z.object({
        connectionId: z.string().uuid(),
        op: z.literal('list'),
      }),
      resultSchema: z.object({ result: z.string() }),
      description: 'Connected-account test tool',
      parameterDocs: 'connectionId, op',
      permissionCheck: () => ok('read'),
      execute: async (args) => {
        receivedConnectionId = args.connectionId;
        return ok({ result: 'done' });
      },
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('zohoCrm', ['read'])),
      connectionRegistry: {
        listAccessibleZohoConnections: async () => ok([{
          connectionId,
          provider: 'zoho',
          label: 'Work Zoho',
          ownerType: 'user',
          access: 'admin',
          scopes: [],
          connectedAt: new Date(),
        }]),
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.executeForRuntime({
      toolId: 'zohoCrm',
      args: { op: 'list' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
      } as never,
      perm: makeAllowedPerm('zohoCrm', ['read']),
    });

    assert.equal(result.status, 'success');
    assert.equal(receivedConnectionId, connectionId);
  });

  it('returns safe connected-account choices instead of guessing between accounts', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      id: asToolId('larkDoc'),
      family: 'lark',
      actionGroups: new Set(['create']),
      argsSchema: z.object({
        connectionId: z.string().uuid(),
        op: z.literal('create'),
      }),
      resultSchema: z.object({ result: z.string() }),
      description: 'Connected-account test tool',
      parameterDocs: 'connectionId, op',
      permissionCheck: () => ok('create'),
      execute: async () => {
        executions += 1;
        return ok({ result: 'unexpected' });
      },
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('larkDoc', ['create'])),
      connectionRegistry: {
        listAccessibleLarkConnections: async () => ok([
          {
            connectionId: '00000000-0000-4000-8000-000000000001',
            provider: 'lark',
            label: 'Primary Lark',
            accountEmail: 'primary@example.com',
            ownerType: 'user',
            access: 'admin',
            scopes: [],
            connectedAt: new Date(),
          },
          {
            connectionId: '00000000-0000-4000-8000-000000000002',
            provider: 'lark',
            label: 'Shared Lark',
            accountEmail: 'shared@example.com',
            ownerType: 'company',
            access: 'read_write',
            scopes: [],
            connectedAt: new Date(),
          },
        ]),
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.executeForRuntime({
      toolId: 'larkDoc',
      args: { op: 'create' },
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
      } as never,
      perm: makeAllowedPerm('larkDoc', ['create']),
    });

    assert.equal(result.status, 'invalid_args');
    assert.match(result.message ?? '', /Primary Lark/);
    assert.match(result.message ?? '', /Shared Lark/);
    assert.equal(executions, 0);
  });

  it('keeps manager-approval scope stable when the same requester and run renews its session', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['send']),
      permissionCheck: () => ok('send'),
    }));
    const approvalChatIds: string[] = [];
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      approvalGate: {
        check: async (input: { chatId: string }) => {
          approvalChatIds.push(input.chatId);
          return {
            kind: 'pending',
            approvalId: 'approval-1',
            message: 'Waiting for the exact approver.',
            authority: 'department_manager',
            approverName: 'Finance Manager',
            requestState: 'reused',
            nextAction: 'wait',
            retry: 'retry_exact',
          };
        },
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const execution = {
      version: 1 as const,
      threadId: 'thread-stable',
      runId: 'run-stable',
      actionId: 'action-retried',
    };

    await executor.invoke({
      member,
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'hello' },
      execution,
    });
    await executor.invoke({
      member: { ...member, sessionId: 'renewed-session' },
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'hello' },
      execution,
    });

    assert.equal(approvalChatIds.length, 2);
    assert.equal(approvalChatIds[0], approvalChatIds[1]);
    assert.match(approvalChatIds[0]!, /requester:user-test/);
    assert.doesNotMatch(approvalChatIds[0]!, /sess-test|renewed-session/);
  });

  it('returns a stored completed approval result without executing the tool again', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['send']),
      permissionCheck: () => ok('send'),
      execute: async () => {
        executions++;
        return ok({ result: 'unexpected' });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      approvalGate: {
        check: async () => ({
          kind: 'completed',
          approvalId: 'approval-1',
          result: { result: 'gmail-message-1' },
        }),
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      departmentId: 'dept-1',
      toolId: 'fakeTool',
      args: { query: 'hello' },
    });

    assert.equal(result.ok, true);
    assert.equal(executions, 0);
    assert.deepEqual((result.data as any).result, { result: 'gmail-message-1' });
    assert.deepEqual((result.data as any).replayedApproval, {
      approvalId: 'approval-1',
      status: 'completed',
    });
  });
});

describe('LocalApprovalIntentService', () => {
  it('classifies reads without executing or creating an approval intent', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      execute: async (args) => {
        executions++;
        return ok({ result: `echo:${args.query}` });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await makeLocalApprovals(executor).prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'preview only' },
    });

    assert.equal(result.ok, true);
    assert.equal((result.data as any).action, 'read');
    assert.equal((result.data as any).requiresApproval, false);
    assert.equal((result.data as any).intentId, undefined);
    assert.equal(executions, 0);
  });

  it('commits the exact validated write args once and rejects replay', async () => {
    const executed: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['update']),
      permissionCheck: () => ok('update'),
      execute: async (args) => {
        executed.push(args);
        return ok({ result: `echo:${args.query}` });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['update'])),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor);

    const prepared = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      // Zod strips the unrecognized property, binding the intent to normalized args.
      args: { query: 'original', ignored: 'not executable' },
    });
    assert.equal(prepared.ok, true);
    assert.equal((prepared.data as any).requiresApproval, true);
    assert.equal((prepared.data as any).action, 'update');
    assert.match((prepared.data as any).intentId, /^[0-9a-f-]{36}$/);
    assert.match((prepared.data as any).argsHash, /^[0-9a-f]{64}$/);
    assert.equal((prepared.data as any).presentation.kind, 'generic.fakeTool.update');

    const intentId = (prepared.data as any).intentId as string;
    const committed = await approvals.commit({ member, intentId });
    assert.equal(committed.ok, true);
    assert.deepEqual(executed, [{ query: 'original' }]);

    const replay = await approvals.commit({ member, intentId });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 'approval_intent_consumed');
    assert.equal(executed.length, 1);
  });

  it('treats a revoked skill binding as advisory while rechecking backend permission', async () => {
    let authorized = true;
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['update']),
      permissionCheck: () => ok('update'),
      execute: async () => {
        executions++;
        return ok({ result: 'unexpected' });
      },
    }));
    const permissions = makePermissionService(makeAllowedPerm('fakeTool', ['update']));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor, undefined, undefined, {
      permissions,
      skillCatalog: {
        authorizesTool: async () => authorized,
      } as unknown as SkillCatalogService,
    });
    const prepared = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'bound write' },
    });
    authorized = false;

    const committed = await approvals.commit({
      member,
      intentId: (prepared.data as any).intentId,
    });

    assert.equal(committed.status, 'success');
    assert.equal(executions, 1);
  });

  it('returns deterministic Google Workspace and Zoho presentation payloads for the UI registry', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...makeFakeTool(),
      id: asToolId('googleGmail'),
      family: 'google',
      actionGroups: new Set(['send']),
      argsSchema: z.object({
        connectionId: z.string(),
        op: z.literal('call'),
        nativeTool: z.literal('send_gmail_message'),
        input: z.record(z.unknown()),
      }),
      permissionCheck: () => ok('send'),
    } as Tool<unknown, unknown>);
    registry.register({
      ...makeFakeTool(),
      id: asToolId('zohoCrm'),
      family: 'zoho',
      actionGroups: new Set(['update']),
      argsSchema: z.object({
        connectionId: z.string(),
        op: z.literal('update'),
        module: z.string(),
        recordId: z.string(),
        fields: z.record(z.unknown()),
      }),
      permissionCheck: () => ok('update'),
    } as Tool<unknown, unknown>);
    const permissions = makePermissionService({
      ...makeAllowedPerm('googleGmail', ['send']),
      allowedToolIds: new Set([asToolId('googleGmail'), asToolId('zohoCrm')]),
      allowedActionsByTool: new Map([
        [asToolId('googleGmail'), new Set(['send'] as const)],
        [asToolId('zohoCrm'), new Set(['update'] as const)],
      ]),
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor);

    const gmail = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'googleGmail',
      args: {
        connectionId: 'google-1',
        op: 'call',
        nativeTool: 'send_gmail_message',
        input: {
          to: ['maya@example.com'],
          subject: 'Q3 rollout',
          body: 'Hi Maya',
        },
      },
    });
    assert.deepEqual((gmail.data as any).presentation, {
      kind: 'google.gmail.send_gmail_message',
      provider: 'google',
      title: 'Review email before sending',
      action: 'send',
      operation: 'send_gmail_message',
      details: {
        connectionId: 'google-1',
        nativeTool: 'send_gmail_message',
        input: {
          to: ['maya@example.com'],
          subject: 'Q3 rollout',
          body: 'Hi Maya',
        },
      },
    });

    const zoho = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'zohoCrm',
      args: {
        connectionId: 'zoho-1',
        op: 'update',
        module: 'Deals',
        recordId: 'D-1842',
        fields: { Stage: 'Closed Won', Amount: 925000 },
      },
    });
    assert.deepEqual((zoho.data as any).presentation, {
      kind: 'zoho.crm.update',
      provider: 'zoho',
      title: 'Review Zoho CRM update',
      action: 'update',
      operation: 'update',
      details: {
        connectionId: 'zoho-1',
        module: 'Deals',
        recordId: 'D-1842',
        fields: { Stage: 'Closed Won', Amount: 925000 },
      },
    });
  });

  it('renders knowledge review intents without internal target or asset IDs', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...makeFakeTool(),
      id: asToolId('knowledge'),
      family: 'memory',
      actionGroups: new Set(['create']),
      argsSchema: z.object({
        operation: z.literal('propose'),
        kind: z.literal('file'),
        action: z.literal('publish'),
        scope: z.literal('department'),
        departmentId: z.string(),
        logicalKey: z.string(),
        content: z.object({
          assetId: z.string(),
          fileName: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number(),
          sha256: z.string(),
        }),
      }),
      permissionCheck: () => ok('create'),
    } as Tool<any, any>);
    const permissions = makePermissionService(makeAllowedPerm('knowledge', ['create']));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const prepared = await makeLocalApprovals(executor).prepare({
      member,
      departmentId: 'dept-internal-id',
      skillId: 'allowed-skill',
      toolId: 'knowledge',
      args: {
        operation: 'propose',
        kind: 'file',
        action: 'publish',
        scope: 'department',
        departmentId: 'dept-internal-id',
        logicalKey: 'qa-runbook',
        content: {
          assetId: 'asset-internal-id',
          fileName: 'QA Runbook.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          sha256: 'a'.repeat(64),
        },
      },
    });

    assert.deepEqual((prepared.data as any).presentation, {
      kind: 'knowledge.file.publish',
      provider: 'divo',
      title: 'Review selected department file change',
      action: 'create',
      operation: 'propose',
      details: {
        target: 'Selected department',
        resource: 'file',
        change: 'publish',
        logicalKey: 'qa-runbook',
        exactContent: {
          fileName: 'QA Runbook.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          sha256: 'a'.repeat(64),
        },
      },
    });
    assert.doesNotMatch(JSON.stringify((prepared.data as any).presentation), /internal-id/);
  });

  it('binds an intent to the preparing session and department', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({ permissionCheck: () => ok('create') }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['create'])),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor);
    const prepared = await approvals.prepare({
      member,
      departmentId: 'dept-1',
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'bound' },
    });
    const intentId = (prepared.data as any).intentId as string;

    const wrongSession = await approvals.commit({
      member: { ...member, sessionId: 'sess-other' },
      departmentId: 'dept-1',
      intentId,
    });
    assert.equal(wrongSession.status, 'approval_intent_not_found');

    const wrongDepartment = await approvals.commit({
      member,
      departmentId: 'dept-2',
      intentId,
    });
    assert.equal(wrongDepartment.status, 'approval_intent_not_found');

    const committed = await approvals.commit({ member, departmentId: 'dept-1', intentId });
    assert.equal(committed.ok, true);
  });

  it('binds a local approval intent to one exact desktop thread, run, and action', async () => {
    const executed: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      permissionCheck: () => ok('create'),
      execute: async (args) => {
        executed.push(args);
        return ok({ result: `echo:${args.query}` });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['create'])),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor);
    const execution = {
      version: 1 as const,
      threadId: 'thread-a',
      runId: 'run-a',
      actionId: 'tool-call-a',
    };
    const prepared = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'isolated' },
      execution,
    });
    const intentId = (prepared.data as any).intentId as string;

    const wrongRun = await approvals.commit({
      member,
      intentId,
      execution: { ...execution, runId: 'run-b' },
    });
    assert.equal(wrongRun.status, 'approval_intent_not_found');

    const wrongAction = await approvals.commit({
      member,
      intentId,
      execution: { ...execution, actionId: 'tool-call-b' },
    });
    assert.equal(wrongAction.status, 'approval_intent_not_found');

    const committed = await approvals.commit({ member, intentId, execution });
    assert.equal(committed.ok, true);
    assert.deepEqual(executed, [{ query: 'isolated' }]);
  });

  it('expires uncommitted intents using the injected clock', async () => {
    let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
    const clock: Clock = { now: () => new Date(nowMs), nowMs: () => nowMs };
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({ permissionCheck: () => ok('delete') }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['delete'])),
      logger: noopLogger,
      clock,
    });
    const approvals = makeLocalApprovals(executor, clock, 1_000);
    const prepared = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'expire me' },
    });
    assert.equal((prepared.data as any).expiresAt, '2026-07-10T00:00:01.000Z');

    nowMs += 1_000;
    const expired = await approvals.commit({
      member,
      intentId: (prepared.data as any).intentId,
    });
    assert.equal(expired.status, 'approval_intent_expired');
  });

  it('rejects a concurrent commit while the first exact action is running', async () => {
    let releaseExecution!: () => void;
    const executionStarted = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let allowCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { allowCompletion = resolve; });
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      permissionCheck: () => ok('send'),
      execute: async (args) => {
        releaseExecution();
        await completion;
        return ok({ result: `echo:${args.query}` });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['send'])),
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor);
    const prepared = await approvals.prepare({
      member,
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'once' },
    });
    const intentId = (prepared.data as any).intentId as string;

    const firstCommit = approvals.commit({ member, intentId });
    await executionStarted;
    const concurrent = await approvals.commit({ member, intentId });
    assert.equal(concurrent.status, 'approval_intent_busy');
    allowCompletion();
    assert.equal((await firstCommit).ok, true);
  });

  it('keeps the local intent retryable while manager approval is pending', async () => {
    let checks = 0;
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      permissionCheck: () => ok('create'),
      execute: async () => {
        executions++;
        return ok({ result: 'done' });
      },
    }));
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: makePermissionService(makeAllowedPerm('fakeTool', ['create'])),
      approvalGate: {
        check: async () => ++checks === 1
          ? { kind: 'pending', approvalId: 'manager-1', message: 'Waiting for manager' }
          : { kind: 'allowed' },
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const approvals = makeLocalApprovals(executor);
    const prepared = await approvals.prepare({
      member,
      departmentId: 'dept-1',
      skillId: 'allowed-skill',
      toolId: 'fakeTool',
      args: { query: 'manager-gated' },
    });
    const intentId = (prepared.data as any).intentId as string;

    const pending = await approvals.commit({ member, departmentId: 'dept-1', intentId });
    assert.equal(pending.status, 'approval_required');
    assert.equal(executions, 0);

    const approved = await approvals.commit({ member, departmentId: 'dept-1', intentId });
    assert.equal(approved.ok, true);
    assert.equal(executions, 1);
    assert.equal((await approvals.commit({ member, departmentId: 'dept-1', intentId })).status, 'approval_intent_consumed');
  });
});

describe('GatewayDispatcher', () => {
  const allowedSkill: CatalogSkill = {
    id: 'allowed-skill',
    slug: 'allowed-skill',
    name: 'Allowed',
    description: 'Allowed skill',
    instructions: 'Do allowed things',
    toolIds: ['fakeTool'],
    revision: 1,
  };
  const blockedSkill: CatalogSkill = {
    id: 'blocked-skill',
    slug: 'blocked-skill',
    name: 'Blocked',
    description: 'Blocked skill',
    instructions: 'Do blocked things',
    toolIds: ['zohoCrm'],
    revision: 1,
  };
  const instructionOnlySkill: CatalogSkill = {
    id: 'instruction-only-skill',
    slug: 'instruction-only-skill',
    name: 'Instruction only',
    description: 'A recipe that declares no backend tools',
    instructions: 'Follow these presentation instructions',
    toolIds: [],
    revision: 1,
  };
  const routerSkill: CatalogSkill = {
    id: 'work-router',
    slug: 'work-router',
    name: 'Allowed Work Router',
    description: 'Route allowed company work to an exact specialist.',
    instructions: 'Load allowed-skill for fakeTool work.',
    toolIds: [],
    aliases: [],
    tags: ['router'],
    revision: 1,
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
      skillCatalog: makeSkillCatalog([routerSkill, allowedSkill, blockedSkill, instructionOnlySkill]),
      toolExecutor,
      logger: noopLogger,
    });
  }

  it('returns accessible connections through connections.list when Google tools are allowed', async () => {
    const perm = makeAllowedPerm('googleGmail', ['read']);
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: new ToolRegistry(),
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: new ToolExecutor({
        toolRegistry: new ToolRegistry(),
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      connectionRegistry: {
        listAccessibleGoogleConnections: async () => ok([{
          connectionId: 'conn-google-1',
          provider: 'google_workspace',
          label: 'Outreach Google',
          accountEmail: 'outreach@example.com',
          ownerType: 'company',
          access: 'read_only',
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          connectedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]),
      },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'connections.list',
      payload: { provider: 'google_workspace' },
    }, member);

    assert.equal(result.ok, true);
    const data = result.data as { connections: Array<{ connectionId: string; access: string }> };
    assert.deepEqual(data.connections, [{
      connectionId: 'conn-google-1',
      provider: 'google_workspace',
      label: 'Outreach Google',
      accountEmail: 'outreach@example.com',
      accountName: null,
      ownerType: 'company',
      ownerUserId: null,
      access: 'read_only',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    }]);
  });

  it('returns accessible Airtable connections only through the explicit Airtable provider', async () => {
    const perm = makeAllowedPerm('airtableRecords', ['read']);
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: new ToolRegistry(),
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: new ToolExecutor({
        toolRegistry: new ToolRegistry(),
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      connectionRegistry: {
        listAccessibleAirtableConnections: async () => ok([{
          connectionId: 'conn-airtable-1',
          provider: 'airtable',
          label: 'Finance Airtable',
          ownerType: 'user',
          ownerUserId: 'manager-1',
          access: 'read_write',
          scopes: ['data.records:read'],
          connectedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]),
      },
      logger: noopLogger,
    });

    const missingProvider = await dispatcher.dispatch({
      op: 'connections.list',
      payload: {},
    }, member);
    assert.equal(missingProvider.ok, false);
    assert.equal(missingProvider.status, 'bad_request');

    const result = await dispatcher.dispatch({
      op: 'connections.list',
      payload: { provider: 'airtable' },
    }, member);

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as any).connections[0], {
      connectionId: 'conn-airtable-1',
      provider: 'airtable',
      label: 'Finance Airtable',
      accountEmail: null,
      accountName: null,
      ownerType: 'user',
      ownerUserId: 'manager-1',
      access: 'read_write',
      scopes: ['data.records:read'],
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    });
  });

  it('returns shared Canva connections only when Canva RBAC is allowed', async () => {
    const perm = makeAllowedPerm('canvaDesign', ['read']);
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: new ToolRegistry(),
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: new ToolExecutor({
        toolRegistry: new ToolRegistry(),
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      connectionRegistry: {
        listAccessibleCanvaConnections: async () => ok([{
          connectionId: 'conn-canva-1',
          provider: 'canva',
          label: 'Marketing Canva',
          ownerType: 'user',
          ownerUserId: 'manager-1',
          access: 'read_write',
          scopes: [],
          connectedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]),
      },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'connections.list',
      payload: { provider: 'canva' },
    }, member);

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as any).connections[0], {
      connectionId: 'conn-canva-1',
      provider: 'canva',
      label: 'Marketing Canva',
      accountEmail: null,
      accountName: null,
      ownerType: 'user',
      ownerUserId: 'manager-1',
      access: 'read_write',
      scopes: [],
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    });
  });

  it('returns accessible Lark connections only when at least one Lark tool is allowed', async () => {
    const perm = makeAllowedPerm('larkCalendar', ['read']);
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: new ToolRegistry(),
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: new ToolExecutor({
        toolRegistry: new ToolRegistry(),
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      connectionRegistry: {
        listAccessibleLarkConnections: async () => ok([{
          connectionId: 'conn-lark-1',
          provider: 'lark',
          label: 'Finance Lark',
          accountName: 'Finance manager',
          ownerType: 'user',
          ownerUserId: 'manager-1',
          access: 'read_only',
          scopes: ['calendar:calendar:readonly'],
          connectedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]),
      },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'connections.list',
      payload: { provider: 'lark' },
    }, member);

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as any).connections[0], {
      connectionId: 'conn-lark-1',
      provider: 'lark',
      label: 'Finance Lark',
      accountEmail: null,
      accountName: 'Finance manager',
      ownerType: 'user',
      ownerUserId: 'manager-1',
      access: 'read_only',
      scopes: ['calendar:calendar:readonly'],
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    });
  });

  it('returns unknown_op for unsupported operation', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({ op: 'nope.op' }, member);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown_op');

    const retiredGooglePlan = await dispatcher.dispatch({ op: 'google.plan' }, member);
    assert.equal(retiredGooglePlan.ok, false);
    assert.equal(retiredGooglePlan.status, 'unknown_op');
  });

  it('opens requester review only from a backend-authenticated Lark runtime', async () => {
    const opened: unknown[] = [];
    const completedEffects: unknown[] = [];
    const perm = makeAllowedPerm('knowledge', ['create']);
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([{
        id: 'share-memory-skill',
        slug: 'share-memory',
        name: 'Share Memory',
        description: 'Review and share durable memory',
        instructions: 'Review before publishing shared memory.',
        toolIds: ['knowledge'],
        revision: 1,
      }]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      larkKnowledgeReview: {
        openMemoryForRuntime: async input => {
          opened.push(input);
          await input.onOpened?.({
            reviewId: 'review-1',
            cardMessageId: 'om_card_1',
            message: 'Review card sent',
          });
          return { opened: true, message: 'Review card sent' };
        },
      },
      runEffectReceipts: {
        reserveKnowledgeReview: async () => ({ status: 'claimed' }),
        completeKnowledgeReview: async input => {
          completedEffects.push(input);
          return {} as any;
        },
        releaseKnowledgeReview: async () => {},
      },
      logger: noopLogger,
    });
    const larkRuntimeMember: GatewayMemberContext = {
      ...member,
      channel: 'lark',
      runtimeChatId: 'oc_source_chat',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    };

    const result = await dispatcher.dispatch({
      op: 'knowledge.review.open',
      departmentId: 'dept-finance',
      execution: {
        version: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        actionId: 'memory-review:1',
      },
      payload: {
        skillId: 'share-memory-skill',
        requestId: 'proposal-1',
        kind: 'memory',
        bullets: ['The finance close completes by day five.'],
        requestedScope: 'department',
      },
    }, larkRuntimeMember);

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {
      status: 'review_pending',
      message: 'Review card sent',
      effect: { kind: 'memory_review_opened', runId: 'run-1' },
      reused: false,
    });
    assert.equal(opened.length, 1);
    const openInput = opened[0] as Record<string, unknown>;
    assert.deepEqual({ ...openInput, onOpened: undefined }, {
      proposalId: 'proposal-1',
      facts: ['The finance close completes by day five.'],
      requestedScope: 'department',
      runContext: {
        companyId: 'co-test',
        userId: 'user-test',
        companyRole: 'MEMBER',
        channel: 'lark',
        userExternalId: 'ou_test',
        chatId: 'oc_source_chat',
        departmentId: 'dept-finance',
      },
      perm,
      chatId: 'oc_source_chat',
      onOpened: undefined,
    });
    assert.deepEqual(completedEffects, [{
      identity: {
        companyId: 'co-test',
        userId: 'user-test',
        chatId: 'oc_source_chat',
        threadId: 'thread-1',
        runId: 'run-1',
      },
      requestId: 'proposal-1',
      reviewId: 'review-1',
      cardMessageId: 'om_card_1',
      message: 'Review card sent',
    }]);
  });

  it('applies explicit personal memory synchronously and records the exact Lark run receipt', async () => {
    const commands: unknown[] = [];
    const receipts: unknown[] = [];
    const audits: unknown[] = [];
    const registry = new ToolRegistry();
    const perm = makeAllowedPerm('knowledge', ['create', 'update', 'delete']);
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      personalMemoryCommands: {
        recoverApplied: async () => null,
        execute: async input => {
          commands.push(input);
          return {
            action: 'updated',
            logicalKey: 'communication.answers.detail',
            resourceId: '11111111-1111-4111-8111-111111111111',
            version: 3,
            projection: 'completed',
          };
        },
      } as any,
      runEffectReceipts: {
        reserveKnowledgeReview: async () => ({ status: 'claimed' }),
        completeKnowledgeReview: async () => ({} as any),
        releaseKnowledgeReview: async () => {},
        reservePersonalMemory: async () => ({ status: 'claimed', reservationToken: 'reservation-1' }),
        releasePersonalMemory: async () => {},
        recordPersonalMemory: async (identity, input) => {
          receipts.push({ identity, input });
          return {} as any;
        },
      },
      auditService: {
        record: (input: unknown) => audits.push(input),
      },
      logger: noopLogger,
    });
    const larkRuntimeMember: GatewayMemberContext = {
      ...member,
      channel: 'lark',
      runtimeChatId: 'oc_source_chat',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    };

    const result = await dispatcher.dispatch({
      op: 'memory.personal.mutate',
      execution: {
        version: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        actionId: 'personal-memory-1',
      },
      payload: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['The user prefers very detailed answers.'],
      },
    }, larkRuntimeMember);

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {
      status: 'applied',
      scope: 'personal',
      action: 'updated',
      logicalKey: 'communication.answers.detail',
      resourceId: '11111111-1111-4111-8111-111111111111',
      version: 3,
      projection: 'completed',
      effect: { kind: 'personal_memory_applied', runId: 'run-1' },
    });
    assert.equal(commands.length, 1);
    const recordedReceipt = receipts[0] as {
      identity: Record<string, unknown>;
      input: Record<string, unknown>;
    };
    const receiptInput = { ...recordedReceipt.input };
    delete receiptInput.requestHash;
    assert.deepEqual(recordedReceipt.identity, {
      companyId: 'co-test',
      userId: 'user-test',
      chatId: 'oc_source_chat',
      threadId: 'thread-1',
      runId: 'run-1',
    });
    assert.deepEqual(receiptInput, {
      actionId: 'personal-memory-1',
      action: 'updated',
      logicalKey: 'communication.answers.detail',
      resourceId: '11111111-1111-4111-8111-111111111111',
      resourceVersion: 3,
      projection: 'completed',
    });
    assert.match(String(recordedReceipt.input.requestHash), /^[a-f0-9]{64}$/);
    assert.deepEqual(audits, [{
      actorId: 'user-test',
      companyId: 'co-test',
      action: 'gateway.personal_memory.mutate',
      outcome: 'success',
      metadata: {
        channel: 'lark',
        action: 'updated',
        logicalKey: 'communication.answers.detail',
        resourceId: '11111111-1111-4111-8111-111111111111',
        version: 3,
        projection: 'completed',
        recovered: false,
        gatewayStatus: 'success',
      },
    }]);
  });

  it('audits denied and failed dedicated personal mutations without storing facts', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(makeAllowedPerm('knowledge', ['update'])),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: {} as any,
      personalMemoryCommands: {
        execute: async ({ command }: { command: { action: string } }) => {
          if (command.action === 'delete') {
            throw new KnowledgeMutationError('permission_denied', 'not permitted');
          }
          throw new Error('database unavailable');
        },
      } as any,
      auditService: {
        record: (input: Record<string, unknown>) => audits.push(input),
      },
      logger: noopLogger,
    });

    const base = {
      ...member,
      channel: 'desktop' as const,
    };
    const denied = await dispatcher.dispatch({
      op: 'memory.personal.mutate',
      payload: {
        action: 'delete',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
      },
    }, base);
    const failed = await dispatcher.dispatch({
      op: 'memory.personal.mutate',
      payload: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['private fact must not enter audit metadata'],
      },
    }, base);

    assert.equal(denied.status, 'permission_denied');
    assert.equal(failed.status, 'tool_error');
    assert.deepEqual(audits.map(audit => audit['outcome']), ['failure', 'failure']);
    assert.deepEqual(audits.map(audit => (audit['metadata'] as Record<string, unknown>)['reason']), [
      'permission_denied',
      'execution_failed',
    ]);
    assert.equal(JSON.stringify(audits).includes('private fact'), false);
  });

  it('rejects mismatched personal-memory run provenance before changing data', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(makeAllowedPerm('knowledge', ['create'])),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: {} as any,
      personalMemoryCommands: {
        recoverApplied: async () => null,
        execute: async () => {
          executions++;
          throw new Error('must not execute');
        },
      } as any,
      logger: noopLogger,
    });
    const result = await dispatcher.dispatch({
      op: 'memory.personal.mutate',
      execution: { version: 1, runId: 'wrong-run', threadId: 'thread-1', actionId: 'call-1' },
      payload: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['Detailed answers.'],
      },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(result.status, 'permission_denied');
    assert.equal(executions, 0);
  });

  it('fails closed after a durable personal write when its same-run receipt cannot be stored', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(makeAllowedPerm('knowledge', ['create'])),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: {} as any,
      personalMemoryCommands: {
        recoverApplied: async () => null,
        execute: async () => {
          executions++;
          return {
            action: 'created',
            logicalKey: 'communication.answers.detail',
            resourceId: '11111111-1111-4111-8111-111111111111',
            version: 1,
            projection: 'completed',
          };
        },
      } as any,
      runEffectReceipts: {
        reserveKnowledgeReview: async () => ({ status: 'claimed' }),
        completeKnowledgeReview: async () => ({} as any),
        releaseKnowledgeReview: async () => {},
        reservePersonalMemory: async () => ({ status: 'claimed', reservationToken: 'reservation-1' }),
        releasePersonalMemory: async () => {},
        recordPersonalMemory: async () => { throw new Error('cache unavailable'); },
      },
      logger: noopLogger,
    });
    const result = await dispatcher.dispatch({
      op: 'memory.personal.mutate',
      execution: { version: 1, runId: 'run-1', threadId: 'thread-1', actionId: 'call-1' },
      payload: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['Detailed answers.'],
      },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(executions, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'tool_error');
    assert.match(result.error?.message ?? '', /memory changed.*receipt could not be recorded/i);
  });

  it('recovers a committed Lark delete from an ambiguous receipt write without re-running it', async () => {
    let executions = 0;
    let storedReceipt: Record<string, unknown> | null = null;
    let firstRecord = true;
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(makeAllowedPerm('knowledge', ['delete'])),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: {} as any,
      personalMemoryCommands: {
        recoverApplied: async () => null,
        execute: async () => {
          executions++;
          return {
            action: 'deleted',
            logicalKey: 'communication.answers.detail',
            resourceId: '11111111-1111-4111-8111-111111111111',
            version: 3,
            projection: 'queued',
          };
        },
      } as any,
      runEffectReceipts: {
        reservePersonalMemory: async () => ({ status: 'claimed', reservationToken: 'reservation-1' }),
        releasePersonalMemory: async () => {},
        getPersonalMemory: async (_identity: unknown, actionId: string) =>
          storedReceipt?.['actionId'] === actionId ? storedReceipt as any : null,
        recordPersonalMemory: async (identity: Record<string, unknown>, input: Record<string, unknown>) => {
          storedReceipt = {
            ...identity,
            ...input,
            version: 1,
            kind: 'personal_memory',
            status: 'applied',
            effectKind: 'personal_memory_applied',
            appliedAt: new Date().toISOString(),
          };
          if (firstRecord) {
            firstRecord = false;
            throw new Error('cache response lost after write');
          }
          return storedReceipt as any;
        },
      } as any,
      logger: noopLogger,
    });
    const larkMember: GatewayMemberContext = {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    };
    const request = {
      op: 'memory.personal.mutate' as const,
      execution: { version: 1 as const, runId: 'run-1', threadId: 'thread-1', actionId: 'delete-1' },
      payload: {
        action: 'delete' as const,
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
      },
    };

    const first = await dispatcher.dispatch(request, larkMember);
    const retry = await dispatcher.dispatch(request, larkMember);

    assert.equal(first.status, 'tool_error');
    assert.equal(retry.ok, true);
    assert.equal((retry.data as { action: string }).action, 'deleted');
    assert.equal(executions, 1);
  });

  it('recovers a committed Lark delete from canonical evidence when its exact cache write was lost', async () => {
    let executions = 0;
    let recordAttempts = 0;
    let reserved = false;
    const durableResult = {
      action: 'deleted' as const,
      logicalKey: 'communication.answers.detail',
      resourceId: '11111111-1111-4111-8111-111111111111',
      version: 3,
      projection: 'queued' as const,
    };
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(makeAllowedPerm('knowledge', ['delete'])),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: {} as any,
      personalMemoryCommands: {
        recoverApplied: async () => executions > 0 ? durableResult : null,
        execute: async () => {
          executions += 1;
          return durableResult;
        },
      } as any,
      runEffectReceipts: {
        reservePersonalMemory: async () => {
          if (reserved) return { status: 'applying', reservationToken: 'reservation-1' };
          reserved = true;
          return { status: 'claimed', reservationToken: 'reservation-1' };
        },
        releasePersonalMemory: async () => { reserved = false; },
        getPersonalMemory: async () => { throw new Error('cache read unavailable'); },
        recordPersonalMemory: async () => {
          recordAttempts += 1;
          if (recordAttempts === 1) throw new Error('exact cache write unavailable');
          return {} as any;
        },
      } as any,
      logger: noopLogger,
    });
    const larkMember: GatewayMemberContext = {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    };
    const request = {
      op: 'memory.personal.mutate' as const,
      execution: { version: 1 as const, runId: 'run-1', threadId: 'thread-1', actionId: 'delete-cache-lost' },
      payload: {
        action: 'delete' as const,
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
      },
    };

    const first = await dispatcher.dispatch(request, larkMember);
    const retry = await dispatcher.dispatch(request, larkMember);

    assert.equal(first.status, 'tool_error');
    assert.equal(retry.status, 'success');
    assert.equal(executions, 1);
    assert.equal(recordAttempts, 2);
  });

  it('opens exact shared skill review through the backend-owned Lark card flow', async () => {
    const opened: unknown[] = [];
    const perm = makeAllowedPerm('knowledge', ['create']);
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([{
        id: 'knowledge-skill',
        slug: 'knowledge-review',
        name: 'Knowledge Review',
        description: 'Govern shared knowledge',
        instructions: 'Review shared knowledge exactly.',
        toolIds: ['knowledge'],
        revision: 1,
      }]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      larkKnowledgeReview: {
        openMemoryForRuntime: async () => ({ opened: false, message: 'unexpected memory review' }),
        openResourceForRuntime: async input => {
          opened.push(input);
          await input.onOpened?.({
            reviewId: 'review-skill-1',
            cardMessageId: 'om_skill_card',
            message: 'Knowledge review card sent',
          });
          return { opened: true, message: 'Knowledge review card sent' };
        },
      },
      runEffectReceipts: {
        reserveKnowledgeReview: async () => ({ status: 'claimed' }),
        completeKnowledgeReview: async () => ({} as any),
        releaseKnowledgeReview: async () => {},
      },
      logger: noopLogger,
    });
    const content = {
      name: 'Document creation',
      slug: 'document-creation',
      summary: 'Create documents consistently.',
      markdown: '# Document creation\n\nRollback before Owners.',
      toolIds: [],
      tags: ['documents'],
    };
    const result = await dispatcher.dispatch({
      op: 'knowledge.review.open',
      departmentId: 'dept-finance',
      execution: { version: 1, runId: 'run-1', threadId: 'thread-1', actionId: 'knowledge-review:1' },
      payload: {
        skillId: 'knowledge-skill',
        requestId: 'knowledge:request-1',
        kind: 'skill',
        action: 'publish',
        scope: 'department',
        logicalKey: 'document-creation',
        content,
      },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'oc_source_chat',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(result.ok, true);
    assert.equal(opened.length, 1);
    const input = opened[0] as Record<string, unknown>;
    assert.equal(input.kind, 'skill');
    assert.equal(input.scope, 'department');
    assert.deepEqual(input.content, content);
  });

  it('rejects memory review from desktop, malformed payloads, and an unbound skill', async () => {
    let openCount = 0;
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(makeAllowedPerm('knowledge', ['create'])),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      larkKnowledgeReview: {
        openMemoryForRuntime: async () => {
          openCount++;
          return { opened: true, message: 'unexpected' };
        },
      },
      logger: noopLogger,
    });
    const payload = {
      skillId: 'allowed-skill',
      requestId: 'proposal-1',
      kind: 'memory',
      bullets: ['Company fact'],
    };

    const desktop = await dispatcher.dispatch({
      op: 'knowledge.review.open',
      payload,
    }, member);
    assert.equal(desktop.status, 'permission_denied');

    const malformed = await dispatcher.dispatch({
      op: 'knowledge.review.open',
      payload: { ...payload, extra: true },
    }, { ...member, channel: 'lark', runtimeChatId: 'oc_source_chat' });
    assert.equal(malformed.status, 'bad_request');

    const unboundSkill = await dispatcher.dispatch({
      op: 'knowledge.review.open',
      payload,
    }, { ...member, channel: 'lark', runtimeChatId: 'oc_source_chat' });
    assert.equal(unboundSkill.status, 'permission_denied');
    assert.equal(openCount, 0);
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
      skillCatalog: makeSkillCatalog([allowedSkill]),
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

    const filtered = await dispatcher.dispatch({
      op: 'tools.list',
      payload: { toolId: 'fakeTool' },
    }, member);
    assert.equal(filtered.ok, true);
    const selectedTools = (filtered.data as {
      tools: Array<{ id: string; parameterDocs: string; argsSchema: unknown }>;
    }).tools;
    assert.equal(selectedTools.length, 1);
    assert.equal(selectedTools[0]?.id, 'fakeTool');
    assert.equal(typeof selectedTools[0]?.parameterDocs, 'string');
    assert.equal(typeof selectedTools[0]?.argsSchema, 'object');

    const unavailable = await dispatcher.dispatch({
      op: 'tools.list',
      payload: { toolId: 'runCommand' },
    }, member);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.status, 'unknown_tool');
  });

  it('lists a permitted family without exposing every child contract and keeps invocation exact', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      id: asToolId('airtableRecords'),
      family: 'airtable',
      description: 'Airtable records',
    }));
    registry.register(makeFakeTool({
      id: asToolId('airtableSchema'),
      family: 'airtable',
      description: 'Airtable schema',
    }));
    registry.register(makeFakeTool({
      id: asToolId('larkBase'),
      family: 'lark',
      description: 'Lark Base',
    }));

    const perm = makeAllowedPerm('airtableRecords', ['read']);
    perm.allowedToolIds.add(asToolId('airtableSchema'));
    perm.allowedActionsByTool.set(asToolId('airtableSchema'), new Set(['read']));
    const permissions = makePermissionService(perm);
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      logger: noopLogger,
    });

    const family = await dispatcher.dispatch({
      op: 'tools.list',
      payload: { family: 'airtable' },
    }, member);
    assert.equal(family.ok, true);
    assert.deepEqual(family.data, {
      selection: {
        kind: 'family',
        id: 'airtable',
        displayName: 'Airtable',
        requestedAs: 'family',
      },
      tools: [
        {
          id: 'airtableRecords',
          family: 'airtable',
          description: 'Airtable records',
          allowedActions: ['read'],
        },
        {
          id: 'airtableSchema',
          family: 'airtable',
          description: 'Airtable schema',
          allowedActions: ['read'],
        },
      ],
    });

    const legacyFamily = await dispatcher.dispatch({
      op: 'tools.list',
      payload: { toolId: 'airtable' },
    }, member);
    assert.equal(legacyFamily.ok, true);
    assert.equal((legacyFamily.data as any).selection.requestedAs, 'legacy_tool_id');
    assert.equal((legacyFamily.data as any).tools.length, 2);

    const exact = await dispatcher.dispatch({
      op: 'tools.list',
      payload: { toolId: 'airtableRecords' },
    }, member);
    assert.equal(exact.ok, true);
    assert.equal((exact.data as any).selection.kind, 'tool');
    assert.equal(typeof (exact.data as any).tools[0].argsSchema, 'object');

    const invocation = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { skillId: 'airtable-router', toolId: 'airtable', args: {} },
    }, member);
    assert.equal(invocation.ok, false);
    assert.equal(invocation.status, 'unknown_tool');
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

  it('returns a granted instruction-only skill without requiring a fake tool', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({
      op: 'skills.get',
      payload: { skillId: 'instruction-only-skill' },
    }, member);

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as { skill: { toolIds: string[] } }).skill.toolIds, []);
  });

  it('returns RBAC-filtered ranked skills.search results', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({
      op: 'skills.search',
      payload: { query: 'please do allowed work', limit: 3 },
    }, member);

    assert.equal(result.ok, true);
    const data = result.data as {
      nextStep: string;
      skills: Array<{ id: string; score: number }>;
    };
    assert.match(data.nextStep, /skills\.get/);
    assert.ok(data.skills.some((s) => s.id === 'work-router' && s.score > 0));
    assert.equal(data.skills.some((s) => s.id === 'blocked-skill'), false);
  });

  it('rejects malformed skills.search payloads', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({
      op: 'skills.search',
      payload: { query: '' },
    }, member);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'bad_request');
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

  it('records a trusted export offer against the exact Lark runtime lease', async () => {
    const offerId = '11111111-1111-4111-8111-111111111111';
    const receipts: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      resultSchema: z.object({
        result: z.string(),
        preview: z.object({ exportOfferId: z.string().uuid() }),
      }) as any,
      execute: async () => ok({ result: '25 rows', preview: { exportOfferId: offerId } }) as any,
    }));
    const permissions = makePermissionService();
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      runEffectReceipts: {
        reserveKnowledgeReview: async () => ({ status: 'claimed' }),
        completeKnowledgeReview: async () => ({} as any),
        releaseKnowledgeReview: async () => {},
        recordPersonalMemory: async () => ({} as any),
        recordDataExportOffer: async (identity, input) => {
          receipts.push({ identity, input });
          return {} as any;
        },
      },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      execution: {
        version: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        actionId: 'call-1',
      },
      payload: { toolId: 'fakeTool', args: { query: 'large dataset' } },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(receipts, [{
      identity: {
        companyId: 'co-test',
        userId: 'user-test',
        chatId: 'chat-1',
        threadId: 'thread-1',
        runId: 'run-1',
      },
      input: { offerId },
    }]);
  });

  it('replaces a resolved Lark Sheet target with a run-bound opaque reference', async () => {
    const receipts: unknown[] = [];
    let executedArgs: unknown;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      id: asToolId('googleSheets'),
      actionGroups: new Set(['read', 'update']),
      argsSchema: z.union([
        z.object({ op: z.literal('resolve_reference'), url: z.string() }),
        z.object({
          op: z.literal('call'),
          connectionId: z.string().uuid(),
          nativeTool: z.string(),
          input: z.record(z.unknown()),
        }),
      ]),
      resultSchema: z.object({}).passthrough(),
      permissionCheck: (args: any) => ok(args.op === 'call' ? 'update' : 'read'),
      execute: async (args: any) => {
        if (args.op === 'call') {
          executedArgs = args;
          return ok({
            success: true,
            message: `Updated ${args.input.spreadsheet_id} through ${args.connectionId}`,
          });
        }
        return ok({
          success: true,
          nativeTool: 'resolve_sheet_reference',
          data: {
            status: 'resolved',
            resource: {
              provider: 'google',
              kind: 'spreadsheet',
              resourceId: 'sheet_1',
              subresourceId: '42',
              connectionId: '11111111-1111-4111-8111-111111111111',
            },
          },
        });
      },
    } as any));
    const permissions = makePermissionService(makeAllowedPerm('googleSheets', ['read']));
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      runEffectReceipts: {
        recordGoogleSheetDestination: async (identity, input) => {
          receipts.push({ identity, input });
          return {} as any;
        },
        getVerifiedGoogleSheetDestination: async (identity, referenceId) => ({
          version: 1,
          kind: 'google_sheet_destination',
          status: 'resolved',
          ...identity,
          referenceId,
          connectionId: '11111111-1111-4111-8111-111111111111',
          spreadsheetId: 'sheet_1',
          gid: '42',
          createdAt: '2026-08-02T00:00:00.000Z',
        }),
      } as any,
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      execution: {
        version: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        actionId: 'sheet-reference-1',
      },
      payload: {
        toolId: 'googleSheets',
        args: {
          op: 'resolve_reference',
          url: 'https://docs.google.com/spreadsheets/d/sheet_1/edit#gid=42',
        },
      },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(result.ok, true);
    const destinationReferenceId = (result.data as any).result.data.destinationReferenceId;
    assert.match(destinationReferenceId, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(result.data).includes('sheet_1'), false);
    assert.equal(JSON.stringify(result.data).includes('11111111-1111-4111-8111-111111111111'), false);
    assert.deepEqual(receipts, [{
      identity: {
        companyId: 'co-test',
        userId: 'user-test',
        chatId: 'chat-1',
        threadId: 'thread-1',
        runId: 'run-1',
      },
      input: {
        referenceId: destinationReferenceId,
        connectionId: '11111111-1111-4111-8111-111111111111',
        spreadsheetId: 'sheet_1',
        gid: '42',
      },
    }]);

    const update = await dispatcher.dispatch({
      op: 'tools.invoke',
      execution: {
        version: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        actionId: 'sheet-update-1',
      },
      payload: {
        toolId: 'googleSheets',
        args: {
          op: 'call_resolved_sheet',
          destinationReferenceId,
          nativeTool: 'modify_sheet_values',
          input: { range_name: 'Sheet1!A1', values: [['verified']] },
        },
      },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(update.ok, true);
    assert.deepEqual(executedArgs, {
      op: 'call',
      connectionId: '11111111-1111-4111-8111-111111111111',
      nativeTool: 'modify_sheet_values',
      input: {
        spreadsheet_id: 'sheet_1',
        range_name: 'Sheet1!A1',
        values: [['verified']],
      },
    });
    assert.equal(JSON.stringify(update.data).includes('sheet_1'), false);
    assert.equal(JSON.stringify(update.data).includes('11111111-1111-4111-8111-111111111111'), false);
  });

  it('replaces a resolved Drive workbook with an opaque confirmation offer', async () => {
    const receipts: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      id: asToolId('googleSheets'),
      actionGroups: new Set(['read']),
      argsSchema: z.object({ op: z.literal('resolve_reference'), url: z.string() }),
      resultSchema: z.object({}).passthrough(),
      permissionCheck: () => ok('read'),
      execute: async () => ok({
        success: true,
        nativeTool: 'resolve_sheet_reference',
        data: {
          status: 'resolved',
          resource: {
            provider: 'google',
            kind: 'excel_workbook',
            resourceId: 'xlsx_file_1',
            connectionId: '11111111-1111-4111-8111-111111111111',
            fileName: 'Forecast.xlsx',
            requiresConfirmation: true,
            conversion: 'new_google_sheet_copy',
          },
        },
      }),
    } as any));
    const permissions = makePermissionService(makeAllowedPerm('googleSheets', ['read']));
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      runEffectReceipts: {
        recordWorkbookConversionOffer: async (identity, input) => {
          receipts.push({ identity, input });
          return {} as any;
        },
      } as any,
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      execution: {
        version: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        actionId: 'workbook-reference-1',
      },
      payload: {
        toolId: 'googleSheets',
        args: {
          op: 'resolve_reference',
          url: 'https://drive.google.com/file/d/xlsx_file_1/view',
        },
      },
    }, {
      ...member,
      channel: 'lark',
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });

    assert.equal(result.ok, true);
    const safe = JSON.stringify(result.data);
    assert.equal(safe.includes('xlsx_file_1'), false);
    assert.equal(safe.includes('11111111-1111-4111-8111-111111111111'), false);
    const conversionOfferId = (result.data as any).result.data.conversionOfferId;
    assert.match(conversionOfferId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(receipts, [{
      identity: {
        companyId: 'co-test',
        userId: 'user-test',
        chatId: 'chat-1',
        threadId: 'thread-1',
        runId: 'run-1',
      },
      input: {
        offerId: conversionOfferId,
        connectionId: '11111111-1111-4111-8111-111111111111',
        fileId: 'xlsx_file_1',
        fileName: 'Forecast.xlsx',
      },
    }]);
  });

  it('materializes an exported Sheet reference only inside the governed Google call', async () => {
    const resourceRef = '22222222-2222-4222-8222-222222222222';
    const connectionId = '11111111-1111-4111-8111-111111111111';
    let executedArgs: unknown;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      id: asToolId('googleSheets'),
      actionGroups: new Set(['read', 'update']),
      argsSchema: z.object({
        op: z.literal('call'),
        connectionId: z.string().uuid(),
        nativeTool: z.string(),
        input: z.record(z.unknown()),
      }),
      resultSchema: z.object({}).passthrough(),
      permissionCheck: () => ok('update'),
      execute: async (args: any) => {
        executedArgs = args;
        return ok({
          success: true,
          spreadsheetId: args.input.spreadsheet_id,
          connectionId: args.connectionId,
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-exported/edit',
        });
      },
    } as any));
    const permissions = makePermissionService(makeAllowedPerm('googleSheets', ['read', 'update']));
    const dataExportResources = {
      getToolTurnByResourceRef: async () => ok({
        id: 'resource-turn',
        role: 'tool' as const,
        content: 'verified export',
        timestamp: '2026-08-02T00:00:00.000Z',
        toolName: 'dataExportResource',
        toolOutcome: {
          version: 1,
          kind: 'data_export_resource',
          resourceRef,
          ownerUserId: 'user-test',
          artifactId: 'sheet-exported',
          artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-exported/edit',
          artifactType: 'google_sheet',
          rowCount: 50,
          connectionId,
          spreadsheetId: 'sheet-exported',
          createdAt: '2026-08-02T00:00:00.000Z',
          expiresAt: '2099-08-09T00:00:00.000Z',
        },
      }),
    };
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      dataExportResources,
      resolveGoogleSheetReference: async () => ({
        status: 'resolved',
        resource: {
          provider: 'google',
          kind: 'spreadsheet',
          connectionId,
          resourceId: 'sheet-exported',
        },
      }),
      logger: noopLogger,
    });
    const execution = {
      version: 1 as const,
      runId: 'run-1',
      threadId: 'thread-1',
      actionId: 'edit-export-1',
    };
    const larkMember = {
      ...member,
      channel: 'lark' as const,
      runtimeChatId: 'chat-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    };
    const specialArgs = {
      op: 'call_exported_sheet',
      resourceRef,
      nativeTool: 'modify_sheet_values',
      input: { range: 'Sheet1!H1:H3', values: [['Notes'], ['Needs review'], ['Needs review']] },
    };

    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      execution,
      payload: { toolId: 'googleSheets', args: specialArgs },
    }, larkMember);

    assert.equal(result.ok, true);
    assert.deepEqual(executedArgs, {
      op: 'call',
      connectionId,
      nativeTool: 'modify_sheet_values',
      input: {
        spreadsheet_id: 'sheet-exported',
        range: 'Sheet1!H1:H3',
        values: [['Notes'], ['Needs review'], ['Needs review']],
      },
    });
    assert.equal(JSON.stringify(result.data).includes(connectionId), false);
    assert.equal(JSON.stringify(result.data).includes('"spreadsheetId"'), false);
    assert.deepEqual((result.data as any).exportedSheet, {
      resourceRef,
      url: 'https://docs.google.com/spreadsheets/d/sheet-exported/edit',
    });

    const preflight = await dispatcher.dispatch({
      op: 'tools.preflight',
      execution,
      payload: { invocations: [{ toolId: 'googleSheets', args: specialArgs }] },
    }, larkMember);
    assert.equal(preflight.ok, true);
    assert.equal(JSON.stringify(preflight.data).includes(connectionId), false);
    assert.equal(JSON.stringify(preflight.data).includes('spreadsheet_id'), false);

    const injectedHandle = await dispatcher.dispatch({
      op: 'tools.invoke',
      execution,
      payload: {
        toolId: 'googleSheets',
        args: { ...specialArgs, input: { ...specialArgs.input, spreadsheet_id: 'attacker' } },
      },
    }, larkMember);
    assert.equal(injectedHandle.status, 'bad_request');

    let deniedResolverCalls = 0;
    const deniedPermissions = makePermissionService(makeDeniedPerm());
    const deniedDispatcher = new GatewayDispatcher({
      permissions: deniedPermissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: deniedPermissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      dataExportResources,
      resolveGoogleSheetReference: async () => {
        deniedResolverCalls += 1;
        return { status: 'resolved' };
      },
      logger: noopLogger,
    });
    const denied = await deniedDispatcher.dispatch({
      op: 'tools.invoke',
      execution,
      payload: { toolId: 'googleSheets', args: specialArgs },
    }, larkMember);
    assert.equal(denied.status, 'permission_denied');
    assert.equal(deniedResolverCalls, 0);

    const rejectingDispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      dataExportResources,
      resolveGoogleSheetReference: async () => {
        throw new Error('provider unavailable');
      },
      logger: noopLogger,
    });
    const rejected = await rejectingDispatcher.dispatch({
      op: 'tools.invoke',
      execution,
      payload: { toolId: 'googleSheets', args: specialArgs },
    }, larkMember);
    assert.equal(rejected.status, 'tool_error');
    assert.match(rejected.error?.message ?? '', /could not verify that Sheet right now/);
  });

  it('does not expose a Lark export offer without matching runtime provenance', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      resultSchema: z.object({ preview: z.object({ exportOfferId: z.string().uuid() }) }) as any,
      execute: async () => ok({
        preview: { exportOfferId: '11111111-1111-4111-8111-111111111111' },
      }) as any,
    }));
    const permissions = makePermissionService();
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      runEffectReceipts: {} as any,
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { toolId: 'fakeTool', args: { query: 'large dataset' } },
    }, { ...member, channel: 'lark' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'tool_error');
    assert.equal(result.data, undefined);
  });

  it('returns a bound write intent from invoke and executes it only after commit', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['update']),
      permissionCheck: () => ok('update'),
      execute: async (args) => {
        executions++;
        return ok({ result: `echo:${args.query}` });
      },
    }));
    const permissions = makePermissionService(makeAllowedPerm('fakeTool', ['update']));
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(toolExecutor),
      logger: noopLogger,
    });

    const bypass = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { skillId: 'allowed-skill', toolId: 'fakeTool', args: { query: 'write' } },
    }, member);
    assert.equal(bypass.status, 'local_approval_required');
    assert.equal(bypass.ok, false);
    assert.equal((bypass.data as any).requiresApproval, true);
    assert.match((bypass.data as any).intentId, /^[0-9a-f-]{36}$/);
    assert.equal(executions, 0);

    const committed = await dispatcher.dispatch({
      op: 'tools.commit',
      payload: { intentId: (bypass.data as any).intentId },
    }, member);
    assert.equal(committed.ok, true);
    assert.equal(executions, 1);
  });

  it('requires local review for knowledge proposals but not a duplicate review for apply', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...makeFakeTool(),
      id: asToolId('knowledge'),
      family: 'memory',
      actionGroups: new Set(['create']),
      argsSchema: z.discriminatedUnion('operation', [
        z.object({ operation: z.literal('propose'), query: z.string() }),
        z.object({ operation: z.literal('apply'), query: z.string() }),
      ]),
      permissionCheck: () => ok('create'),
      execute: async () => {
        executions++;
        return ok({ result: 'applied' });
      },
    } as Tool<any, { result: string }>);
    const permissions = makePermissionService(makeAllowedPerm('knowledge', ['create']));
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const knowledgeSkill = { ...allowedSkill, id: 'knowledge-skill', toolIds: ['knowledge'] };
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([knowledgeSkill]),
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(toolExecutor),
      logger: noopLogger,
    });

    const proposal = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: {
        skillId: knowledgeSkill.id,
        toolId: 'knowledge',
        args: { operation: 'propose', query: 'exact proposal' },
      },
    }, member);
    assert.equal(proposal.status, 'local_approval_required');
    assert.equal(executions, 0);

    const apply = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: {
        skillId: knowledgeSkill.id,
        toolId: 'knowledge',
        args: { operation: 'apply', query: 'exact reviewed mutation' },
      },
    }, member);
    assert.equal(apply.status, 'success');
    assert.equal(executions, 1);
  });

  it('executes Lark writes without desktop-local approval', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['create']),
      permissionCheck: () => ok('create'),
      execute: async () => {
        executions++;
        return ok({ result: 'created' });
      },
    }));
    const permissions = makePermissionService(makeAllowedPerm('fakeTool', ['create']));
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor,
      logger: noopLogger,
    });

    const response = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { skillId: 'allowed-skill', toolId: 'fakeTool', args: { query: 'create' } },
    }, { ...member, channel: 'lark' });

    assert.equal(response.ok, true);
    assert.equal(executions, 1);
  });

  it('returns backend HITL for a governed Lark write without executing it', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      actionGroups: new Set(['create']),
      permissionCheck: () => ok('create'),
      execute: async () => {
        executions++;
        return ok({ result: 'created' });
      },
    }));
    const permissions = makePermissionService(makeAllowedPerm('fakeTool', ['create']));
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      approvalGate: {
        check: async () => ({
          kind: 'pending',
          approvalId: 'approval-lark-create',
          message: 'Finance Manager has an approval request waiting in Divo.',
          authority: 'department_manager',
          approverName: 'Finance Manager',
          requestState: 'pending',
          nextAction: 'wait_for_approval',
          retry: 'retry_exact_after_approval',
        }),
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor,
      logger: noopLogger,
    });

    const response = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { skillId: 'allowed-skill', toolId: 'fakeTool', args: { query: 'create' } },
    }, {
      ...member,
      channel: 'lark',
      larkTenantKey: 'tenant-1',
    });

    assert.equal(response.status, 'approval_required');
    assert.equal(response.ok, false);
    assert.equal(executions, 0);
    assert.deepEqual(response.approval, {
      approvalId: 'approval-lark-create',
      message: 'Finance Manager has an approval request waiting in Divo.',
      status: 'pending',
      authority: 'department_manager',
      approverName: 'Finance Manager',
      scope: 'once',
      requestState: 'pending',
      nextAction: 'wait_for_approval',
      retry: 'retry_exact_after_approval',
    });
  });

  it('executes user-owned Mail Ops mutations directly for Lark only', async () => {
    let replacements = 0;
    const registry = new ToolRegistry();
    registry.register(createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {
        replaceRule: async () => {
          replacements++;
          return { ok: true, value: 'replaced' };
        },
      } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId: '11111111-1111-4111-8111-111111111111',
        mailboxEmail: 'user@example.com',
      }),
    }));
    const permissions = makePermissionService(
      makeAllowedPerm('mailAutomations', ['update', 'execute']),
    );
    const mailOpsSkill = {
      ...allowedSkill,
      id: 'mail-ops',
      slug: 'mail-ops',
      toolIds: ['mailAutomations'],
    };
    const skillCatalog = makeSkillCatalog([mailOpsSkill]);
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog,
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(
        toolExecutor,
        undefined,
        undefined,
        { permissions, skillCatalog },
      ),
      logger: noopLogger,
    });
    const request = {
      op: 'tools.invoke',
      payload: {
        skillId: 'mail-ops',
        toolId: 'mailAutomations',
        args: {
          operation: 'update',
          ruleId: '22222222-2222-4222-8222-222222222222',
          connectionId: '11111111-1111-4111-8111-111111111111',
          name: 'Forward Claude secure links',
          match: {
            from: '@mail.anthropic.com',
            subjectContains: 'Your secure link to Claude.ai',
          },
          destination: {
            type: 'email',
            email: 'owner@example.com',
          },
        },
      },
    };

    const lark = await dispatcher.dispatch(
      request,
      { ...member, channel: 'lark' },
    );
    assert.equal(lark.ok, true);
    assert.equal(replacements, 1);

    const desktop = await dispatcher.dispatch(
      request,
      { ...member, channel: 'desktop' },
    );
    assert.equal(desktop.status, 'local_approval_required');
    assert.equal(replacements, 1);
  });

  it('does not reintroduce desktop-local approval for future Lark Mail Ops mutations', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({
      id: asToolId('mailAutomations'),
      actionGroups: new Set(['update']),
      permissionCheck: () => ok('update'),
      execute: async () => {
        executions++;
        return ok({ result: 'updated' });
      },
    }));
    const permissions = makePermissionService(
      makeAllowedPerm('mailAutomations', ['update']),
    );
    const mailOpsSkill = {
      ...allowedSkill,
      id: 'mail-ops',
      slug: 'mail-ops',
      toolIds: ['mailAutomations'],
    };
    const skillCatalog = makeSkillCatalog([mailOpsSkill]);
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog,
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(
        toolExecutor,
        undefined,
        undefined,
        { permissions, skillCatalog },
      ),
      logger: noopLogger,
    });
    const response = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: {
        skillId: 'mail-ops',
        toolId: 'mailAutomations',
        args: {
          query: 'future',
          operation: 'future_mutation',
        },
      },
    },
      { ...member, channel: 'lark' },
    );
    assert.equal(response.ok, true);
    assert.equal(executions, 1);
  });

  it('exposes and invokes webSearch through the backend gateway when RBAC allows it', async () => {
    const registry = new ToolRegistry();
    registry.register(createWebSearchTool({
      client: {
        search: async (_companyId: string, query: string, limit = 5) => [{
          title: `Result for ${query}`,
          url: 'https://example.com/search-result',
          snippet: `limit=${limit}`,
        }],
      },
    }));
    const perm = makeAllowedPerm('webSearch', ['read']);

    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(perm),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([{
        id: 'research',
        slug: 'research',
        name: 'Research',
        description: 'Backend web research',
        instructions: 'Use webSearch through tools.invoke.',
        toolIds: ['webSearch'],
      }]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(perm),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      logger: noopLogger,
    });

    const listed = await dispatcher.dispatch({ op: 'tools.list' }, member);
    assert.equal(listed.ok, true);
    const tools = (listed.data as { tools: Array<{ id: string }> }).tools;
    assert.ok(tools.some((tool) => tool.id === 'webSearch'));

    const invoked = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { skillId: 'research', toolId: 'webSearch', args: { query: 'Divo gateway search', limit: 1 } },
    }, member);

    assert.equal(invoked.ok, true);
    assert.deepEqual((invoked.data as { result: unknown }).result, {
      success: true,
      results: [{
        title: 'Result for Divo gateway search',
        url: 'https://example.com/search-result',
        snippet: 'limit=1',
      }],
      message: 'Found 1 results',
    });
  });

  it('extracts image OCR through the authenticated media gateway op', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeTool());
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([allowedSkill]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions: makePermissionService(),
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      mediaOcr: {
        extractImage: async (payload: { mimeType: string; fileName?: string }) => ({
          source: {
            fileName: payload.fileName ?? null,
            mimeType: payload.mimeType,
            sizeBytes: 3,
          },
          observationType: 'UNTRUSTED_MEDIA_OBSERVATION' as const,
          ocrText: 'hello',
          caption: 'test image',
          uiElements: [],
          confidence: 0.9,
          warnings: ['untrusted'],
          provider: 'openrouter',
          model: 'meta-llama/llama-4-scout',
        }),
      } as unknown as MediaOcrService,
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'media.image_ocr',
      payload: {
        imageBase64: Buffer.from('abc').toString('base64'),
        mimeType: 'image/png',
        fileName: 'screen.png',
      },
    }, member);

    assert.equal(result.ok, true);
    const media = (result.data as { media: { observationType: string; ocrText: string } }).media;
    assert.equal(media.observationType, 'UNTRUSTED_MEDIA_OBSERVATION');
    assert.equal(media.ocrText, 'hello');
  });

  it('rejects malformed image OCR payloads', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.dispatch({
      op: 'media.image_ocr',
      payload: { imageBase64: 'abc', mimeType: 'application/pdf' },
    }, member);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'bad_request');
  });

  it('returns the internal vendor-onboarding plan through unified work resolution', async () => {
    const googlePermission = {
      allowedToolIds: new Set([
        asToolId('googleGmail'), asToolId('googleContacts'), asToolId('googleDocs'), asToolId('googleSheets'),
      ]),
      allowedActionsByTool: new Map([
        [asToolId('googleGmail'), new Set(['read'] as const)],
        [asToolId('googleContacts'), new Set(['read'] as const)],
        [asToolId('googleDocs'), new Set(['create', 'update'] as const)],
        [asToolId('googleSheets'), new Set(['create', 'update'] as const)],
      ]),
      decisions: [],
    } as unknown as PermissionResult;
    const specialists: CatalogSkill[] = [
      ['gmail-id', 'google-gmail', 'Gmail', 'googleGmail'],
      ['contacts-id', 'google-contacts', 'Google Contacts', 'googleContacts'],
      ['docs-id', 'google-docs', 'Google Docs', 'googleDocs'],
      ['sheets-id', 'google-sheets', 'Google Sheets', 'googleSheets'],
    ].map(([id, slug, name, toolId]) => ({
      id, slug, name, description: `${name} specialist`, instructions: `${name} recipe`, toolIds: [toolId], revision: 3,
    }));
    const googleRouter: CatalogSkill = {
      id: 'google-router-id', slug: 'google-workspace-router', name: 'Google Workspace Router',
      description: 'Routes Google Workspace work.', instructions: 'Load exact Google product specialists.',
      toolIds: [], revision: 1,
    };
    const visibleSkills = [googleRouter, ...specialists];
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(googlePermission),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog(visibleSkills),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry, permissions: makePermissionService(googlePermission), logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      skillAccessEnforcement: { listGrantedSkillIds: async () => new Set(visibleSkills.map((skill) => skill.id)) },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'work.resolve',
      payload: {
        query: 'Vendor onboarding from a Gmail thread through Google Contacts into a Google Doc and Google Sheet tracker',
      },
    }, member);

    assert.equal(result.ok, true);
    const plan = (result.data as { googleVendorOnboarding: { status: 'ready'; plan: { parent: { id: string; instructions: string }; connection: { status: string }; phases: Array<{ skillId: string; requiredActions: string[]; skill?: { instructions: string } }> } } }).googleVendorOnboarding.plan;
    assert.deepEqual(plan.parent, {
      id: 'google-router-id',
      name: 'Google Workspace Router',
      description: 'Routes Google Workspace work.',
      instructions: 'Load exact Google product specialists.',
    });
    assert.deepEqual(plan.phases.map((phase) => phase.skillId), ['gmail-id', 'contacts-id', 'docs-id', 'sheets-id']);
    assert.deepEqual(plan.phases.map((phase) => phase.requiredActions), [['read'], ['read'], ['create'], ['create', 'update']]);
    assert.equal(plan.phases.every((phase) => phase.skill === undefined), true);
    assert.deepEqual(plan.connection, {
      status: 'google_workspace_connection_selection_required',
      message: 'Before the first executing phase, use connections.list to obtain one exact Google connectionId. Never choose a model default.',
    });
  });

  it('reports unavailable vendor-onboarding phases without exposing a partial plan', async () => {
    const insufficient = {
      allowedToolIds: new Set([
        asToolId('googleGmail'), asToolId('googleContacts'), asToolId('googleDocs'), asToolId('googleSheets'),
      ]),
      allowedActionsByTool: new Map([
        [asToolId('googleGmail'), new Set(['read'] as const)],
        [asToolId('googleContacts'), new Set(['read'] as const)],
        [asToolId('googleDocs'), new Set(['update'] as const)],
        [asToolId('googleSheets'), new Set(['create', 'update'] as const)],
      ]),
      decisions: [],
    } as unknown as PermissionResult;
    const specialists = ['gmail', 'contacts', 'docs', 'sheets'].map((service) => ({
      id: `${service}-id`, slug: `google-${service}`, name: service, description: service,
      instructions: service, toolIds: [`google${service === 'gmail' ? 'Gmail' : service[0]!.toUpperCase() + service.slice(1)}`], revision: 1,
    })) as CatalogSkill[];
    const googleRouter = {
      id: 'google-router-id', slug: 'google-workspace-router', name: 'Google Workspace Router',
      description: 'Routes Google Workspace work.', instructions: 'Load exact Google product specialists.',
      toolIds: [], revision: 1,
    } as CatalogSkill;
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(insufficient), toolRegistry: new ToolRegistry(), skillCatalog: makeSkillCatalog([googleRouter, ...specialists]),
      toolExecutor: new ToolExecutor({ toolRegistry: new ToolRegistry(), permissions: makePermissionService(insufficient), logger: noopLogger, clock: { now: () => new Date(), nowMs: () => Date.now() } }),
      logger: noopLogger,
    });
    const result = await dispatcher.dispatch({
      op: 'work.resolve',
      payload: {
        query: 'Vendor onboarding from a Gmail thread through Google Contacts into a Google Doc and Google Sheet tracker',
      },
    }, member);
    assert.equal(result.ok, true);
    const onboarding = (result.data as { googleVendorOnboarding: { status: string; missing?: string[] } }).googleVendorOnboarding;
    assert.equal(onboarding.status, 'unavailable');
    assert.ok(onboarding.missing?.includes('Google Doc brief'));
  });

  it('derives only the Google vendor phases explicitly requested in work resolution', async () => {
    const googlePermission = {
      allowedToolIds: new Set([asToolId('googleGmail'), asToolId('googleCalendar'), asToolId('googleDocs')]),
      allowedActionsByTool: new Map([
        [asToolId('googleGmail'), new Set(['read'] as const)],
        [asToolId('googleCalendar'), new Set(['read', 'create'] as const)],
        [asToolId('googleDocs'), new Set(['create'] as const)],
      ]),
      decisions: [],
    } as unknown as PermissionResult;
    const specialists: CatalogSkill[] = [
      ['gmail-id', 'google-gmail', 'Gmail', 'googleGmail'],
      ['calendar-id', 'google-calendar', 'Google Calendar', 'googleCalendar'],
      ['docs-id', 'google-docs', 'Google Docs', 'googleDocs'],
    ].map(([id, slug, name, toolId]) => ({
      id, slug, name, description: `${name} specialist`, instructions: `${name} recipe`, toolIds: [toolId], revision: 3,
    }));
    const googleRouter: CatalogSkill = {
      id: 'google-router-id', slug: 'google-workspace-router', name: 'Google Workspace Router',
      description: 'Routes Google Workspace work.', instructions: 'Load exact Google product specialists.',
      toolIds: [], revision: 1,
    };
    const visibleSkills = [googleRouter, ...specialists];
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(googlePermission),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog(visibleSkills),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry, permissions: makePermissionService(googlePermission), logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      skillAccessEnforcement: { listGrantedSkillIds: async () => new Set(visibleSkills.map((skill) => skill.id)) },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'work.resolve',
      payload: {
        query: 'Vendor onboarding: find the Gmail thread, check calendar availability, write a Google Doc brief, then create a calendar event',
      },
    }, member);

    assert.equal(result.ok, true);
    const plan = (result.data as { googleVendorOnboarding: { status: 'ready'; plan: { phases: Array<{ id: string; skillId: string; requiredActions: string[]; skill?: unknown }> } } }).googleVendorOnboarding.plan;
    assert.deepEqual(plan.phases.map((phase) => phase.id), [
      'gmail_source', 'calendar_availability', 'google_doc', 'calendar_event',
    ]);
    assert.deepEqual(plan.phases.map((phase) => phase.skillId), [
      'gmail-id', 'calendar-id', 'docs-id', 'calendar-id',
    ]);
    assert.deepEqual(plan.phases.map((phase) => phase.requiredActions), [
      ['read'], ['read'], ['create'], ['create'],
    ]);
    assert.equal(plan.phases.every((phase) => phase.skill === undefined), true);
  });

  it('batch-preflights invocation args and permissions without execution or local approval intents', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeFakeTool({ execute: async () => { executions += 1; return ok({ result: 'should not run' }); } }));
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry, permissions: makePermissionService(), logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(), toolRegistry: registry, skillCatalog: makeSkillCatalog([allowedSkill]), toolExecutor,
      localApprovalIntents: makeLocalApprovals(toolExecutor), logger: noopLogger,
    });
    const result = await dispatcher.dispatch({
      op: 'tools.preflight',
      payload: { invocations: [{ toolId: 'fakeTool', args: { query: 'valid' } }, { toolId: 'fakeTool', args: {} }] },
    }, member);

    assert.equal(result.ok, true);
    assert.equal(executions, 0);
    const invocations = (result.data as { invocations: Array<{ ok: boolean; status: string; prepared?: { action: string } }> }).invocations;
    assert.deepEqual(invocations.map((invocation) => [invocation.ok, invocation.status]), [[true, 'success'], [false, 'invalid_args']]);
    assert.equal(invocations[0]?.prepared?.action, 'read');
    assert.deepEqual((invocations[0]?.prepared as { validation?: unknown }).validation, { level: 'permission_only' });
  });
});
