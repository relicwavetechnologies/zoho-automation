/**
 * A Lark account used to be a precondition for approvals existing at all: every
 * approver lookup ended with "…and a connected Lark connection", returned null
 * otherwise, and the gate turned that null into `misconfigured` — which failed
 * the tool call. A department whose manager works in the desktop app therefore
 * could not use manager approval at all.
 *
 * Authority now comes from the org chart and Lark is one delivery route.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../../src/shared/result.ts';
import { ApprovalGateService } from '../../src/application/approval/approval-gate.service.ts';
import { ApprovalResolverService } from '../../src/application/approval/approval-resolver.service.ts';
import { DecisionService } from '../../src/application/decision/decision.service.ts';
import { LarkDecisionCourier } from '../../src/infrastructure/channels/lark/lark-decision.courier.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { RunContext } from '../../src/domain/orchestration/run-context.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { ToolActionGroup } from '../../src/domain/permissions/tool-action-group.ts';
import { asCompanyId, asUserId, asToolId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';

const COMPANY_ID = asCompanyId('comp-1');
const REQUESTER = asUserId('user-anish');
const TOOL_ID = asToolId('googleGmail');

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child() { return this; } } as never;

function makeRunContext(): RunContext {
  return {
    companyId: COMPANY_ID,
    userId: REQUESTER,
    companyRole: asCompanyRoleSlug('MEMBER'),
    channel: 'desktop',
    chatId: 'desktop-thread-1',
  } as RunContext;
}

function makePermission(): PermissionResult {
  return {
    allowedToolIds: new Set([TOOL_ID]),
    allowedActionsByTool: new Map([[TOOL_ID, new Set<ToolActionGroup>(['read', 'send'])]]),
    decisions: [],
    department: {
      id: 'dept-finance',
      name: 'Finance',
      managerApprovalJson: {
        enabled: true,
        requiredActionGroups: ['send'],
        requiredActions: [],
        requiredToolIds: [],
        managerDmAuditToolIds: [],
        managerDmAuditActionGroups: [],
      },
    },
  } as PermissionResult;
}

function makeRepo() {
  const rows: any[] = [];
  return {
    rows,
    createOrReuseActive: async (input: any) => {
      const now = new Date();
      const approval = {
        id: `approval-${rows.length + 1}`,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        expiresAt: input.expiresAt ?? new Date(now.getTime() + 86_400_000),
        responseJson: null,
        decisionMessageId: null,
        ...input,
      };
      rows.push(approval);
      return ok({ approval, created: true, replacedExpired: false });
    },
    setDecisionMessageId: async () => ok(undefined),
    persistResult: async () => ok(undefined),
    markFailed: async () => ok(undefined),
    findById: async (id: string) => ok(rows.find(row => row.id === id) ?? null),
  };
}

function makeLark() {
  const sent: Array<{ openId: string }> = [];
  return { sent, sendDirectCard: async (openId: string) => { sent.push({ openId }); return ok({ messageId: 'om_1' }); }, getStatusMessageId: () => undefined };
}

const gateWith = (approver: unknown, repo: unknown, lark: unknown) =>
  new ApprovalGateService(
    repo as never,
    { resolveManager: async () => approver } as never,
    lark as never,
    logger,
    {},
    undefined,
    new DecisionService({
      approvals: repo as never,
      resumer: { resume: async () => {} } as never,
      logger,
      courier: new LarkDecisionCourier(lark as never, logger),
    }),
  );

const send = (gate: ApprovalGateService) => gate.check({
  toolId: String(TOOL_ID),
  action: 'send' as ToolActionGroup,
  args: { op: 'send', to: ['boss@example.com'] },
  perm: makePermission(),
  runContext: makeRunContext(),
  chatId: 'desktop-thread-1',
  argsSummary: 'Send email to boss@example.com',
});

describe('approval gate without a Lark address', () => {
  it('keeps the request pending instead of failing the tool call', async () => {
    const repo = makeRepo();
    const lark = makeLark();
    const result = await send(gateWith({ userId: 'user-manager', larkOpenId: null, displayName: 'Priya Nair' }, repo, lark));

    assert.equal(result.kind, 'pending');
    assert.equal(repo.rows.length, 1);
    assert.equal(repo.rows[0].status, 'pending');
    // The message must not promise a card Divo never sent.
    assert.match((result as { message: string }).message, /Priya Nair has an approval request waiting in Divo/);
  });

  it('routes the row to the desktop inbox and sends no card', async () => {
    const repo = makeRepo();
    const lark = makeLark();
    await send(gateWith({ userId: 'user-manager', larkOpenId: null, displayName: 'Priya Nair' }, repo, lark));

    assert.equal(repo.rows[0].channel, 'desktop');
    assert.equal(lark.sent.length, 0);
  });

  it('still cards an approver who has a Lark address', async () => {
    const repo = makeRepo();
    const lark = makeLark();
    const result = await send(gateWith({ userId: 'user-manager', larkOpenId: 'ou_manager', displayName: 'Priya Nair' }, repo, lark));

    assert.equal(result.kind, 'pending');
    assert.equal(repo.rows[0].channel, 'lark');
    assert.deepEqual(lark.sent, [{ openId: 'ou_manager' }]);
  });

  it('still fails closed when there is genuinely nobody to ask', async () => {
    const result = await send(gateWith(null, makeRepo(), makeLark()));
    assert.equal(result.kind, 'misconfigured');
  });
});

// ── resolver ────────────────────────────────────────────────────────────────

function makePrisma(opts: {
  manager?: { userId: string; name: string } | null;
  larkOwners?: string[];
  admins?: Array<{ userId: string; name: string }>;
} = {}) {
  const larkOwners = new Set(opts.larkOwners ?? []);
  return {
    departmentMembership: {
      findFirst: async () => opts.manager === undefined
        ? { userId: 'user-manager', user: { name: 'Priya Nair', email: 'priya@example.com' } }
        : opts.manager && { userId: opts.manager.userId, user: { name: opts.manager.name, email: null } },
    },
    integrationConnection: {
      findFirst: async ({ where }: any) => where.ownerUserId && larkOwners.has(where.ownerUserId)
        ? { externalAccountId: `ou_${where.ownerUserId}` }
        : null,
    },
    adminMembership: {
      findMany: async () => (opts.admins ?? []).map(a => ({ userId: a.userId, user: { name: a.name, email: null } })),
    },
    channelIdentity: { findFirst: async () => null },
  } as never;
}

describe('ApprovalResolverService', () => {
  it('returns a department manager who has never connected Lark', async () => {
    const resolved = await new ApprovalResolverService(makePrisma()).resolveManager('dept-1', 'comp-1');

    assert.equal(resolved?.userId, 'user-manager');
    assert.equal(resolved?.larkOpenId, null);
    assert.equal(resolved?.displayName, 'Priya Nair');
  });

  it('carries the Lark address when the manager does have one', async () => {
    const resolved = await new ApprovalResolverService(makePrisma({ larkOwners: ['user-manager'] })).resolveManager('dept-1', 'comp-1');
    assert.equal(resolved?.larkOpenId, 'ou_user-manager');
  });

  it('prefers a reachable company admin over an unreachable one', async () => {
    const prisma = makePrisma({
      manager: null,
      admins: [{ userId: 'admin-quiet', name: 'Quiet Admin' }, { userId: 'admin-lark', name: 'Lark Admin' }],
      larkOwners: ['admin-lark'],
    });
    const resolved = await new ApprovalResolverService(prisma).resolveManager('dept-1', 'comp-1');

    assert.equal(resolved?.userId, 'admin-lark');
    assert.equal(resolved?.larkOpenId, 'ou_admin-lark');
  });

  it('falls back to an admin with no Lark rather than to nobody', async () => {
    const prisma = makePrisma({ manager: null, admins: [{ userId: 'admin-quiet', name: 'Quiet Admin' }] });
    const resolved = await new ApprovalResolverService(prisma).resolveManager('dept-1', 'comp-1');

    assert.equal(resolved?.userId, 'admin-quiet');
    assert.equal(resolved?.larkOpenId, null);
  });

  it('returns null when the company has no manager and no admin', async () => {
    const resolved = await new ApprovalResolverService(makePrisma({ manager: null })).resolveManager('dept-1', 'comp-1');
    assert.equal(resolved, null);
  });
});
