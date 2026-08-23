import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuntimeContextLifecycle } from '../../src/application/runtime/runtime-context-lifecycle.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { SkillAccessRepository } from '../../src/infrastructure/persistence/skill-access.repository.ts';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this; },
} as any;

const financeSkill = {
  id: 'skill-finance',
  slug: 'finance-ops-core',
  name: 'Finance Ops Core',
  description: 'Route broad finance questions.',
  instructions: '# Finance Ops\n\nUse verified records.',
  toolIds: ['zohoBooks'],
  aliases: [],
  tags: ['router'],
  revision: 3,
};

function fixture() {
  const calls = {
    memory: 0,
    membership: 0,
    permission: 0,
    grants: 0,
    revision: 0,
    catalogue: 0,
    persona: 0,
    connections: 0,
  };
  let membershipActive = true;
  const deps = {
    prisma: {
      knowledgeResource: {
        findMany: async () => { calls.memory += 1; return []; },
      },
      departmentMembership: {
        findMany: async () => {
          calls.membership += 1;
          return membershipActive ? [{
            departmentId: 'department-1',
            roleId: 'department-role-1',
            department: {
              id: 'department-1',
              name: 'Finance',
              slug: 'finance',
              agentConfig: {
                desktopPersonaPrompt: 'Prefer verified records.',
                isActive: true,
                updatedAt: new Date('2026-08-18T00:00:00.000Z'),
              },
            },
          }] : [];
        },
      },
      adminMembership: {
        findFirst: async () => null,
      },
    } as any,
    permissions: {
      resolve: async () => {
        calls.permission += 1;
        return {
          ok: true,
          value: {
            allowedToolIds: new Set([asToolId('zohoBooks')]),
            allowedActionsByTool: new Map([[asToolId('zohoBooks'), new Set(['read'])]]),
            decisions: [],
          },
        };
      },
    } as any,
    skillCatalog: {
      registryRevision: async () => { calls.revision += 1; return 9; },
      listVisible: async () => { calls.catalogue += 1; return [financeSkill]; },
    } as any,
    skillAccessEnforcement: {
      listGrantedSkillIds: async (_companyId: string, _userId: string, _signal: unknown, scope: any) => {
        calls.grants += 1;
        assert.deepEqual(scope.departmentIds, ['department-1']);
        assert.deepEqual(scope.departmentRoleIds, ['department-role-1']);
        return new Set([financeSkill.id]);
      },
    },
    managerPersonaRuntime: {
      getDepartmentBrief: async () => {
        calls.persona += 1;
        return { version: 'manager:1', prompt: 'Use the current close checklist.' };
      },
    } as any,
    connectionRegistry: {
      listAccessibleZohoConnections: async (input: any) => {
        calls.connections += 1;
        assert.deepEqual(input.memberGrantScope.departmentIds, ['department-1']);
        assert.deepEqual(input.memberGrantScope.departmentRoleIds, ['department-role-1']);
        return { ok: true, value: [] };
      },
    } as any,
    logger: noopLogger,
  };
  return {
    calls,
    lifecycle: new RuntimeContextLifecycle(deps),
    removeMembership: () => { membershipActive = false; },
  };
}

const nativeInput = {
  userId: 'user-1',
  companyId: 'company-1',
  companyRole: 'MEMBER',
  channel: 'lark' as const,
  departmentId: 'department-1',
  capabilityVersion: 3 as const,
};

describe('RuntimeContextLifecycle', () => {
  it('reuses unchanged skill content while every mutable input remains fresh', async () => {
    const { calls, lifecycle } = fixture();
    const first = await lifecycle.load({ ...nativeInput, nativeSkills: {} });
    assert.equal(first.kind, 'ready');
    if (first.kind !== 'ready') return;
    const binding = first.snapshot.nativeSkillBinding;
    assert.match(binding ?? '', /^[a-f0-9]{64}$/);
    assert.ok(first.snapshot.nativeSkillBootstrap);

    const warm = await lifecycle.load({
      ...nativeInput,
      nativeSkills: { requestedBinding: binding! },
    });
    assert.equal(warm.kind, 'ready');
    if (warm.kind !== 'ready') return;
    assert.equal(warm.snapshot.nativeSkillsUnchanged, true);
    assert.equal(warm.snapshot.nativeSkillBootstrap, undefined);
    assert.deepEqual(calls, {
      memory: 2,
      membership: 2,
      permission: 2,
      grants: 2,
      revision: 2,
      catalogue: 1,
      persona: 2,
      connections: 2,
    });
  });

  it('checks membership before accepting a cached native bundle', async () => {
    const { calls, lifecycle, removeMembership } = fixture();
    const first = await lifecycle.load({ ...nativeInput, nativeSkills: {} });
    assert.equal(first.kind, 'ready');
    if (first.kind !== 'ready') return;
    removeMembership();

    const denied = await lifecycle.load({
      ...nativeInput,
      nativeSkills: { requestedBinding: first.snapshot.nativeSkillBinding! },
    });
    assert.deepEqual(denied, {
      kind: 'denied',
      reason: 'department_access_denied',
      message: 'Department access denied',
    });
    assert.equal(calls.membership, 2);
    assert.equal(calls.permission, 1);
    assert.equal(calls.catalogue, 1);
  });

  it('does not resolve department authority when no department was requested', async () => {
    const { calls, lifecycle } = fixture();
    const result = await lifecycle.load({
      userId: 'user-1',
      companyId: 'company-1',
      companyRole: 'MEMBER',
      channel: 'web',
      capabilityVersion: 3,
    });

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.snapshot.departmentId, null);
    assert.equal(calls.memory, 1);
    assert.equal(calls.membership, 0);
    assert.equal(calls.permission, 0);
    assert.equal(calls.catalogue, 0);
  });

  it('carries the trusted shared audience into the surface descriptor', async () => {
    const { lifecycle } = fixture();
    const result = await lifecycle.load({
      ...nativeInput,
      audience: 'shared',
    });

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.snapshot.surface.key, 'lark');
    assert.equal(result.snapshot.surface.audience, 'shared');
    assert.equal(result.snapshot.surface.artifacts, 'none');
  });

  it('loads active memberships once across runtime, skill, and connection grant adapters', async () => {
    const reads = { memberships: 0, admin: 0, skillGrants: 0, connections: 0 };
    const prisma = {
      knowledgeResource: { findMany: async () => [] },
      departmentMembership: {
        findMany: async () => {
          reads.memberships += 1;
          return [{
            departmentId: 'department-1',
            roleId: 'department-role-1',
            department: {
              id: 'department-1',
              name: 'Finance',
              slug: 'finance',
              agentConfig: null,
            },
          }];
        },
      },
      adminMembership: {
        findFirst: async () => { reads.admin += 1; return null; },
      },
      skillAccessGrant: {
        findMany: async () => { reads.skillGrants += 1; return []; },
      },
      integrationConnection: {
        findMany: async () => { reads.connections += 1; return []; },
      },
    } as any;
    const lifecycle = new RuntimeContextLifecycle({
      prisma,
      permissions: {
        resolve: async () => ({
          ok: true,
          value: {
            allowedToolIds: new Set([asToolId('zohoBooks')]),
            allowedActionsByTool: new Map([[asToolId('zohoBooks'), new Set(['read'])]]),
            decisions: [],
          },
        }),
      } as any,
      skillCatalog: {
        registryRevision: async () => 1,
        listVisible: async () => [],
      } as any,
      skillAccessEnforcement: new SkillAccessRepository(prisma),
      managerPersonaRuntime: { getDepartmentBrief: async () => null } as any,
      connectionRegistry: new IntegrationConnectionRepository(prisma, {
        ZOHO_TOKEN_ENCRYPTION_KEY: 'test-key',
      } as any),
      logger: noopLogger,
    });

    const result = await lifecycle.load(nativeInput);

    assert.equal(result.kind, 'ready');
    assert.deepEqual(reads, {
      memberships: 1,
      admin: 1,
      skillGrants: 1,
      connections: 1,
    });
  });
});
