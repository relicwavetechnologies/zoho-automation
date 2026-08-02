import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGateService } from '../../src/application/approval/approval-gate.service.ts';
import { asCompanyId, asDepartmentId, asUserId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import { makeDeniedPerm } from '../tools/tool-test.helpers.ts';

function gate(resolver: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return new ApprovalGateService(
    {} as never,
    resolver as never,
    {} as never,
    logger() as never,
    options as never,
  );
}

function createArgs(email: string) {
  return {
    operation: 'create',
    name: 'Forward everything',
    match: { from: '@example.com' },
    destination: { type: 'email', email },
  };
}

describe('external mail forward approval', () => {
  it('sends a forward that leaves the company to a human', async () => {
    // A rule ships the whole original message, `{"from":"@example.com"}` is a
    // legal match, and creation goes through the model — so an instruction
    // hidden in an earlier tool result could stand up a silent full-mailbox
    // forward. Nothing used to look at the destination at all.
    let excludedUserId: string | undefined;
    let adminFallback: boolean | undefined;
    const requirement = await gate({
      resolveManager: async (
        _departmentId: string,
        _companyId: string,
        options: { excludeUserId?: string; allowCompanyAdminFallback?: boolean },
      ) => {
        excludedUserId = options.excludeUserId;
        adminFallback = options.allowCompanyAdminFallback;
        return { userId: 'manager-2', larkOpenId: null, displayName: 'Abhishek Verma' };
      },
    }).inspect({
      toolId: 'mailAutomations',
      action: 'create',
      args: createArgs('collector@evil.test'),
      perm: departmentPerm(),
      runContext: runContext(),
    });

    assert.equal(requirement.kind, 'required');
    assert.equal(
      requirement.kind === 'required' ? requirement.authority : null,
      'department_manager',
    );
    assert.equal(excludedUserId, 'user-1');
    // A company admin is an acceptable approver here; the point is that some
    // human other than the requester sees the address.
    assert.equal(adminFallback, true);
  });

  it('leaves a rule inside the company to ordinary policy', async () => {
    let managerLookups = 0;
    const requirement = await gate({
      resolveManager: async () => { managerLookups += 1; return null; },
    }).inspect({
      toolId: 'mailAutomations',
      action: 'create',
      args: createArgs('finance@example.com'),
      perm: departmentPerm(),
      runContext: runContext(),
    });

    assert.equal(managerLookups, 0);
    assert.notEqual(requirement.kind, 'required');
  });

  it('refuses rather than allowing when no approver can be found', async () => {
    // Fails closed on purpose. The alternative is a standing forward to an
    // address nobody in the company chose.
    const requirement = await gate({
      resolveManager: async () => null,
    }).inspect({
      toolId: 'mailAutomations',
      action: 'create',
      args: createArgs('collector@evil.test'),
      perm: departmentPerm(),
      runContext: runContext(),
    });

    assert.equal(requirement.kind, 'misconfigured');
    assert.match(
      requirement.kind === 'misconfigured' ? requirement.message : '',
      /collector@evil\.test/,
    );
  });

  it('refuses when the requester has no address to judge externality against', async () => {
    const requirement = await gate({
      resolveManager: async () => null,
    }).inspect({
      toolId: 'mailAutomations',
      action: 'create',
      args: createArgs('finance@example.com'),
      perm: departmentPerm(),
      runContext: { ...runContext(), requesterEmail: undefined },
    });

    assert.equal(requirement.kind, 'misconfigured');
  });

  it('does not gate operations that establish no destination', async () => {
    let managerLookups = 0;
    const service = gate({
      resolveManager: async () => { managerLookups += 1; return null; },
    });
    for (const args of [
      { operation: 'list' },
      { operation: 'pause', ruleId: 'rule-1' },
      { operation: 'archive', ruleId: 'rule-1' },
      { operation: 'create', name: 'x', match: {}, destination: { type: 'current_lark_chat' } },
    ]) {
      const requirement = await service.inspect({
        toolId: 'mailAutomations',
        action: 'read',
        args,
        perm: departmentPerm(),
        runContext: runContext(),
      });
      assert.notEqual(requirement.kind, 'required');
    }
    assert.equal(managerLookups, 0);
  });
});

function departmentPerm() {
  return {
    ...makeDeniedPerm(),
    department: {
      id: asDepartmentId('dept-1'),
      name: 'Tech Testing',
      roleSlug: 'MEMBER' as never,
      zohoReadScope: 'personalized' as const,
    },
  };
}

function runContext() {
  return {
    companyId: asCompanyId('co-1'),
    userId: asUserId('user-1'),
    companyRole: asCompanyRoleSlug('MEMBER'),
    departmentId: asDepartmentId('dept-1'),
    channel: 'lark' as const,
    chatId: 'chat-1',
    requesterEmail: 'owner@example.com',
  };
}

function logger() {
  const value = {
    child: () => value,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return value;
}
