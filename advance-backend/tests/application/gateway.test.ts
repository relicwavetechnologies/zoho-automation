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
  const prisma = {
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
          toolIds: args.data.toolIds,
          status: 'active',
        };
      },
    },
  };

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
        completeExecution: async () => {},
        failExecution: async () => {},
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
        completeExecution: async () => {},
        failExecution: async () => {},
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
      },
      failExecution: async () => {},
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

  it('returns deterministic Gmail and Zoho presentation payloads for the UI registry', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...makeFakeTool(),
      id: asToolId('googleGmail'),
      family: 'google',
      actionGroups: new Set(['send']),
      argsSchema: z.object({
        connectionId: z.string(),
        op: z.literal('send'),
        to: z.array(z.string()),
        subject: z.string(),
        body: z.string(),
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
        op: 'send',
        to: ['maya@example.com'],
        subject: 'Q3 rollout',
        body: 'Hi Maya',
      },
    });
    assert.deepEqual((gmail.data as any).presentation, {
      kind: 'gmail.send',
      provider: 'gmail',
      title: 'Review email before sending',
      action: 'send',
      operation: 'send',
      details: {
        connectionId: 'google-1',
        to: ['maya@example.com'],
        subject: 'Q3 rollout',
        body: 'Hi Maya',
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
        completeExecution: async () => {},
        failExecution: async () => {},
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
  };
  const blockedSkill: CatalogSkill = {
    id: 'blocked-skill',
    slug: 'blocked-skill',
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
      skillCatalog: makeSkillCatalog([allowedSkill, blockedSkill]),
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

  it('blocks direct write invocation and executes it only through prepare then commit', async () => {
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
    assert.equal(executions, 0);

    const prepared = await dispatcher.dispatch({
      op: 'tools.prepare',
      payload: { toolId: 'fakeTool', args: { query: 'write' } },
    }, member);
    assert.equal(prepared.ok, true);
    assert.equal((prepared.data as any).requiresApproval, true);

    const committed = await dispatcher.dispatch({
      op: 'tools.commit',
      payload: { intentId: (prepared.data as any).intentId },
    }, member);
    assert.equal(committed.ok, true);
    assert.equal(executions, 1);
  });

  it('exposes and invokes webSearch through the backend gateway when RBAC allows it', async () => {
    const registry = new ToolRegistry();
    registry.register(createWebSearchTool({
      client: {
        search: async (query: string, limit = 5) => [{
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
});
