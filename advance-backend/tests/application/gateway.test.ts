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
import { createWebSearchTool } from '../../src/application/orchestration/tools/families/web-search.tool.ts';
import { createSkillPublishingTool } from '../../src/application/orchestration/tools/families/skill-publishing.tool.ts';
import type { CatalogSkill, SkillCatalogService } from '../../src/application/skills/skill-catalog.service.ts';
import { ok, err } from '../../src/shared/result.ts';
import { PermissionError, ToolError } from '../../src/shared/errors.ts';
import { asDepartmentId, asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeDeniedPerm, noopLogger } from '../tools/tool-test.helpers.ts';
import type { PermissionService } from '../../src/application/permissions/permission.service.ts';
import type { PermissionQuery, PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { GatewayMemberContext } from '../../src/application/gateway/gateway.types.ts';
import type { MediaOcrService } from '../../src/application/gateway/media-ocr.service.ts';

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
