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
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import { createWebSearchTool } from '../../src/application/orchestration/tools/families/web-search.tool.ts';
import { createSkillPublishingTool } from '../../src/application/orchestration/tools/families/skill-publishing.tool.ts';
import { createMemoryPublishingTool } from '../../src/application/orchestration/tools/families/memory-publishing.tool.ts';
import { createMemoryRecallTool } from '../../src/application/orchestration/tools/families/memory-recall.tool.ts';
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

function makeSkillPublishingPrisma() {
  const creates: unknown[] = [];
  const tx = {
    skill: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        creates.push(args.data);
        return {
          id: 'skill-1',
          slug: args.data.slug,
          name: args.data.name,
          scope: args.data.scope,
          departmentId: args.data.departmentId,
          companyId: args.data.companyId,
          summary: args.data.summary,
          markdown: args.data.markdown,
          toolIds: args.data.toolIds,
          tags: args.data.tags,
          status: 'active',
          revision: 1,
          createdBy: args.data.createdBy,
          updatedBy: args.data.updatedBy,
        };
      },
    },
    skillVersion: {
      upsert: async () => ({}),
    },
    skillRegistryRevision: {
      upsert: async () => ({}),
    },
    skillAccessGrant: {
      upsert: async () => ({}),
    },
  };
  const prisma = { ...tx, $transaction: async (fn: (store: typeof tx) => unknown) => fn(tx) };

  return { prisma: prisma as never, creates };
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
    searchVisible: async ({ query, limit }: { query: string; limit: number }) =>
      skills
        .filter((skill) => skill.id !== 'blocked-skill')
        .map((skill) => ({ skill, score: score(skill, query) }))
        .filter((result) => result.score > 0)
        .slice(0, limit),
    getVisible: async ({ skillId }: { skillId: string }) =>
      skills.find((skill) => skill.id === skillId && skill.id !== 'blocked-skill') ?? null,
    getInScope: async ({ skillId }: { skillId: string }) =>
      skills.find((skill) => skill.id === skillId) ?? null,
  } as unknown as SkillCatalogService;
}

function makeLocalApprovals(
  toolExecutor: ToolExecutor,
  clock: Clock = { now: () => new Date(), nowMs: () => Date.now() },
  intentTtlMs?: number,
): LocalApprovalIntentService {
  return new LocalApprovalIntentService({
    toolExecutor,
    repository: new InMemoryApprovalIntentRepository(),
    clock,
    logger: noopLogger,
    ...(intentTtlMs !== undefined ? { intentTtlMs } : {}),
  });
}

function makeMemoryRecallTool(
  mem0: { searchForRecall(input: unknown): Promise<unknown> } | null,
  memberships = [
    { departmentId: 'dept-finance', departmentName: 'Finance' },
    { departmentId: 'dept-sales', departmentName: 'Sales' },
  ],
) {
  return createMemoryRecallTool({
    mem0: mem0 as never,
    departmentRepo: { listActiveMemberships: async () => ({ ok: true as const, value: memberships }) },
  });
}

describe('ToolExecutor', () => {
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

  it('ignores generic department context and recalls across server-derived active memberships without RBAC or HITL', async () => {
    const recalls: unknown[] = [];
    let approvalChecks = 0;
    const registry = new ToolRegistry();
    registry.register(makeMemoryRecallTool({
        searchForRecall: async (input: unknown) => {
          recalls.push(input);
          return {
            facts: [{ scope: 'department' as const, text: 'Finance closes by the fifth business day.', department: { name: 'Finance' } }],
            coverage: { personal: 'searched' as const, departments: { searched: 2, failed: 0 }, company: 'searched' as const },
            status: 'available' as const,
          };
        },
    }));
    const queries: PermissionQuery[] = [];
    const permissions = makeScopedPermissionService(() => makeDeniedPerm(), queries);
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      approvalGate: {
        check: async () => {
          approvalChecks++;
          return { kind: 'pending', approvalId: 'unexpected', message: 'Unexpected approval' };
        },
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member,
      departmentId: 'dept-model-supplied',
      toolId: 'memoryRecall',
      args: { query: 'month end close' },
    });

    assert.equal(result.ok, true);
    assert.equal(approvalChecks, 0);
    assert.deepEqual(queries.map(query => query.departmentId), [undefined]);
    assert.deepEqual(recalls, [{
      query: 'month end close',
      userId: 'user-test',
      companyId: 'co-test',
      departments: [
        { id: 'dept-finance', name: 'Finance' },
        { id: 'dept-sales', name: 'Sales' },
      ],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3000,
    }]);
    assert.deepEqual((result.data as any).result, {
      facts: [{ scope: 'department', text: 'Finance closes by the fifth business day.', department: { name: 'Finance' } }],
      coverage: { personal: 'searched', departments: { searched: 2, failed: 0 }, company: 'searched' },
      status: 'available',
    });
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

  it('reports company and department skill-publishing authority for company admin in a department context', async () => {
    const registry = new ToolRegistry();
    const { prisma } = makeSkillPublishingPrisma();
    registry.register(createSkillPublishingTool({ prisma }));

    const companyPerm = makeAllowedPerm('skillPublishing', ['read', 'create']);
    const departmentPerm: PermissionResult = {
      ...makeDeniedPerm(),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MANAGER' as never,
        zohoReadScope: 'personalized',
      },
    };
    const queries: PermissionQuery[] = [];
    const permissions = makeScopedPermissionService(
      (query) => query.departmentId ? departmentPerm : companyPerm,
      queries,
    );

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member: { ...member, aiRole: 'COMPANY_ADMIN' },
      departmentId: 'dept-1',
      toolId: 'skillPublishing',
      args: { operation: 'check_authority' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual((result as any).data.result, {
      operation: 'check_authority',
      canPublishCompany: true,
      canPublishDepartment: true,
      departmentId: 'dept-1',
    });
    assert.deepEqual(queries.map((query) => query.departmentId ? String(query.departmentId) : null), [
      'dept-1',
      null,
    ]);
  });

  it('uses company permissions for company-scope skill publishing even when a department is active', async () => {
    const registry = new ToolRegistry();
    const { prisma, creates } = makeSkillPublishingPrisma();
    registry.register(createSkillPublishingTool({ prisma }));

    const companyPerm = makeAllowedPerm('skillPublishing', ['read', 'create']);
    const departmentPerm: PermissionResult = {
      ...makeDeniedPerm(),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MEMBER' as never,
        zohoReadScope: 'personalized',
      },
    };
    const queries: PermissionQuery[] = [];
    let approvalChecks = 0;
    const permissions = makeScopedPermissionService(
      (query) => query.departmentId ? departmentPerm : companyPerm,
      queries,
    );

    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      approvalGate: {
        check: async () => {
          approvalChecks++;
          return { kind: 'allowed' };
        },
        completeExecution: async () => true,
        failExecution: async () => true,
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const result = await executor.invoke({
      member: { ...member, aiRole: 'COMPANY_ADMIN' },
      departmentId: 'dept-1',
      toolId: 'skillPublishing',
      args: {
        operation: 'publish',
        scope: 'company',
        name: 'Company Finance Brief',
        markdown: '# Company Finance Brief',
        toolIds: ['webSearch'],
      },
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).data.result.skill.scope, 'global');
    assert.deepEqual(queries.map((query) => query.departmentId ? String(query.departmentId) : null), [null]);
    assert.equal(approvalChecks, 0);
    assert.equal((creates[0] as any).departmentId, null);
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
          result: { messageId: 'gmail-message-1' },
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
    assert.deepEqual((result.data as any).result, { messageId: 'gmail-message-1' });
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
    const prepared = await approvals.prepare({ member, toolId: 'fakeTool', args: { query: 'once' } });
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
      skillCatalog: makeSkillCatalog([allowedSkill, blockedSkill, instructionOnlySkill]),
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

  it('exposes skillPublishing to department managers even without explicit RBAC rows', async () => {
    const registry = new ToolRegistry();
    const { prisma } = makeSkillPublishingPrisma();
    registry.register(createSkillPublishingTool({ prisma }));

    const managerPerm: PermissionResult = {
      ...makeDeniedPerm(),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MANAGER' as never,
        zohoReadScope: 'personalized',
      },
    };
    const permissions = makePermissionService(managerPerm);
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

    const listed = await dispatcher.dispatch({ op: 'tools.list', departmentId: 'dept-1' }, member);
    assert.equal(listed.ok, true);
    const skillPublishingTool = (listed.data as any).tools.find((tool: { id: string }) => tool.id === 'skillPublishing');
    assert.ok(skillPublishingTool);
    assert.deepEqual(skillPublishingTool.allowedActions, ['read', 'create']);

    const capabilities = await dispatcher.dispatch({ op: 'capabilities.get', departmentId: 'dept-1' }, member);
    assert.equal(capabilities.ok, true);
    const capabilityTool = (capabilities.data as any).tools.find((tool: { toolId: string }) => tool.toolId === 'skillPublishing');
    assert.ok(capabilityTool);
    assert.deepEqual(capabilityTool.allowedActions, ['read', 'create']);
  });

  it('returns UI-safe memory authority targets across company and selected-department axes', async () => {
    const registry = new ToolRegistry();
    registry.register(createMemoryPublishingTool({ mem0: { rememberExplicitBatch: async () => {} } }));
    const companyPerm = makeAllowedPerm('memoryPublishing', ['read', 'create']);
    const departmentPerm: PermissionResult = {
      ...makeDeniedPerm(),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MANAGER' as never,
        zohoReadScope: 'personalized',
      },
    };
    const permissions = makeScopedPermissionService((query) =>
      query.departmentId ? departmentPerm : companyPerm);
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor,
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'tools.invoke',
      departmentId: 'dept-1',
      payload: { toolId: 'memoryPublishing', args: { operation: 'check_authority' } },
    }, { ...member, aiRole: 'COMPANY_ADMIN' });

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as any).result, {
      operation: 'check_authority',
      availability: 'available',
      targets: [
        { scope: 'personal', label: 'Personal' },
        { scope: 'department', label: 'Finance', departmentId: 'dept-1' },
        { scope: 'company', label: 'Company' },
      ],
      scopeOutcomes: [
        { scope: 'personal', status: 'allowed' },
        { scope: 'department', status: 'allowed' },
        { scope: 'company', status: 'allowed' },
      ],
    });
  });

  it('keeps Share Memory discoverable in a department without advertising create authority', async () => {
    const registry = new ToolRegistry();
    registry.register(createMemoryPublishingTool({ mem0: null }));
    const departmentPerm: PermissionResult = {
      ...makeDeniedPerm(),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MEMBER' as never,
        zohoReadScope: 'personalized',
      },
    };
    const permissions = makePermissionService(departmentPerm);
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([{
        id: 'share-memory',
        slug: 'share-memory',
        name: 'Share Memory',
        description: 'Review and publish durable facts.',
        instructions: 'Call divo_memory_review.',
        toolIds: ['memoryPublishing'],
      }]),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      logger: noopLogger,
    });

    const listed = await dispatcher.dispatch({ op: 'tools.list', departmentId: 'dept-1' }, member);
    assert.equal(listed.ok, true);
    const memoryTool = (listed.data as any).tools.find((tool: { id: string }) => tool.id === 'memoryPublishing');
    assert.ok(memoryTool);
    assert.deepEqual(memoryTool.allowedActions, ['read']);

    const skills = await dispatcher.dispatch({ op: 'skills.list', departmentId: 'dept-1' }, member);
    assert.equal(skills.ok, true);
    assert.ok((skills.data as any).skills.some((skill: { id: string }) => skill.id === 'share-memory'));
  });

  it('keeps Share Memory discoverable and reports storage unavailable when Mem0 is disabled', async () => {
    const registry = new ToolRegistry();
    registry.register(createMemoryPublishingTool({ mem0: null }));
    const perm = makeAllowedPerm('memoryPublishing', ['read', 'create']);
    const permissions = makePermissionService(perm);
    const shareMemorySkill: CatalogSkill = {
      id: 'share-memory',
      slug: 'share-memory',
      name: 'Share Memory',
      description: 'Review and publish durable facts.',
      instructions: 'Call divo_memory_review.',
      toolIds: ['memoryPublishing'],
    };
    const skillCatalog = makeSkillCatalog([shareMemorySkill]);
    (skillCatalog as any).listVisible = async ({ permission }: { permission: PermissionResult }) =>
      permission.allowedToolIds.has(asToolId('memoryPublishing')) ? [shareMemorySkill] : [];
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog,
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      logger: noopLogger,
    });

    const tools = await dispatcher.dispatch({ op: 'tools.list' }, member);
    assert.equal(tools.ok, true);
    assert.equal((tools.data as any).tools.some((tool: { id: string }) => tool.id === 'memoryPublishing'), true);

    const skills = await dispatcher.dispatch({ op: 'skills.list' }, member);
    assert.equal(skills.ok, true);
    assert.equal((skills.data as any).skills.some((skill: { id: string }) => skill.id === 'share-memory'), true);

    const authority = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { toolId: 'memoryPublishing', args: { operation: 'check_authority' } },
    }, member);
    assert.equal(authority.ok, true);
    assert.deepEqual((authority.data as any).result, {
      operation: 'check_authority',
      availability: 'storage_unavailable',
      targets: [],
      scopeOutcomes: [],
    });
  });

  it('keeps memory recall discoverable and callable despite disabled configurable read permissions', async () => {
    const recallInputs: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(makeMemoryRecallTool({
        searchForRecall: async (input: unknown) => {
          recallInputs.push(input);
          return {
          facts: [],
          coverage: { personal: 'searched' as const, departments: { searched: 2, failed: 0 }, company: 'searched' as const },
          status: 'available' as const,
          };
        },
    }));
    const permissions = makePermissionService(makeDeniedPerm());
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

    const listed = await dispatcher.dispatch({ op: 'tools.list' }, member);
    assert.equal(listed.ok, true);
    assert.deepEqual((listed.data as any).tools, [
      {
        id: 'memoryRecall',
        family: 'memory',
        description: 'Recall relevant personal, active-department, and company memory from backend-owned scope.',
        allowedActions: ['read'],
      },
    ]);

    const described = await dispatcher.dispatch({
      op: 'tools.list',
      payload: { toolId: 'memoryRecall' },
    }, member);
    assert.equal(described.ok, true);
    const describedTool = (described.data as any).tools[0];
    assert.match(describedTool.parameterDocs, /Results are capped at 12 facts/);
    assert.equal(typeof describedTool.argsSchema, 'object');

    const recalled = await dispatcher.dispatch({
      op: 'tools.invoke',
      // This generic gateway field is model-controlled; it must not narrow or
      // redirect recall away from the server-derived active memberships.
      departmentId: 'dept-model-supplied',
      payload: { toolId: 'memoryRecall', args: { query: 'reporting convention', departmentPreferences: ['Sales'] } },
    }, member);
    assert.equal(recalled.ok, true);
    assert.deepEqual((recalled.data as any).result, {
      facts: [],
      coverage: { personal: 'searched', departments: { searched: 2, failed: 0 }, company: 'searched' },
      status: 'available',
    });
    assert.deepEqual(recallInputs, [{
      query: 'reporting convention',
      userId: 'user-test',
      companyId: 'co-test',
      departments: [
        { id: 'dept-finance', name: 'Finance' },
        { id: 'dept-sales', name: 'Sales' },
      ],
      departmentPreferences: ['Sales'],
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 3000,
    }]);
  });

  it('rechecks memory publish authority on commit and never downgrades a revoked company target', async () => {
    const writes: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(createMemoryPublishingTool({
      mem0: { rememberExplicitBatch: async (input: unknown) => { writes.push(input); } },
    }));
    let resolutions = 0;
    const permissions = makeScopedPermissionService(() => {
      resolutions++;
      return resolutions === 1
        ? makeAllowedPerm('memoryPublishing', ['create'])
        : makeDeniedPerm();
    });
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(toolExecutor),
      logger: noopLogger,
    });
    const admin = { ...member, aiRole: 'COMPANY_ADMIN' };

    const prepared = await dispatcher.dispatch({
      op: 'tools.prepare',
      payload: {
        toolId: 'memoryPublishing',
        args: {
          operation: 'publish',
          scope: 'company',
          facts: ['The fiscal year starts in April.'],
        },
      },
    }, admin);
    assert.equal(prepared.ok, true);

    const committed = await dispatcher.dispatch({
      op: 'tools.commit',
      payload: { intentId: (prepared.data as any).intentId },
    }, admin);

    assert.equal(committed.ok, false);
    assert.equal(committed.status, 'permission_denied');
    assert.equal(resolutions, 2);
    assert.equal(writes.length, 0);
  });

  it('rejects a memory department target that differs from the selected gateway department', async () => {
    const registry = new ToolRegistry();
    registry.register(createMemoryPublishingTool({
      mem0: { rememberExplicitBatch: async () => {} },
    }));
    const permissions = makePermissionService(makeAllowedPerm('memoryPublishing', ['create']));
    const toolExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog([]),
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(toolExecutor),
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'tools.prepare',
      departmentId: 'dept-selected',
      payload: {
        toolId: 'memoryPublishing',
        args: {
          operation: 'publish',
          scope: 'department',
          departmentId: 'dept-other',
          facts: ['Fact.'],
        },
      },
    }, member);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_args');
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
      skills: Array<{ id: string; score: number; toolIds: string[] }>;
    };
    assert.match(data.nextStep, /skills\.get/);
    assert.ok(data.skills.some((s) => s.id === 'allowed-skill' && s.score > 0));
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
      skillCatalog: makeSkillCatalog([]),
      toolExecutor,
      localApprovalIntents: makeLocalApprovals(toolExecutor),
      logger: noopLogger,
    });

    const bypass = await dispatcher.dispatch({
      op: 'tools.invoke',
      payload: { toolId: 'fakeTool', args: { query: 'write' } },
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
      payload: { toolId: 'webSearch', args: { query: 'Divo gateway search', limit: 1 } },
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
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(googlePermission),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog(specialists),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry, permissions: makePermissionService(googlePermission), logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      skillAccessEnforcement: { listGrantedSkillIds: async () => new Set(specialists.map((skill) => skill.id)) },
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'work.resolve',
      payload: {
        query: 'Vendor onboarding from a Gmail thread through Google Contacts into a Google Doc and Google Sheet tracker',
      },
    }, member);

    assert.equal(result.ok, true);
    const plan = (result.data as { googleVendorOnboarding: { status: 'ready'; plan: { connection: { status: string }; phases: Array<{ skillId: string; requiredActions: string[]; skill?: { instructions: string } }> } } }).googleVendorOnboarding.plan;
    assert.deepEqual(plan.phases.map((phase) => phase.skillId), ['gmail-id', 'contacts-id', 'docs-id', 'sheets-id']);
    assert.deepEqual(plan.phases.map((phase) => phase.requiredActions), [['read'], ['read'], ['create'], ['create', 'update']]);
    assert.equal(plan.phases[0]?.skill?.instructions, 'Gmail recipe');
    assert.equal(plan.phases.slice(1).every((phase) => phase.skill === undefined), true);
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
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(insufficient), toolRegistry: new ToolRegistry(), skillCatalog: makeSkillCatalog(specialists),
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
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions: makePermissionService(googlePermission),
      toolRegistry: registry,
      skillCatalog: makeSkillCatalog(specialists),
      toolExecutor: new ToolExecutor({
        toolRegistry: registry, permissions: makePermissionService(googlePermission), logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      skillAccessEnforcement: { listGrantedSkillIds: async () => new Set(specialists.map((skill) => skill.id)) },
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
    assert.equal(plan.phases[0]?.skill !== undefined, true);
    assert.equal(plan.phases.slice(1).every((phase) => phase.skill === undefined), true);
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
