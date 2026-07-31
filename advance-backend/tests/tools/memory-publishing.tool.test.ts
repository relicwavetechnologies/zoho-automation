import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryPublishingTool,
  MEMORY_PUBLISHING_MAX_FACT_CHARS,
  MEMORY_PUBLISHING_MAX_FACTS,
} from '../../src/application/tools/families/memory-publishing.tool.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import { asDepartmentId, asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

function makeMem0() {
  const calls: unknown[] = [];
  return {
    calls,
    mem0: {
      rememberExplicitBatch: async (input: unknown) => { calls.push(input); },
    },
  };
}

function departmentPerm(options: { manager?: boolean; explicitCreate?: boolean } = {}): PermissionResult {
  const base = options.explicitCreate
    ? makeAllowedPerm('memoryPublishing', ['create'])
    : makeDeniedPerm();
  return {
    ...base,
    decisions: options.explicitCreate ? [{
      toolId: asToolId('memoryPublishing'),
      actionGroup: 'create',
      allowed: true,
      source: 'department_user_override',
    }] : [],
    department: {
      id: asDepartmentId('dept-1'),
      name: 'Finance',
      roleSlug: (options.manager ? 'MANAGER' : 'MEMBER') as never,
      zohoReadScope: 'personalized',
    },
  };
}

describe('memoryPublishing tool', () => {
  it('reports storage unavailable explicitly before offering authority targets', async () => {
    const tool = createMemoryPublishingTool({ mem0: null });
    const result = await tool.execute({ operation: 'check_authority' }, makeCtx());

    assert.equal(result.ok, true);
    assert.deepEqual((result as any).value, {
      operation: 'check_authority',
      availability: 'storage_unavailable',
      targets: [],
      scopeOutcomes: [],
    });
  });

  it('enforces bounded fact batches', () => {
    const tool = createMemoryPublishingTool({ mem0: null });
    const valid = tool.argsSchema.safeParse({
      operation: 'publish',
      scope: 'personal',
      facts: Array.from({ length: MEMORY_PUBLISHING_MAX_FACTS }, () => 'x'.repeat(MEMORY_PUBLISHING_MAX_FACT_CHARS)),
    });
    const tooMany = tool.argsSchema.safeParse({
      operation: 'publish',
      scope: 'personal',
      facts: Array.from({ length: MEMORY_PUBLISHING_MAX_FACTS + 1 }, () => 'fact'),
    });
    const tooLong = tool.argsSchema.safeParse({
      operation: 'publish',
      scope: 'personal',
      facts: ['x'.repeat(MEMORY_PUBLISHING_MAX_FACT_CHARS + 1)],
    });

    assert.equal(valid.success, true);
    assert.equal(tooMany.success, false);
    assert.equal(tooLong.success, false);
    assert.equal(tool.argsSchema.safeParse({
      operation: 'publish',
      scope: 'department',
      facts: ['fact'],
    }).success, false);
    assert.equal(tool.argsSchema.safeParse({
      operation: 'publish',
      scope: 'personal',
      departmentId: 'dept-1',
      facts: ['fact'],
    }).success, false);
  });

  it('rejects credential-like facts before Mem0 persistence without echoing the text', async () => {
    const { mem0, calls } = makeMem0();
    const tool = createMemoryPublishingTool({ mem0 });
    const secret = 'password: do-not-store-this';
    const parsed = tool.argsSchema.safeParse({
      operation: 'publish',
      scope: 'personal',
      facts: [secret],
    });

    assert.equal(parsed.success, false);
    if (parsed.success) assert.fail('credential-like fact should be rejected');
    assert.doesNotMatch(parsed.error.message, new RegExp(secret));

    const directResult = await tool.execute({
      operation: 'publish',
      scope: 'personal',
      facts: [secret],
    }, makeCtx());
    assert.equal(directResult.ok, false);
    assert.doesNotMatch((directResult as any).error.message, new RegExp(secret));
    assert.equal(calls.length, 0);
  });

  it('reports only currently permitted UI-safe targets', async () => {
    const { mem0 } = makeMem0();
    const tool = createMemoryPublishingTool({ mem0 });
    const member = await tool.execute(
      { operation: 'check_authority' },
      makeCtx(),
    );
    assert.deepEqual((member as any).value, {
      operation: 'check_authority',
      availability: 'available',
      targets: [
      { scope: 'personal', label: 'Personal' },
      ],
      scopeOutcomes: [
        { scope: 'personal', status: 'allowed' },
        { scope: 'department', status: 'not_selected' },
        { scope: 'company', status: 'not_authorized' },
      ],
    });

    const managerCtx = makeCtx(undefined, undefined, {
      departmentId: asDepartmentId('dept-1'),
    });
    const manager = await tool.execute(
      { operation: 'check_authority' },
      { ...managerCtx, perm: departmentPerm({ manager: true }) },
    );
    assert.deepEqual((manager as any).value, {
      operation: 'check_authority',
      availability: 'available',
      targets: [
      { scope: 'personal', label: 'Personal' },
      { scope: 'department', label: 'Finance', departmentId: 'dept-1' },
      ],
      scopeOutcomes: [
        { scope: 'personal', status: 'allowed' },
        { scope: 'department', status: 'allowed' },
        { scope: 'company', status: 'not_authorized' },
      ],
    });

    const admin = await tool.execute(
      { operation: 'check_authority' },
      makeCtx('memoryPublishing', ['read', 'create'], {
        companyRole: asCompanyRoleSlug('COMPANY_ADMIN'),
      }),
    );
    assert.deepEqual((admin as any).value, {
      operation: 'check_authority',
      availability: 'available',
      targets: [
      { scope: 'personal', label: 'Personal' },
      { scope: 'company', label: 'Company' },
      ],
      scopeOutcomes: [
        { scope: 'personal', status: 'allowed' },
        { scope: 'department', status: 'not_selected' },
        { scope: 'company', status: 'allowed' },
      ],
    });
  });

  it('publishes an exact personal batch through Mem0 without requiring shared-scope RBAC', async () => {
    const { mem0, calls } = makeMem0();
    const tool = createMemoryPublishingTool({ mem0 });
    const args = {
      operation: 'publish' as const,
      scope: 'personal' as const,
      facts: ['Prefers concise weekly reports.', 'Budget reviews happen on Fridays.'],
    };

    assert.equal(tool.permissionCheck(args, makeDeniedPerm()).ok, true);
    const result = await tool.execute(args, makeCtx());

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      facts: args.facts,
      scope: 'user',
      userId: 'user-test',
      companyId: 'co-test',
    }]);
    assert.deepEqual((result as any).value, {
      operation: 'publish',
      scope: 'personal',
      departmentId: null,
      factCount: 2,
    });
  });

  it('allows the current department for managers or explicit department create grants', async () => {
    for (const perm of [departmentPerm({ manager: true }), departmentPerm({ explicitCreate: true })]) {
      const { mem0, calls } = makeMem0();
      const tool = createMemoryPublishingTool({ mem0 });
      const ctx = makeCtx(undefined, undefined, { departmentId: asDepartmentId('dept-1') });
      const args = {
        operation: 'publish' as const,
        scope: 'department' as const,
        departmentId: 'dept-1',
        facts: ['Finance closes books by the fifth business day.'],
      };

      assert.equal(tool.permissionCheck(args, perm).ok, true);
      const result = await tool.execute(args, { ...ctx, perm });
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal((calls[0] as any).scope, 'department');
      assert.equal((calls[0] as any).departmentId, 'dept-1');
    }
  });

  it('rejects an unauthorized department without downgrading to personal memory', async () => {
    const { mem0, calls } = makeMem0();
    const tool = createMemoryPublishingTool({ mem0 });
    const ctx = makeCtx(undefined, undefined, { departmentId: asDepartmentId('dept-1') });
    const args = {
      operation: 'publish' as const,
      scope: 'department' as const,
      departmentId: 'dept-1',
      facts: ['Sensitive shared fact.'],
    };
    const perm = departmentPerm();

    assert.equal(tool.permissionCheck(args, perm).ok, false);
    const result = await tool.execute(args, { ...ctx, perm });
    assert.equal(result.ok, false);
    assert.match((result as any).error.message, /Department memory requires/);
    assert.equal(calls.length, 0);
  });

  it('requires both company create permission and an administrator role', async () => {
    const { mem0, calls } = makeMem0();
    const tool = createMemoryPublishingTool({ mem0 });
    const args = {
      operation: 'publish' as const,
      scope: 'company' as const,
      facts: ['The company fiscal year starts in April.'],
    };

    const member = await tool.execute(args, makeCtx('memoryPublishing', ['create']));
    assert.equal(member.ok, false);

    const adminWithoutGrant = await tool.execute(args, makeCtx(undefined, undefined, {
      companyRole: asCompanyRoleSlug('COMPANY_ADMIN'),
    }));
    assert.equal(adminWithoutGrant.ok, false);

    const admin = await tool.execute(args, makeCtx('memoryPublishing', ['create'], {
      companyRole: asCompanyRoleSlug('COMPANY_ADMIN'),
    }));
    assert.equal(admin.ok, true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).scope, 'company');
  });
});
