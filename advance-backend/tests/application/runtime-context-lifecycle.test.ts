import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuntimeContextLifecycle } from '../../src/application/runtime/runtime-context-lifecycle.ts';
import { asToolId } from '../../src/shared/ids.ts';

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
        findFirst: async () => {
          calls.membership += 1;
          return membershipActive ? {
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
          } : null;
        },
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
      listGrantedSkillIds: async () => { calls.grants += 1; return new Set([financeSkill.id]); },
    },
    managerPersonaRuntime: {
      getDepartmentBrief: async () => {
        calls.persona += 1;
        return { version: 'manager:1', prompt: 'Use the current close checklist.' };
      },
    } as any,
    connectionRegistry: {
      listAccessibleZohoConnections: async () => {
        calls.connections += 1;
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
});
