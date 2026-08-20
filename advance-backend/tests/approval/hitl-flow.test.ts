/**
 * HITL approval flow — end-to-end chain test.
 *
 * Tests the full gate → card handler → resumer pipeline with mocked
 * infrastructure. No real DB, Lark API, or LLM calls.
 *
 * Scenarios:
 *   1. Gate fires for non-read action, creates approval, sends card
 *   2. Reads are never gated
 *   3. Idempotency — duplicate tool call reuses existing pending approval
 *   4. Manager self-bypass — manager's own actions skip the gate
 *   5. Card handler rejects unauthorized actor
 *   6. Card handler atomically resolves + kicks off resumer
 *   7. Reject flow — resumer re-invokes engine with rejection message
 *   8. Approval grant — second pass through gate is allowed
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, err } from '../../src/shared/result.ts';
import { checkApprovalPolicy, computeArgsHash, computeIdempotencyKey } from '../../src/application/approval/approval-policy.ts';
import { ApprovalGateService } from '../../src/application/approval/approval-gate.service.ts';
import { buildApprovalResolutionCard } from '../../src/application/approval/approval-card-builder.ts';
import { DecisionService } from '../../src/application/decision/decision.service.ts';
import { LarkApprovalCardHandler } from '../../src/infrastructure/channels/lark/lark-approval-card.handler.ts';
import { LarkDecisionCourier } from '../../src/infrastructure/channels/lark/lark-decision.courier.ts';
import type { RuntimeApprovalRow } from '../../src/infrastructure/persistence/runtime-approval.repository.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { RunContext } from '../../src/domain/orchestration/run-context.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { ToolActionGroup } from '../../src/domain/permissions/tool-action-group.ts';
import { asCompanyId, asUserId, asToolId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import { ChannelError } from '../../src/shared/errors.ts';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const COMPANY_ID  = asCompanyId('comp-1');
const REQUESTER   = asUserId('user-anish');
const MANAGER     = asUserId('user-abhishek');
const MANAGER_OID = 'ou_manager_openid';
const REQUESTER_OID = 'ou_requester_openid';
const DEPT_ID     = 'dept-finance';
const CHAT_ID     = 'oc_test_chat';
const TOOL_ID     = asToolId('googleGmail');

function makeManagerActor(overrides: Record<string, string> = {}) {
  return {
    tenantKey: 'tenant-1',
    openId: MANAGER_OID,
    userId: String(MANAGER),
    companyId: String(COMPANY_ID),
    displayName: 'Abhishek Verma',
    ...overrides,
  };
}

function makeManagerMetadata(extra: Record<string, unknown> = {}) {
  return {
    resolvedManagerOpenId: MANAGER_OID,
    resolvedManagerUserId: String(MANAGER),
    tenantKey: 'tenant-1',
    ...extra,
  };
}

function makeLogger(): Logger {
  return {
    debug: () => {},
    info:  () => {},
    warn:  () => {},
    error: () => {},
    child: () => makeLogger(),
  };
}

function makeRunContext(overrides?: Partial<RunContext>): RunContext {
  return {
    companyId:   COMPANY_ID,
    userId:      REQUESTER,
    companyRole: asCompanyRoleSlug('MEMBER'),
    channel:     'lark',
    userExternalId: REQUESTER_OID,
    chatId: CHAT_ID,
    ...overrides,
  };
}

function makePermission(opts: {
  managerApprovalJson?: unknown;
  departmentId?: string;
  departmentName?: string;
} = {}): PermissionResult {
  return {
    allowedToolIds:       new Set([TOOL_ID]),
    allowedActionsByTool: new Map([[TOOL_ID, new Set<ToolActionGroup>(['read', 'send'])]]),
    decisions:            [],
    department: {
      id:   opts.departmentId ?? DEPT_ID,
      name: opts.departmentName ?? 'Finance',
      managerApprovalJson: opts.managerApprovalJson ?? {
        enabled: true,
        requiredActionGroups: ['create', 'update', 'delete', 'send', 'execute'],
        requiredActions: [],
        requiredToolIds: [],
        managerDmAuditToolIds: [],
        managerDmAuditActionGroups: [],
      },
    },
  };
}

// ── In-memory approval repo ──────────────────────────────────────────────────

function makeApprovalRepo() {
  const store = new Map<string, RuntimeApprovalRow>();
  let counter = 0;
  let createLock = Promise.resolve();

  const repo = {
    store,
    create: async (input: any) => {
      counter++;
      const row: RuntimeApprovalRow = {
        id:                  `approval-${counter}`,
        companyId:           input.companyId,
        conversationId:      `conv-${counter}`,
        runId:               `run-${counter}`,
        toolId:              input.toolId,
        actionGroup:         input.actionGroup,
        kind:                input.kind,
        summary:             input.summary,
        payloadJson:         input.payloadJson,
        metadataJson:        input.metadataJson,
        status:              'pending',
        channel:             input.channel,
        requestedBy:         input.requestedBy ?? null,
        approvedBy:          null,
        approvedAt:          null,
        rejectedAt:          null,
        expiresAt:           input.expiresAt ?? null,
        executionResultJson: null,
        idempotencyKey:      input.idempotencyKey ?? null,
        decisionMessageId:   null,
        resolutionReason:    null,
        createdAt:           new Date(),
        updatedAt:           new Date(),
      };
      store.set(row.id, row);
      return ok(row);
    },
    findById: async (id: string) => {
      return ok(store.get(id) ?? null);
    },
    findActiveByIdempotencyKey: async (key: string) => {
      const now = Date.now();
      for (const row of store.values()) {
        const isExpired = row.expiresAt ? row.expiresAt.getTime() <= now : false;
        const isDurableExecutionState = ['executing', 'consumed'].includes(row.status);
        const isDeliveryFailure = (row.executionResultJson as any)?.status === 'approval_delivery_failed';
        const isFailedExecutionBarrier = row.status === 'failed'
          && row.executionResultJson !== null
          && !isDeliveryFailure;
        if (
          row.idempotencyKey === key
          && (
            isDurableExecutionState
            || isFailedExecutionBarrier
            || (['dispatching', 'pending', 'approved', 'rejected'].includes(row.status) && !isExpired)
          )
        ) return ok(row);
      }
      return ok(null);
    },
    setDecisionMessageId: async (id: string, messageId: string) => {
      const row = store.get(id);
      if (row) {
        row.decisionMessageId = messageId;
        row.status = 'pending';
      }
      return ok(undefined);
    },
    markFailed: async (id: string, reason: string) => {
      const row = store.get(id);
      if (row) {
        row.status = 'failed';
        row.resolutionReason = reason;
      }
      return ok(undefined);
    },
    claimApprovedExecution: async (id: string, requestedBy: string) => {
      const row = store.get(id);
      if (!row || row.status !== 'approved' || row.requestedBy !== requestedBy) return ok(null);
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return ok(null);
      row.status = 'executing';
      return ok(row);
    },
    releaseApprovedExecution: async (id: string) => {
      const row = store.get(id);
      if (!row || row.status !== 'executing') return ok(false);
      row.status = 'approved';
      return ok(true);
    },
    completeApprovedExecution: async (id: string, resultJson: unknown) => {
      const row = store.get(id);
      if (row && ['approved', 'executing'].includes(row.status)) {
        row.status = 'consumed';
        row.executionResultJson = resultJson;
        return ok(true);
      }
      return ok(false);
    },
    persistExecutingResult: async (id: string, resultJson: unknown) => {
      const row = store.get(id);
      if (row?.status === 'executing') {
        row.executionResultJson = resultJson;
        return ok(true);
      }
      return ok(false);
    },
    failApprovedExecution: async (id: string, resultJson: unknown) => {
      const row = store.get(id);
      if (row && ['approved', 'executing'].includes(row.status)) {
        row.status = 'failed';
        row.executionResultJson = resultJson;
        return ok(true);
      }
      return ok(false);
    },
    atomicResolve: async (id: string, decision: 'approved' | 'rejected', resolvedBy: string) => {
      const row = store.get(id);
      if (!row || !['dispatching', 'pending'].includes(row.status)) return ok(null);
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return ok(null);
      row.status = decision;
      row.approvedBy = resolvedBy;
      if (decision === 'approved') row.approvedAt = new Date();
      else row.rejectedAt = new Date();
      return ok(row);
    },
    persistAnswer: async (id: string, answer: unknown) => {
      const row = store.get(id);
      if (row) row.responseJson = answer;
      return ok(undefined);
    },
    persistResult: async (id: string, json: unknown) => {
      const row = store.get(id);
      if (row) row.executionResultJson = json;
      return ok(undefined);
    },
  };
  return {
    ...repo,
    createOrReuseActive: async (input: any, options: any = {}) => {
      let release!: () => void;
      const previous = createLock;
      createLock = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        for (const row of store.values()) {
          if (
            row.idempotencyKey === input.idempotencyKey
            && row.status === 'dispatching'
            && (row.executionResultJson as any)?.status === 'approval_delivery_failed'
          ) {
            row.status = 'failed';
          }
        }
        const existing = await repo.findActiveByIdempotencyKey(input.idempotencyKey);
        if (existing.value) {
          return ok({
            approval: existing.value,
            created: false,
            replacedExpired: false,
          });
        }
        for (const key of options.compatibleIdempotencyKeys ?? []) {
          for (const row of store.values()) {
            if (
              row.idempotencyKey === key
              && row.status === 'dispatching'
              && (row.executionResultJson as any)?.status === 'approval_delivery_failed'
              && options.isCompatibleApproval?.(row)
            ) {
              row.status = 'failed';
            }
          }
          const now = Date.now();
          const compatible = [...store.values()].find(row => {
            const isExpired = row.expiresAt ? row.expiresAt.getTime() <= now : false;
            const isDeliveryFailure = (row.executionResultJson as any)?.status === 'approval_delivery_failed';
            const isActive =
              ['executing', 'consumed'].includes(row.status)
              || (row.status === 'failed' && row.executionResultJson !== null && !isDeliveryFailure)
              || (
                ['dispatching', 'pending', 'approved', 'rejected'].includes(row.status)
                && !isExpired
              );
            return row.idempotencyKey === key
              && isActive
              && options.isCompatibleApproval?.(row);
          });
          if (compatible) {
            return ok({
              approval: compatible,
              created: false,
              replacedExpired: false,
            });
          }
        }
        const candidateKeys = [
          input.idempotencyKey,
          ...(options.compatibleIdempotencyKeys ?? []),
        ];
        const replacedExpired = [...store.values()].some(row =>
          typeof row.idempotencyKey === 'string'
          && candidateKeys.includes(row.idempotencyKey)
          && ['dispatching', 'pending', 'approved', 'rejected'].includes(row.status)
          && Boolean(row.expiresAt && row.expiresAt.getTime() <= Date.now())
          && (
            row.idempotencyKey === input.idempotencyKey
            || options.isCompatibleApproval?.(row)
          )
        );
        const created = await repo.create(input);
        if (!created.ok) return created;
        return ok({
          approval: created.value,
          created: true,
          replacedExpired,
        });
      } finally {
        release();
      }
    },
  };
}

// ── Mock Lark adapter ────────────────────────────────────────────────────────

function makeLarkAdapter() {
  const sentCards: Array<{ openId: string; content: string }> = [];
  const updatedMessages: Array<{ messageId: string; content: string }> = [];

  return {
    sentCards,
    updatedMessages,
    sendDirectCard: async (openId: string, content: string) => {
      sentCards.push({ openId, content });
      return ok({ messageId: `msg-card-${sentCards.length}` });
    },
    updateMessageById: async (messageId: string, content: string) => {
      updatedMessages.push({ messageId, content });
      return ok(undefined);
    },
    getStatusMessageId: (_traceId: string) => undefined,
    restoreStatusCoordinator: () => {},
  };
}

function makeGate(
  repo: unknown,
  resolver: unknown,
  lark: unknown,
  logger: Logger,
  options: Record<string, unknown> = {},
  connectionRateLimits?: unknown,
  decisions?: Pick<DecisionService, 'ask'>,
) {
  const decisionService = decisions ?? new DecisionService({
    approvals: repo as never,
    resumer: { resume: async () => {} } as never,
    logger,
    courier: new LarkDecisionCourier(lark as never, logger),
  });
  return new ApprovalGateService(
    repo as never,
    resolver as never,
    lark as never,
    logger,
    options as never,
    connectionRateLimits as never,
    decisionService,
  );
}

function makeApprovalCardHandler(
  repo: ReturnType<typeof makeApprovalRepo>,
  resumer: { resume: (id: string, decision: string) => Promise<void> },
  lark: ReturnType<typeof makeLarkAdapter>,
  audit?: { record: (input: unknown) => void },
) {
  const decisions = new DecisionService({
    approvals: repo as never,
    resumer: resumer as never,
    logger: makeLogger(),
    ...(audit ? { audit: audit as never } : {}),
    onResolvedCard: async ({ messageId, verdict, byName }) => {
      await lark.updateMessageById(messageId, buildApprovalResolutionCard(verdict, byName, new Date()));
    },
  });
  return new LarkApprovalCardHandler(decisions, makeLogger());
}

// ── Mock resolver ────────────────────────────────────────────────────────────

function makeResolver(manager: { userId: string; larkOpenId: string; displayName: string } | null = {
  userId: String(MANAGER),
  larkOpenId: MANAGER_OID,
  displayName: 'Abhishek Verma',
}) {
  return {
    resolveManager: async () => manager,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkApprovalPolicy (pure)', () => {
  it('returns required=false for read actions', () => {
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'read',
      args: { op: 'list' },
      perm: makePermission(),
      runContext: makeRunContext(),
    });
    assert.equal(result.required, false);
  });

  it('returns required=true for send action when gated', () => {
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send', to: ['test@example.com'], subject: 'Hello' },
      perm: makePermission(),
      runContext: makeRunContext(),
    });
    assert.equal(result.required, true);
  });

  it('returns required=false when approval is disabled', () => {
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm: makePermission({ managerApprovalJson: { enabled: false } }),
      runContext: makeRunContext(),
    });
    assert.equal(result.required, false);
  });

  it('fails closed when approval config is malformed', () => {
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm: makePermission({ managerApprovalJson: { enabled: true, requiredActionGroups: 'send' } }),
      runContext: makeRunContext(),
    });
    assert.equal(result.required, false);
    assert.match(result.misconfigured ?? '', /Invalid manager approval/i);
  });

  it('returns required=false when no department metadata at all', () => {
    const perm: PermissionResult = {
      allowedToolIds:       new Set([TOOL_ID]),
      allowedActionsByTool: new Map([[TOOL_ID, new Set<ToolActionGroup>(['read', 'send'])]]),
      decisions:            [],
    };
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm,
      runContext: makeRunContext(),
    });
    assert.equal(result.required, false);
  });

  it('returns required=false when action is not in requiredActionGroups', () => {
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm: makePermission({
        managerApprovalJson: {
          enabled: true,
          requiredActionGroups: ['create', 'delete'],
          requiredActions: [],
          requiredToolIds: [],
        },
      }),
      runContext: makeRunContext(),
    });
    assert.equal(result.required, false);
  });

  it('skips gate when matching approval grant exists', () => {
    const args = { op: 'send', to: ['x@y.com'], subject: 'Test' };
    const argsHash = computeArgsHash(args);
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args,
      perm: makePermission(),
      runContext: makeRunContext({
        approvalGrants: [{ approvalId: 'grant-1', toolId: String(TOOL_ID), action: 'send', argsHash }],
      }),
    });
    assert.equal(result.required, false);
    assert.ok(result.existingGrant);
    assert.equal(result.existingGrant.approvalId, 'grant-1');
  });

  it('does NOT skip gate when argsHash differs', () => {
    const result = checkApprovalPolicy({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send', to: ['x@y.com'], subject: 'Test' },
      perm: makePermission(),
      runContext: makeRunContext({
        approvalGrants: [{ approvalId: 'grant-1', toolId: String(TOOL_ID), action: 'send', argsHash: 'wrong-hash' }],
      }),
    });
    assert.equal(result.required, true);
  });
});

describe('ApprovalGateService', () => {
  it('uses the exact connection owner for a shared-connection policy, including reads', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const owner = { userId: 'connection-owner', larkOpenId: 'ou_connection_owner', displayName: 'Connection Owner' };
    const resolver = {
      resolveManager: async () => null,
      resolveConnectionOwner: async () => owner,
      resolveCompanyAdmin: async () => null,
    };
    const connectionPolicy = {
      approval: async () => ({ kind: 'required' as const, mode: 'connection_owner' as const, policySource: 'manager_policy' as const }),
    };
    const gate = makeGate(repo as any, resolver as any, lark as any, makeLogger(), {}, connectionPolicy as any);

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'read',
      args: { op: 'list', connectionId: '00000000-0000-4000-8000-000000000001' },
      perm: makePermission({ managerApprovalJson: { enabled: false, requiredActionGroups: [], requiredActions: [], requiredToolIds: [], managerDmAuditToolIds: [], managerDmAuditActionGroups: [] } }),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Read data through the shared connection',
    });

    assert.equal(result.kind, 'pending');
    assert.equal(lark.sentCards[0].openId, owner.larkOpenId);
  });

  it('records a scheduled run\'s delivery restriction on the approval', async () => {
    // The gate is evaluated before the tool runs, so a scheduled run reaches it
    // with its delivery guards untested. This is the only record of that
    // restriction by the time an approval comes back: the session the run acted
    // under is revoked, so nothing can re-derive it later.
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send', to: ['boss@company.com'], subject: 'Q2 Report' },
      perm: makePermission(),
      runContext: makeRunContext({ deliveryMode: 'scheduled_runtime_delivery' }),
      chatId: CHAT_ID,
      argsSummary: 'Send email to boss@company.com: Q2 Report',
    });

    const approval = [...repo.store.values()][0];
    assert.equal(
      (approval.metadataJson as any).deliveryMode,
      'scheduled_runtime_delivery',
    );
  });

  it('sends and tags a cloud Pi approval card for non-read action', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send', to: ['boss@company.com'], subject: 'Q2 Report' },
      perm: makePermission(),
      runContext: makeRunContext({
        replyToMessageId: 'om_request',
        replyInThread: true,
      }),
      chatId: 'gateway:company:comp-1:requester:user-anish:thread:oc_test_chat:run:run-1',
      argsSummary: 'Send email to boss@company.com: Q2 Report',
      execution: {
        version: 1,
        threadId: CHAT_ID,
        runId: 'run-1',
        actionId: 'call-1',
      },
    });

    assert.equal(result.kind, 'pending');
    assert.ok('approvalId' in result && result.approvalId);

    // Approval record created
    assert.equal(repo.store.size, 1);
    const approval = [...repo.store.values()][0];
    assert.equal(approval.toolId, String(TOOL_ID));
    assert.equal(approval.actionGroup, 'send');
    assert.equal(approval.status, 'pending');
    assert.equal((approval.metadataJson as any).approvalOrigin, 'cloud_pi');
    assert.equal((approval.metadataJson as any).sourceChatId, CHAT_ID);
    assert.equal((approval.metadataJson as any).replyToMessageId, 'om_request');
    assert.equal((approval.metadataJson as any).replyInThread, true);
    // An ordinary interactive request carries no delivery restriction.
    assert.equal((approval.metadataJson as any).deliveryMode, null);

    // Card sent to manager
    assert.equal(lark.sentCards.length, 1);
    assert.equal(lark.sentCards[0].openId, MANAGER_OID);
    assert.match(lark.sentCards[0].content, /decision_answer/);
  });

  it('allows read actions without gating', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'read',
      args: { op: 'list' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'List emails',
    });

    assert.equal(result.kind, 'allowed');
    assert.equal(repo.store.size, 0);
    assert.equal(lark.sentCards.length, 0);
  });

  it('returns idempotent pending for duplicate tool call', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Dup' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send email',
    };

    const first = await gate.check(input);
    assert.equal(first.kind, 'pending');
    assert.equal(lark.sentCards.length, 1);

    const second = await gate.check(input);
    assert.equal(second.kind, 'pending');
    // No second card sent — idempotency kicked in
    assert.equal(lark.sentCards.length, 1);
    // Same approval ID returned
    assert.equal(
      (first as any).approvalId,
      (second as any).approvalId,
    );
    assert.equal((second as any).requestState, 'reused');
    assert.equal((second as any).nextAction, 'wait');
  });

  it('keeps identical requests from different users in the same chat isolated', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const base = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Shared group request' },
      perm: makePermission(),
      chatId: CHAT_ID,
      argsSummary: 'Send an email from a shared Lark chat',
    };

    const first = await gate.check({
      ...base,
      runContext: makeRunContext(),
    });
    const second = await gate.check({
      ...base,
      runContext: makeRunContext({
        userId: asUserId('user-second-requester'),
        userExternalId: 'ou_second_requester',
      }),
    });

    assert.equal(first.kind, 'pending');
    assert.equal(second.kind, 'pending');
    assert.notEqual(
      first.kind === 'pending' ? first.approvalId : null,
      second.kind === 'pending' ? second.approvalId : null,
    );
    assert.equal(repo.store.size, 2);
    assert.equal(lark.sentCards.length, 2);
  });

  it('keeps identical requests in different Lark threads isolated and pinned to their source', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const base = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Thread-scoped request' },
      perm: makePermission(),
      argsSummary: 'Send an email from a Lark thread',
    };

    const first = await gate.check({
      ...base,
      chatId: `${CHAT_ID}:thread:om_a`,
      runContext: makeRunContext({
        replyToMessageId: 'om_a_request',
        replyInThread: true,
      }),
    });
    const second = await gate.check({
      ...base,
      chatId: `${CHAT_ID}:thread:om_b`,
      runContext: makeRunContext({
        replyToMessageId: 'om_b_request',
        replyInThread: true,
      }),
    });

    assert.equal(first.kind, 'pending');
    assert.equal(second.kind, 'pending');
    assert.equal(repo.store.size, 2);
    assert.deepEqual(
      [...repo.store.values()].map(row => {
        const metadata = row.metadataJson as Record<string, unknown>;
        return {
          sourceChatId: metadata['sourceChatId'],
          replyToMessageId: metadata['replyToMessageId'],
          scope: metadata['chatId'],
        };
      }),
      [
        {
          sourceChatId: CHAT_ID,
          replyToMessageId: 'om_a_request',
          scope: `${CHAT_ID}:thread:om_a:requester:${REQUESTER}:approval:department_manager:${MANAGER}:department:none`,
        },
        {
          sourceChatId: CHAT_ID,
          replyToMessageId: 'om_b_request',
          scope: `${CHAT_ID}:thread:om_b:requester:${REQUESTER}:approval:department_manager:${MANAGER}:department:none`,
        },
      ],
    );
  });

  it('reuses a compatible pre-upgrade pending approval without sending another card', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const args = { op: 'send', to: ['x@y.com'], subject: 'Rolling upgrade' };
    const argsHash = computeArgsHash(args);
    const legacyKey = computeIdempotencyKey(
      CHAT_ID,
      String(TOOL_ID),
      'send',
      argsHash,
    );

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'Send one email before the approval namespace upgrade',
      payloadJson: { toolId: String(TOOL_ID), action: 'send', args, argsHash },
      metadataJson: {
        requesterId: String(REQUESTER),
        requesterLarkOpenId: REQUESTER_OID,
        departmentId: null,
        approvalOrigin: 'lark',
        statusMessageId: null,
        chatId: CHAT_ID,
        resolvedManagerOpenId: MANAGER_OID,
        resolvedManagerUserId: String(MANAGER),
        resolvedManagerName: 'Abhishek Verma',
        execution: null,
      },
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: legacyKey,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const decision = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args,
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one email after the approval namespace upgrade',
    });

    assert.equal(decision.kind, 'pending');
    assert.equal(decision.kind === 'pending' ? decision.approvalId : null, 'approval-1');
    assert.equal(decision.kind === 'pending' ? decision.requestState : null, 'reused');
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 0);
  });

  it('serializes concurrent identical requests into one approval and one card', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Concurrent' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one concurrent email',
    };

    const decisions = await Promise.all([
      gate.check(input),
      gate.check(input),
      gate.check(input),
    ]);

    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);
    assert.deepEqual(
      decisions.map(decision => decision.kind),
      ['pending', 'pending', 'pending'],
    );
    assert.deepEqual(
      decisions.map(decision => decision.kind === 'pending' ? decision.approvalId : null),
      ['approval-1', 'approval-1', 'approval-1'],
    );
    assert.equal(
      decisions.filter(decision => decision.kind === 'pending' && decision.requestState === 'created').length,
      1,
    );
    assert.equal(
      decisions.filter(decision => decision.kind === 'pending' && decision.requestState === 'reused').length,
      2,
    );
  });

  it('claims an approved exact action once and replays its completed result', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Exactly once' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send exactly one email',
    };

    assert.equal((await gate.check(input)).kind, 'pending');
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);

    const retries = await Promise.all([gate.check(input), gate.check(input)]);
    const allowed = retries.find(decision => decision.kind === 'allowed');
    const waiting = retries.find(decision => decision.kind === 'pending');
    assert.equal(allowed?.kind, 'allowed');
    assert.ok(allowed.executionGrant);
    assert.equal(waiting?.kind, 'pending');
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);

    await gate.completeExecution(allowed.executionGrant, {
      status: 'success',
      result: { messageId: 'gmail-message-1' },
    });
    const replay = await gate.check(input);
    assert.deepEqual(replay, {
      kind: 'completed',
      approvalId: 'approval-1',
      result: { messageId: 'gmail-message-1' },
    });
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);
  });

  it('keeps an executing action as the exactly-once barrier after approval expiry', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Long-running' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one long-running email',
    };

    assert.equal((await gate.check(input)).kind, 'pending');
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);
    assert.equal((await gate.check(input)).kind, 'allowed');
    repo.store.get('approval-1')!.expiresAt = new Date(Date.now() - 1_000);

    const retry = await gate.check(input);

    assert.equal(retry.kind, 'pending');
    assert.equal(retry.kind === 'pending' ? retry.requestState : null, 'reused');
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);
  });

  it('replays a consumed result after approval expiry instead of approving the mutation again', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Durable replay' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one durably replayed email',
    };

    assert.equal((await gate.check(input)).kind, 'pending');
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);
    const allowed = await gate.check(input);
    assert.equal(allowed.kind, 'allowed');
    assert.ok(allowed.executionGrant);
    await gate.completeExecution(allowed.executionGrant, {
      status: 'success',
      result: { messageId: 'gmail-message-after-expiry' },
    });
    repo.store.get('approval-1')!.expiresAt = new Date(Date.now() - 1_000);

    const retry = await gate.check(input);

    assert.deepEqual(retry, {
      kind: 'completed',
      approvalId: 'approval-1',
      result: { messageId: 'gmail-message-after-expiry' },
    });
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);
  });

  it('blocks an identical retry when an approved mutation failed with an uncertain provider outcome', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Uncertain send' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one email with uncertain provider outcome',
    };

    assert.equal((await gate.check(input)).kind, 'pending');
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);
    const allowed = await gate.check(input);
    assert.equal(allowed.kind, 'allowed');
    assert.ok(allowed.executionGrant);
    await gate.failExecution(allowed.executionGrant, {
      status: 'tool_error',
      message: 'Provider timed out after accepting the request.',
    });
    repo.store.get('approval-1')!.expiresAt = new Date(Date.now() - 1_000);

    const retry = await gate.check(input);

    assert.equal(retry.kind, 'execution_failed');
    assert.match(retry.kind === 'execution_failed' ? retry.message : '', /will not run the exact same action again/i);
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);
  });

  it('keeps department-manager approval namespaces separate when one manager owns both departments', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const base = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Department scoped' },
      chatId: CHAT_ID,
      argsSummary: 'Send department-scoped email',
    };

    const finance = await gate.check({
      ...base,
      perm: makePermission({ departmentId: 'dept-finance' }),
      runContext: makeRunContext({ departmentId: 'dept-finance' as any }),
    });
    const operations = await gate.check({
      ...base,
      perm: makePermission({ departmentId: 'dept-operations' }),
      runContext: makeRunContext({ departmentId: 'dept-operations' as any }),
    });

    assert.equal(finance.kind, 'pending');
    assert.equal(operations.kind, 'pending');
    assert.notEqual(
      finance.kind === 'pending' ? finance.approvalId : null,
      operations.kind === 'pending' ? operations.approvalId : null,
    );
    assert.equal(repo.store.size, 2);
    assert.equal(lark.sentCards.length, 2);
  });

  it('creates a fresh approval when the matching pending approval is expired', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const args = { op: 'send', to: ['x@y.com'], subject: 'Expired' };
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args,
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send expired email',
    };
    const first = await gate.check(input);
    assert.equal(first.kind, 'pending');
    repo.store.get('approval-1')!.expiresAt = new Date(Date.now() - 1_000);

    const result = await gate.check(input);

    assert.equal(result.kind, 'pending');
    assert.equal(repo.store.size, 2);
    assert.equal((result as any).approvalId, 'approval-2');
    assert.equal((result as any).requestState, 'replaced_expired');
  });

  it('claims an approved exact-match approval grant and allows execution', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const args = { op: 'send', to: ['x@y.com'], subject: 'Approved' };
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args,
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send approved email',
    };
    const pending = await gate.check(input);
    assert.equal(pending.kind, 'pending');
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);

    const result = await gate.check(input);

    assert.equal(result.kind, 'allowed');
    assert.equal(result.executionGrant?.approvalId, 'approval-1');
    assert.equal(repo.store.get('approval-1')!.status, 'executing');
  });

  it('returns rejected for an exact request after the manager rejects it', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const args = { op: 'send', to: ['x@y.com'], subject: 'Rejected' };
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args,
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send rejected email',
    };
    const pending = await gate.check(input);
    assert.equal(pending.kind, 'pending');
    await repo.atomicResolve('approval-1', 'rejected', MANAGER_OID);

    const result = await gate.check(input);

    assert.equal(result.kind, 'rejected');
    assert.equal((result as any).approvalId, 'approval-1');
    assert.equal((result as any).nextAction, 'change_request');
  });

  it('marks a claimed approval grant consumed after successful execution', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'approved approval',
      payloadJson: {},
      metadataJson: {},
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: 'idem-consume',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    repo.store.get('approval-1')!.status = 'executing';
    await gate.completeExecution({ approvalId: 'approval-1' }, { status: 'success' });

    const approval = repo.store.get('approval-1')!;
    assert.equal(approval.status, 'consumed');
    assert.deepEqual(approval.executionResultJson, { status: 'success' });
  });

  it('replays a durable terminal checkpoint when the consumed transition could not be stored', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args: { op: 'send', to: ['x@y.com'], subject: 'Checkpoint fallback' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one exact email',
    };

    await gate.check(input);
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);
    const claimed = await gate.check(input);
    assert.equal(claimed.kind, 'allowed');
    repo.completeApprovedExecution = async () => ok(false);

    const checkpointed = await gate.completeExecution(
      claimed.kind === 'allowed' ? claimed.executionGrant! : { approvalId: 'missing' },
      { status: 'success', result: { messageId: 'provider-1' } },
    );
    const retry = await gate.check(input);

    assert.equal(checkpointed, true);
    assert.equal(repo.store.get('approval-1')?.status, 'executing');
    assert.equal(retry.kind, 'completed');
    assert.deepEqual(retry.kind === 'completed' ? retry.result : null, { messageId: 'provider-1' });
  });

  it('rejects an approved grant when stored metadata does not match requester', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const args = { op: 'send', to: ['x@y.com'], subject: 'Mismatch' };
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as ToolActionGroup,
      args,
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send mismatched email',
    };
    const pending = await gate.check(input);
    assert.equal(pending.kind, 'pending');
    (repo.store.get('approval-1')!.metadataJson as Record<string, unknown>)['requesterId'] = 'different-user';
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);

    const result = await gate.check(input);

    assert.equal(result.kind, 'misconfigured');
    assert.match(result.message, /different requester|no longer matches/i);
    assert.equal(repo.store.get('approval-1')!.status, 'approved');
  });

  it('returns misconfigured when approval config is malformed', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm: makePermission({ managerApprovalJson: { enabled: true, requiredActionGroups: 'send' } }),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Malformed config',
    });

    assert.equal(result.kind, 'misconfigured');
    assert.equal(repo.store.size, 0);
    assert.equal(lark.sentCards.length, 0);
  });

  it('blocks exact retry when approval-card delivery loses provider confirmation', async () => {
    const repo = makeApprovalRepo();
    let deliveryAttempts = 0;
    const lark = {
      ...makeLarkAdapter(),
      sendDirectCard: async () => {
        deliveryAttempts += 1;
        return err(new Error('timeout after request body was sent'));
      },
    };
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as const,
      args: { op: 'send' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send email',
    };

    const first = await gate.check(input);
    repo.store.get('approval-1')!.status = 'dispatching';
    const retry = await gate.check(input);

    assert.equal(first.kind, 'misconfigured');
    assert.equal(retry.kind, 'misconfigured');
    assert.match(retry.kind === 'misconfigured' ? retry.message : '', /lost confirmation/i);
    const approval = repo.store.get('approval-1')!;
    assert.equal(approval.status, 'dispatching');
    assert.deepEqual(approval.executionResultJson, {
      status: 'approval_delivery_unknown',
      message: 'timeout after request body was sent',
      nextAction: 'contact_administrator',
      retry: 'do_not_retry',
    });
    assert.equal(deliveryAttempts, 1);
  });

  it('safely replaces a definitely rejected card when the initial failure status write was lost', async () => {
    const repo = makeApprovalRepo();
    repo.markFailed = async () => err(new Error('approval status write failed'));
    let deliveryAttempts = 0;
    const lark = {
      ...makeLarkAdapter(),
      sendDirectCard: async () => {
        deliveryAttempts += 1;
        return deliveryAttempts === 1
          ? err(new ChannelError({
              channel: 'lark',
              stage: 'send_status',
              reason: 'upstream_4xx',
              message: 'lark rejected the recipient',
            }))
          : ok({ messageId: 'msg-card-2' });
      },
    };
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as const,
      args: { op: 'send', subject: 'Delivery checkpoint' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one exact email',
    };

    const first = await gate.check(input);
    // The production repository creates this row as dispatching. The shared
    // in-memory fixture defaults direct seed rows to pending for card tests.
    repo.store.get('approval-1')!.status = 'dispatching';
    const retry = await gate.check(input);

    assert.equal(first.kind, 'misconfigured');
    assert.equal(retry.kind, 'pending');
    assert.equal(repo.store.get('approval-1')?.status, 'failed');
    assert.deepEqual(repo.store.get('approval-1')?.executionResultJson, {
      status: 'approval_delivery_failed',
      message: 'lark rejected the recipient',
      nextAction: 'retry_exact',
      retry: 'retry_exact',
    });
    assert.equal(repo.store.get('approval-2')?.status, 'pending');
    assert.equal(deliveryAttempts, 2);
    assert.equal(repo.store.size, 2);
  });

  it('keeps the delivered approval actionable and sends no duplicate when delivery persistence fails', async () => {
    const repo = makeApprovalRepo();
    repo.setDecisionMessageId = async () => err(new Error('database write failed'));
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());
    const input = {
      toolId: String(TOOL_ID),
      action: 'send' as const,
      args: { op: 'send', subject: 'One exact card' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'Send one exact email',
    };

    const first = await gate.check(input);
    const retry = await gate.check(input);

    assert.equal(first.kind, 'pending');
    assert.equal(first.kind === 'pending' ? first.requestState : null, 'dispatching');
    assert.equal(retry.kind, 'pending');
    assert.equal(lark.sentCards.length, 1);
  });

  it('self-bypass: manager triggering their own action is allowed', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send', to: ['x@y.com'], subject: 'Self' },
      perm: makePermission(),
      runContext: makeRunContext({ userId: MANAGER }),
      chatId: CHAT_ID,
      argsSummary: 'Manager sending own email',
    });

    assert.equal(result.kind, 'allowed');
    assert.equal(repo.store.size, 0);
  });

  it('can disable manager self-bypass for local approval-card smoke tests', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(
      repo as any,
      makeResolver() as any,
      lark as any,
      makeLogger(),
      { disableManagerSelfBypass: true },
    );

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send', to: ['x@y.com'], subject: 'Self approval smoke' },
      perm: makePermission(),
      runContext: makeRunContext({ userId: MANAGER }),
      chatId: CHAT_ID,
      argsSummary: 'Manager sending own email',
    });

    assert.equal(result.kind, 'pending');
    assert.equal(repo.store.size, 1);
    assert.equal(lark.sentCards.length, 1);
    assert.equal(lark.sentCards[0].openId, MANAGER_OID);
  });

  it('returns misconfigured when no manager resolved', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver(null) as any, lark as any, makeLogger());

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm: makePermission(),
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'No manager',
    });

    assert.equal(result.kind, 'misconfigured');
  });

  it('returns misconfigured when no department context', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const gate = makeGate(repo as any, makeResolver() as any, lark as any, makeLogger());

    const permNoDept: PermissionResult = {
      allowedToolIds:       new Set([TOOL_ID]),
      allowedActionsByTool: new Map([[TOOL_ID, new Set<ToolActionGroup>(['read', 'send'])]]),
      decisions:            [],
      // no department field at all
    };

    const result = await gate.check({
      toolId: String(TOOL_ID),
      action: 'send',
      args: { op: 'send' },
      perm: permNoDept,
      runContext: makeRunContext(),
      chatId: CHAT_ID,
      argsSummary: 'No dept',
    });

    // No department metadata → policy says not required → allowed
    assert.equal(result.kind, 'allowed');
  });
});

describe('LarkApprovalCardHandler', () => {
  it('approves a delivered dispatching card without a stored Lark message ID', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    let resumeDecision = '';
    const resumer = {
      resume: async (_id: string, decision: string) => {
        resumeDecision = decision;
      },
    };
    const created = await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'Send email to test@example.com',
      payloadJson: {},
      metadataJson: makeManagerMetadata({
        approvalOrigin: 'lark',
        requesterId: String(REQUESTER),
      }),
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: 'idem-dispatching-approve',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    assert.ok(created.ok);
    created.value.status = 'dispatching';
    created.value.decisionMessageId = null;

    const handler = makeApprovalCardHandler(repo, resumer, lark);
    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: created.value.id, decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID, name: 'Abhishek Verma' },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.equal((result.responseBody as any).toast.type, 'success');
    assert.equal(repo.store.get(created.value.id)?.status, 'approved');
    assert.equal(lark.updatedMessages.length, 0);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(resumeDecision, 'approved');
  });

  it('rejects a delivered dispatching gateway card without auto-resuming it', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    let resumeCalled = false;
    const resumer = { resume: async () => { resumeCalled = true; } };
    const created = await repo.create({
      chatId: 'gateway:session-1',
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'Send governed email',
      payloadJson: {},
      metadataJson: makeManagerMetadata({
        approvalOrigin: 'gateway',
        chatId: 'gateway:session-1',
        requesterId: String(REQUESTER),
      }),
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: 'idem-dispatching-reject',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    assert.ok(created.ok);
    created.value.status = 'dispatching';
    created.value.decisionMessageId = null;

    const handler = makeApprovalCardHandler(repo, resumer, lark);
    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: created.value.id, decision: 'rejected' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID, name: 'Abhishek Verma' },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.equal((result.responseBody as any).toast.type, 'success');
    assert.equal(repo.store.get(created.value.id)?.status, 'rejected');
    assert.equal(lark.updatedMessages.length, 0);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(resumeCalled, false);
  });

  it('auto-resumes a cloud Pi approval while keeping its gateway scope internal', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    let resumeDecision = '';
    const resumer = {
      resume: async (_id: string, decision: string) => {
        resumeDecision = decision;
      },
    };
    const created = await repo.create({
      chatId: 'gateway:company:comp-1:requester:user-anish:thread:oc_test_chat:run:run-1',
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'Send governed email',
      payloadJson: {},
      metadataJson: makeManagerMetadata({
        approvalOrigin: 'cloud_pi',
        chatId: 'gateway:company:comp-1:requester:user-anish:thread:oc_test_chat:run:run-1',
        sourceChatId: CHAT_ID,
        requesterId: String(REQUESTER),
        requesterLarkOpenId: REQUESTER_OID,
        execution: {
          version: 1,
          threadId: CHAT_ID,
          runId: 'run-1',
          actionId: 'call-1',
        },
      }),
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: 'idem-cloud-pi-approve',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    assert.ok(created.ok);
    created.value.status = 'dispatching';

    const handler = makeApprovalCardHandler(repo, resumer, lark);
    const result = await handler.handle({
      action: {
        value: {
          kind: 'approval_decision',
          approvalId: created.value.id,
          decision: 'approved',
        },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID, name: 'Abhishek Verma' },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.match((result.responseBody as any).toast.content, /will now be executed/i);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(resumeDecision, 'approved');
  });

  it('resolves approval and returns toast on approve click', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    let resumeCalled = false;
    let resumeDecision = '';
    const resumer = {
      resume: async (_id: string, decision: string) => {
        resumeCalled = true;
        resumeDecision = decision;
      },
    };

    // Pre-create a pending approval
    const createResult = await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'Send email to test@example.com',
      payloadJson: {},
      metadataJson: makeManagerMetadata({ requesterId: String(REQUESTER) }),
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: 'idem-1',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    const approval = createResult.ok ? createResult.value : null;
    assert.ok(approval);
    await repo.setDecisionMessageId(approval.id, 'msg-decision-1');

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: approval.id, decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID, name: 'Abhishek Verma' },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.ok(result.responseBody);
    assert.equal((result.responseBody as any).toast.type, 'success');
    assert.equal((result.responseBody as any).card.type, 'raw');
    assert.match((result.responseBody as any).card.data.header.title.content, /Approved by Abhishek Verma/);
    assert.equal(
      JSON.stringify((result.responseBody as any).card.data).includes('approval_decision'),
      false,
      'the callback card has no actionable approval buttons',
    );

    // Approval atomically resolved
    const resolved = repo.store.get(approval.id)!;
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.approvedBy, String(MANAGER));

    // The callback response updates immediately; PATCH remains async recovery.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lark.updatedMessages.length, 1);
    assert.equal(lark.updatedMessages[0].messageId, 'msg-decision-1');

    // Resumer kicked off
    await new Promise(r => setTimeout(r, 50));
    assert.equal(resumeCalled, true);
    assert.equal(resumeDecision, 'approved');
  });

  it('returns the legacy callback while card recovery is still pending', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    lark.updateMessageById = async () => new Promise<never>(() => {});
    const resumer = { resume: async () => {} };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-callback-deadline',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    await repo.setDecisionMessageId('approval-1', 'msg-pending-recovery');

    const handler = makeApprovalCardHandler(repo, resumer, lark);
    const result = await Promise.race([
      handler.handle({
        action: {
          value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
          tag: 'button',
        },
        operator: { open_id: MANAGER_OID },
      }, makeManagerActor()),
      new Promise<'timed_out'>(resolve => setTimeout(() => resolve('timed_out'), 50)),
    ]);

    assert.notEqual(result, 'timed_out');
    assert.equal((result as any).handled, true);
    assert.equal(repo.store.get('approval-1')!.status, 'approved');
  });

  it('rejects unauthorized actor', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-2',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: 'ou_unauthorized_person' },
    }, makeManagerActor({ openId: 'ou_unauthorized_person' }));

    assert.equal(result.handled, true);
    assert.equal((result.responseBody as any).toast.type, 'error');
    assert.ok((result.responseBody as any).toast.content.includes('not authorized'));

    // Approval NOT resolved
    const approval = repo.store.get('approval-1')!;
    assert.equal(approval.status, 'pending');
  });

  it('rejects actor identities from another user, company, or tenant', async () => {
    const mismatches = [
      { userId: 'user-someone-else' },
      { companyId: 'comp-other' },
      { tenantKey: 'tenant-other' },
    ];

    for (const mismatch of mismatches) {
      const repo = makeApprovalRepo();
      await repo.create({
        chatId: CHAT_ID,
        companyId: String(COMPANY_ID),
        toolId: String(TOOL_ID),
        actionGroup: 'send',
        kind: 'tool_action',
        summary: 'test',
        payloadJson: {},
        metadataJson: makeManagerMetadata(),
        channel: 'lark',
        idempotencyKey: `idem-scope-${Object.keys(mismatch)[0]}`,
        expiresAt: new Date(Date.now() + 86400_000),
      });
      const handler = makeApprovalCardHandler(
        repo,
        { resume: async () => {} },
        makeLarkAdapter(),
      );

      const result = await handler.handle({
        action: {
          value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
          tag: 'button',
        },
        operator: { open_id: MANAGER_OID },
      }, makeManagerActor(mismatch));

      assert.equal((result.responseBody as any).toast.type, 'error');
      assert.equal(repo.store.get('approval-1')!.status, 'pending');
    }
  });

  it('rejects approval clicks when manager metadata is missing', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: {},
      channel: 'lark',
      idempotencyKey: 'idem-missing-manager',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.equal((result.responseBody as any).toast.type, 'error');
    assert.match((result.responseBody as any).toast.content, /approval metadata/i);
    assert.equal(repo.store.get('approval-1')!.status, 'pending');
  });

  it('rejects approval clicks after approval expiry', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-expired-click',
      expiresAt: new Date(Date.now() - 1_000),
    });

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.equal((result.responseBody as any).toast.type, 'error');
    assert.match((result.responseBody as any).toast.content, /expired/i);
    assert.equal(repo.store.get('approval-1')!.status, 'pending');
  });

  it('returns already resolved for double-click', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-3',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    // Resolve it first
    await repo.atomicResolve('approval-1', 'approved', MANAGER_OID);

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.equal((result.responseBody as any).toast.type, 'info');
    assert.ok((result.responseBody as any).toast.content.includes('Already'));
  });

  it('handles reject decision', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    let resumeDecision = '';
    const resumer = { resume: async (_id: string, d: string) => { resumeDecision = d; } };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-4',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    await repo.setDecisionMessageId('approval-1', 'msg-d-1');

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'rejected' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID, name: 'Abhishek' },
    }, makeManagerActor({ displayName: 'Abhishek' }));

    assert.equal(result.handled, true);

    const resolved = repo.store.get('approval-1')!;
    assert.equal(resolved.status, 'rejected');
    assert.ok(resolved.rejectedAt);

    await new Promise(r => setTimeout(r, 50));
    assert.equal(resumeDecision, 'rejected');
  });

  it('does not auto-resume gateway-origin approvals', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    let resumeCalled = false;
    const resumer = { resume: async () => { resumeCalled = true; } };

    await repo.create({
      chatId: 'gateway:sess-test',
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test gateway approval',
      payloadJson: {},
      metadataJson: makeManagerMetadata({
        approvalOrigin: 'gateway',
        chatId: 'gateway:sess-test',
        requesterId: String(REQUESTER),
      }),
      channel: 'lark',
      requestedBy: String(REQUESTER),
      idempotencyKey: 'idem-gateway',
      expiresAt: new Date(Date.now() + 86400_000),
    });
    await repo.setDecisionMessageId('approval-1', 'msg-gateway-1');

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: MANAGER_OID, name: 'Abhishek' },
    }, makeManagerActor({ displayName: 'Abhishek' }));

    assert.equal(result.handled, true);
    assert.match((result.responseBody as any).toast.content, /retry the exact desktop action/i);
    assert.equal(repo.store.get('approval-1')!.status, 'approved');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lark.updatedMessages.length, 1);

    await new Promise(r => setTimeout(r, 50));
    assert.equal(resumeCalled, false);
  });

  it('parses double-encoded JSON value', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-5',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const handler = makeApprovalCardHandler(repo, resumer, lark);

    // Double-encoded: Lark sometimes re-stringifies the value
    const doubleEncoded = JSON.stringify(
      JSON.stringify({ kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' }),
    );

    const result = await handler.handle({
      action: { value: JSON.parse(doubleEncoded), tag: 'button' },
      operator: { open_id: MANAGER_OID },
    }, makeManagerActor());

    assert.equal(result.handled, true);
    assert.equal(repo.store.get('approval-1')!.status, 'approved');
  });

  it('ignores non-approval card actions', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };
    const handler = makeApprovalCardHandler(repo, resumer, lark);

    const result = await handler.handle({
      action: {
        value: { kind: 'some_other_action', data: 'foo' },
        tag: 'button',
      },
      operator: { open_id: 'ou_anyone' },
    }, makeManagerActor({ openId: 'ou_anyone' }));

    assert.equal(result.handled, false);
  });
});

describe('Idempotency key computation', () => {
  it('same args produce same idempotency key', () => {
    const args = { op: 'send', to: ['x@y.com'], subject: 'Hello' };
    const hash = computeArgsHash(args);
    const k1 = computeIdempotencyKey(CHAT_ID, String(TOOL_ID), 'send', hash);
    const k2 = computeIdempotencyKey(CHAT_ID, String(TOOL_ID), 'send', hash);
    assert.equal(k1, k2);
  });

  it('different args produce different idempotency key', () => {
    const h1 = computeArgsHash({ op: 'send', to: ['a@b.com'] });
    const h2 = computeArgsHash({ op: 'send', to: ['c@d.com'] });
    const k1 = computeIdempotencyKey(CHAT_ID, String(TOOL_ID), 'send', h1);
    const k2 = computeIdempotencyKey(CHAT_ID, String(TOOL_ID), 'send', h2);
    assert.notEqual(k1, k2);
  });

  it('different chat IDs produce different idempotency key', () => {
    const hash = computeArgsHash({ op: 'send' });
    const k1 = computeIdempotencyKey('chat-A', String(TOOL_ID), 'send', hash);
    const k2 = computeIdempotencyKey('chat-B', String(TOOL_ID), 'send', hash);
    assert.notEqual(k1, k2);
  });
});

describe('LarkApprovalCardHandler audit trail', () => {
  it('persists an audit record when someone approves a decision that is not theirs', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };
    const audited: unknown[] = [];

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-audit-1',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const handler = makeApprovalCardHandler(
      repo,
      resumer,
      lark,
      { record: (input: unknown) => { audited.push(input); } },
    );

    const result = await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: 'ou_intruder' },
    }, makeManagerActor({ openId: 'ou_intruder' }));

    assert.equal(result.handled, true);
    assert.equal(repo.store.get('approval-1')!.status, 'pending', 'nothing was approved');

    // Rejecting the click is not enough on its own: an attempt to approve
    // someone else's decision has to survive somewhere an admin can query,
    // not only in process telemetry that rotates away.
    assert.equal(audited.length, 1, 'the attempt was recorded');
    const entry = audited[0] as any;
    assert.equal(entry.action, 'decision.unauthorized_actor');
    assert.equal(entry.outcome, 'failure');
    assert.equal(entry.companyId, String(COMPANY_ID), 'filed under the approval"s company');
    assert.equal(entry.metadata.decisionId, 'approval-1');
    assert.equal(entry.metadata.actorOpenId, 'ou_intruder');
    assert.ok(entry.metadata.expectedApproverOpenId, 'records who it should have been');
  });

  it('records the settled decision through the Decision module', async () => {
    const repo = makeApprovalRepo();
    const lark = makeLarkAdapter();
    const resumer = { resume: async () => {} };
    const audited: unknown[] = [];

    await repo.create({
      chatId: CHAT_ID,
      companyId: String(COMPANY_ID),
      toolId: String(TOOL_ID),
      actionGroup: 'send',
      kind: 'tool_action',
      summary: 'test',
      payloadJson: {},
      metadataJson: makeManagerMetadata(),
      channel: 'lark',
      idempotencyKey: 'idem-audit-2',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const handler = makeApprovalCardHandler(
      repo,
      resumer,
      lark,
      { record: (input: unknown) => { audited.push(input); } },
    );

    await handler.handle({
      action: {
        value: { kind: 'approval_decision', approvalId: 'approval-1', decision: 'approved' },
        tag: 'button',
      },
      operator: { open_id: 'ou_manager' },
    }, makeManagerActor());

    assert.equal(audited.length, 1);
    assert.equal((audited[0] as any).action, 'decision.settled');
    assert.equal((audited[0] as any).metadata.decisionId, 'approval-1');
  });
});

describe('an approval requested through the gateway and executed through the runtime', () => {
  /**
   * The gateway scopes an approval by run — `gateway:company:...:run:...` — so
   * one manager decision cannot be spent by another turn. The runtime executor
   * that runs the *approved* action scopes by the plain conversation id
   * instead. Both are reached through the same tool executor, in that order,
   * for every Lark request, and the exact-match check compares the stored
   * scope.
   *
   * So an approval requested through the gateway could never be claimed. On
   * prod this produced three approval rows in sixty-five seconds for one mail
   * rule, identical in every field including `argsHash` and `runId` and
   * differing only in that scope: the manager approved, execution asked the
   * gate again, the gate found nothing under its own name and opened a second
   * request — which the requester was told to wait for, forever.
   */
  const EXECUTION = {
    version: 1 as const,
    threadId: 'oc_test_chat:session:sess-1',
    runId: 'run-abc-123',
    actionId: 'call_1',
  };
  const GATEWAY_CHAT_ID = [
    'gateway', 'company', String(COMPANY_ID),
    'requester', String(REQUESTER),
    'thread', EXECUTION.threadId,
    'run', EXECUTION.runId,
  ].join(':');

  const request = (chatId: string) => ({
    toolId: String(TOOL_ID),
    action: 'send' as const,
    args: { op: 'send', to: ['boss@company.com'], subject: 'Q2 Report' },
    perm: makePermission(),
    runContext: makeRunContext(),
    chatId,
    argsSummary: 'Send email to boss@company.com: Q2 Report',
    execution: EXECUTION,
  });

  it('is claimed by the execution that follows it, not asked for a second time', async () => {
    const repo = makeApprovalRepo();
    const gate = makeGate(
      repo as any, makeResolver() as any, makeLarkAdapter() as any, makeLogger(),
    );

    const asked = await gate.check(request(GATEWAY_CHAT_ID));
    assert.equal(asked.kind, 'pending');

    // The manager approves.
    const approval = [...repo.store.values()][0]!;
    approval.status = 'approved';
    approval.approvedBy = String(MANAGER);
    approval.approvedAt = new Date();

    // The approved action now runs, through the call site that holds the plain
    // conversation id rather than the run-scoped one.
    const claimed = await gate.check(request(CHAT_ID));

    assert.equal(claimed.kind, 'allowed', `expected the grant to be claimed, got ${claimed.kind}`);
    assert.equal(
      repo.store.size, 1,
      'the execution opened a second approval instead of claiming the first',
    );
  });

  it('still refuses a grant from a different run', async () => {
    // The run scope is what stops one manager decision being spent by an
    // unrelated turn. Widening the search must not cost that.
    const repo = makeApprovalRepo();
    const gate = makeGate(
      repo as any, makeResolver() as any, makeLarkAdapter() as any, makeLogger(),
    );

    await gate.check(request(GATEWAY_CHAT_ID));
    const approval = [...repo.store.values()][0]!;
    approval.status = 'approved';
    approval.approvedBy = String(MANAGER);
    approval.approvedAt = new Date();

    const otherRun = await gate.check({
      ...request(CHAT_ID),
      execution: { ...EXECUTION, runId: 'run-somebody-else' },
    });

    assert.notEqual(otherRun.kind, 'allowed');
    assert.equal(repo.store.size, 2, 'a different run should open its own request');
  });
});
