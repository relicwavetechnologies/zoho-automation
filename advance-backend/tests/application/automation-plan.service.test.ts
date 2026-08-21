import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AutomationPlanService,
  computeAutomationPlanHash,
  parseAutomationPlanPayload,
} from '../../src/application/gateway/automation-plan.service.ts';
import { AutomationPlanExecutor } from '../../src/application/gateway/automation-plan.executor.ts';
import { DecisionService } from '../../src/application/decision/decision.service.ts';
import { LarkDecisionCourier } from '../../src/infrastructure/channels/lark/lark-decision.courier.ts';
import { gatewaySuccess } from '../../src/application/gateway/gateway.types.ts';
import { err, ok } from '../../src/shared/result.ts';
import { ChannelError } from '../../src/shared/errors.ts';
import { sha256CanonicalJson } from '../../src/shared/hash.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';
import type { GatewayMemberContext } from '../../src/application/gateway/gateway.types.ts';
import type { ApprovalRequirement } from '../../src/application/approval/approval-gate.service.ts';
import type { ResolvedManager } from '../../src/application/approval/approval.types.ts';

const member: GatewayMemberContext = {
  companyId: 'company-1',
  userId: 'member-1',
  aiRole: 'MEMBER',
  email: 'member@example.com',
  larkOpenId: 'ou_member',
  sessionId: 'session-1',
};

const skillCatalog = {
  authorizesTool: async () => true,
};
const skillAccessEnforcement = {
  listGrantedSkillIds: async () => new Set(['skill-1']),
};
const skillBindingDeps = {
  skillCatalog: skillCatalog as any,
  skillAccessEnforcement,
};

function createHarness(
  action: 'read' | 'create' = 'create',
  approvalRequirement: ApprovalRequirement | ((input: { args: Record<string, unknown> }) => ApprovalRequirement) = { kind: 'allowed' },
  defaultManager: ResolvedManager | null = { userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' },
  sendCard?: (openId: string, card: string) => Promise<any>,
  persistDelivery?: () => Promise<any>,
  markFailure?: () => Promise<any>,
  authorizesTool: () => Promise<boolean> = async () => true,
) {
  const created: any[] = [];
  const cards: any[] = [];
  let storedApproval: any;
  let approvalRepo: any;
  const larkAdapter = {
    sendDirectCard: async (openId: string, card: string) => {
      cards.push({ openId, card });
      if (sendCard) return sendCard(openId, card);
      return ok({ messageId: 'message-1' });
    },
  };
  const service = new AutomationPlanService({
    toolExecutor: {
      preflight: async ({ toolId, args }: { toolId: string; args: Record<string, unknown> }) =>
        gatewaySuccess({ toolId, action, args, validation: { checked: true } }),
    } as any,
    permissions: {
      resolve: async () => ok({ department: { name: 'Finance' } }),
    } as any,
    skillCatalog: { authorizesTool } as any,
    skillAccessEnforcement,
    approvalRepo: approvalRepo = {
      createOrReuseActive: async (input: any) => {
        if (
          storedApproval?.status === 'dispatching'
          && storedApproval?.executionResultJson?.status === 'approval_delivery_failed'
        ) {
          storedApproval.status = 'failed';
        }
        const isExpired = storedApproval?.expiresAt instanceof Date
          && storedApproval.expiresAt.getTime() <= Date.now();
        const isDurableExecutionState = ['executing', 'consumed'].includes(storedApproval?.status);
        const isDeliveryFailure = storedApproval?.executionResultJson?.status === 'approval_delivery_failed';
        const isDurableAutomationFailure = storedApproval?.status === 'failed'
          && storedApproval?.kind === 'automation_script_plan'
          && storedApproval?.executionResultJson !== null
          && !isDeliveryFailure;
        const isLiveDecisionState = ['dispatching', 'pending', 'approved', 'rejected'].includes(storedApproval?.status)
          && !isExpired;
        if (
          storedApproval?.idempotencyKey === input.idempotencyKey
          && (isDurableExecutionState || isDurableAutomationFailure || isLiveDecisionState)
        ) {
          return ok({
            created: false,
            replacedExpired: false,
            approval: storedApproval,
          });
        }
        const replacedExpired = Boolean(
          storedApproval?.idempotencyKey === input.idempotencyKey
          && ['pending', 'approved', 'rejected'].includes(storedApproval?.status)
          && isExpired,
        );
        created.push(input);
        storedApproval = {
          id: `7c2b4c47-6b8d-4ee4-ae1c-${String(created.length).padStart(12, '0')}`,
          status: 'dispatching',
          companyId: input.companyId,
          conversationId: 'conversation-1',
          runId: 'run-1',
          toolId: input.toolId,
          actionGroup: input.actionGroup,
          summary: input.summary,
          kind: input.kind,
          payloadJson: input.payloadJson,
          metadataJson: input.metadataJson,
          channel: input.channel,
          requestedBy: input.requestedBy,
          expiresAt: input.expiresAt,
          executionResultJson: null,
          responseJson: null,
          idempotencyKey: input.idempotencyKey,
          decisionMessageId: null,
          resolutionReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return ok({
          created: true,
          replacedExpired,
          approval: storedApproval,
        });
      },
      setDecisionMessageId: async (_id: string, messageId: string) => {
        if (persistDelivery) return persistDelivery();
        if (storedApproval) {
          storedApproval.decisionMessageId = messageId;
          storedApproval.status = 'pending';
        }
        return ok(undefined);
      },
      markFailed: async (_id: string, reason: string) => {
        if (markFailure) return markFailure();
        if (storedApproval) {
          storedApproval.status = 'failed';
          storedApproval.resolutionReason = reason;
        }
        return ok(undefined);
      },
      persistResult: async (_id: string, result: unknown) => {
        if (storedApproval) storedApproval.executionResultJson = result;
        return ok(undefined);
      },
    } as any,
    approvalResolver: {
      resolveManager: async () => defaultManager,
    } as any,
    approvalGate: {
      inspect: async (input: { args: Record<string, unknown> }) => typeof approvalRequirement === 'function'
        ? approvalRequirement(input)
        : approvalRequirement,
    } as any,
    decisions: new DecisionService({
      approvals: approvalRepo,
      resumer: { resume: async () => {} } as never,
      logger: noopLogger,
      courier: new LarkDecisionCourier(larkAdapter, noopLogger),
    }),
    logger: noopLogger,
  });
  return {
    service,
    created,
    cards,
    expireStoredApproval: () => {
      if (storedApproval) storedApproval.expiresAt = new Date(Date.now() - 1_000);
    },
    failStoredApproval: (executionResultJson: unknown) => {
      if (storedApproval) {
        storedApproval.status = 'failed';
        storedApproval.executionResultJson = executionResultJson;
      }
    },
  };
}

describe('AutomationPlanService', () => {
  it('treats a stale skill binding as advisory while preserving mutation approval', async () => {
    const { service, created } = createHarness(
      'create',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => false,
    );

    const response = await service.create({
      member,
      departmentId: 'department-1',
      title: 'Create summary sheet',
      summary: 'Create the exact governed output.',
      invocations: [{
        skillId: 'revoked-skill',
        toolId: 'googleSheets',
        args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } },
      }],
    });

    assert.equal(response.status, 'success');
    assert.equal(created.length, 1);
  });

  it('stores only exact preflighted mutations and sends a manager card', async () => {
    const { service, created, cards } = createHarness('create');
    const response = await service.create({
      member,
      departmentId: 'department-1',
      execution: { version: 1, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      title: 'Create daily summary sheet',
      summary: 'Create a Google Sheet with today’s qualified leads.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    });

    assert.equal(response.ok, true);
    assert.equal(created.length, 1);
    assert.equal(cards.length, 1);
    assert.equal(created[0].kind, 'automation_script_plan');
    assert.equal(created[0].metadataJson.approvalOrigin, 'automation');
    // An ordinary interactive batch carries no delivery restriction.
    assert.equal(created[0].metadataJson.deliveryMode, null);
    assert.equal(created[0].payloadJson.invocations[0].toolId, 'googleSheets');
    assert.equal(created[0].payloadJson.invocations[0].action, 'create');
    assert.deepEqual(created[0].payloadJson.approvalSignature, {
      kind: 'required',
      authority: 'department_manager',
      approverUserId: 'manager-1',
      connectionScope: null,
    });
    assert.deepEqual(created[0].payloadJson.invocations[0].approvalSignature, { kind: 'allowed' });
    assert.match(created[0].payloadJson.invocations[0].callSummary, /googleSheets/);
    assert.match(cards[0].card, /decision_answer/);
    assert.match(cards[0].card, /googleSheets/);
  });

  it('records a scheduled run\'s delivery restriction on the batch', async () => {
    // A batch prepared by a scheduled run is approved before any of it executes,
    // so the restriction has to survive to the resume — the session it ran under
    // is revoked long before the manager decides.
    const { service, created } = createHarness('create');

    const response = await service.create({
      member: { ...member, authProvider: 'scheduled_workflow' },
      departmentId: 'department-1',
      execution: { version: 1, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      title: 'Scheduled batch',
      summary: 'Create a Google Sheet with today\u2019s qualified leads.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    });

    assert.equal(response.ok, true);
    assert.equal(created[0].metadataJson.deliveryMode, 'scheduled_runtime_delivery');
  });

  it('reuses one atomic pending batch and sends no duplicate card', async () => {
    const { service, created, cards } = createHarness('create');
    const input = {
      member,
      departmentId: 'department-1',
      execution: { version: 1 as const, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      title: 'Create daily summary sheet',
      summary: 'Create a Google Sheet with today’s qualified leads.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    };

    const first = await service.create(input);
    const second = await service.create(input);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(created.length, 1);
    assert.equal(cards.length, 1);
    assert.equal((second.data as any).idempotent, true);
    assert.equal((second.data as any).planId, (first.data as any).planId);
  });

  it('partitions identical automation plans by exact run and survives session renewal within one run', async () => {
    const { service, created, cards } = createHarness('create');
    const base = {
      member,
      departmentId: 'department-1',
      title: 'Create daily summary sheet',
      summary: 'Create a Google Sheet with today’s qualified leads.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    };
    const execution = { version: 1 as const, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' };

    const first = await service.create({ ...base, execution });
    const renewed = await service.create({
      ...base,
      member: { ...member, sessionId: 'renewed-session' },
      execution,
    });
    const nextRun = await service.create({
      ...base,
      execution: { ...execution, runId: 'run-2' },
    });

    assert.equal(first.ok, true);
    assert.equal(renewed.ok, true);
    assert.equal(nextRun.ok, true);
    assert.equal((renewed.data as any).idempotent, true);
    assert.equal((renewed.data as any).planId, (first.data as any).planId);
    assert.notEqual((nextRun.data as any).planId, (first.data as any).planId);
    assert.equal(created.length, 2);
    assert.equal(cards.length, 2);
    assert.doesNotMatch(created[0].chatId, /session-1|renewed-session/);
    assert.match(created[0].chatId, /run:run-1/);
  });

  it('reports when an expired automation approval was replaced with one fresh request', async () => {
    const { service, created, cards, expireStoredApproval } = createHarness('create');
    const input = {
      member,
      departmentId: 'department-1',
      execution: { version: 1 as const, threadId: 'thread-1', runId: 'run-expired', actionId: 'action-1' },
      title: 'Create daily summary sheet',
      summary: 'Create a Google Sheet with today’s qualified leads.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    };

    const first = await service.create(input);
    expireStoredApproval();
    const replacement = await service.create(input);

    assert.equal(first.ok, true);
    assert.equal(replacement.ok, true);
    assert.equal((first.data as any).requestState, 'created');
    assert.equal((replacement.data as any).requestState, 'replaced_expired');
    assert.equal((replacement.data as any).idempotent, undefined);
    assert.equal(created.length, 2);
    assert.equal(cards.length, 2);
  });

  it('reuses a partially executed failed batch as a durable barrier instead of reapproving it', async () => {
    const { service, created, cards, failStoredApproval } = createHarness('create');
    const input = {
      member,
      departmentId: 'department-1',
      execution: { version: 1 as const, threadId: 'thread-1', runId: 'run-partial', actionId: 'action-1' },
      title: 'Create two reporting sheets',
      summary: 'Create the approved reporting output.',
      invocations: [
        { skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } },
        { skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Pipeline' } } },
      ],
    };

    const first = await service.create(input);
    failStoredApproval({
      status: 'execution_failed',
      completedCalls: 1,
      totalCalls: 2,
      results: [{ index: 0, status: 'completed', result: { spreadsheetId: 'sheet-1' } }],
    });
    const retry = await service.create(input);

    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal((retry.data as any).status, 'failed');
    assert.equal((retry.data as any).idempotent, true);
    assert.equal((retry.data as any).execution.completedCalls, 1);
    assert.equal(created.length, 1);
    assert.equal(cards.length, 1);
  });

  it('keeps an ambiguous approval-card delivery as a durable no-duplicate barrier', async () => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>(resolve => {
      releaseDelivery = resolve;
    });
    const { service, created, cards } = createHarness(
      'create',
      { kind: 'allowed' },
      { userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' },
      async () => {
        await deliveryGate;
        return err(new Error('Lark unavailable'));
      },
    );
    const input = {
      member,
      departmentId: 'department-1',
      execution: { version: 1 as const, threadId: 'thread-1', runId: 'run-delivery', actionId: 'action-1' },
      title: 'Create delivery-tested sheet',
      summary: 'Create one exact governed sheet.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    };

    const creator = service.create(input);
    while (cards.length === 0) await Promise.resolve();
    const concurrent = await service.create(input);

    assert.equal(concurrent.ok, true);
    assert.equal((concurrent.data as any).status, 'delivering_approval_request');
    assert.equal((concurrent.data as any).requestState, 'dispatching');
    assert.equal(cards.length, 1);

    releaseDelivery();
    const failedCreator = await creator;
    assert.equal(failedCreator.ok, false);
    assert.equal(failedCreator.status, 'approval_misconfigured');
    const retry = await service.create(input);
    assert.equal(retry.ok, true);
    assert.equal((retry.data as any).status, 'approval_delivery_unknown');
    assert.equal((retry.data as any).requestState, 'dispatching');
    assert.equal(created.length, 1);
    assert.equal(cards.length, 1);
  });

  it('safely replaces a definitely rejected card when the initial failure status write was lost', async () => {
    let deliveryAttempts = 0;
    const { service, created, cards } = createHarness(
      'create',
      { kind: 'allowed' },
      { userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' },
      async () => {
        deliveryAttempts += 1;
        return deliveryAttempts === 1
          ? err(new ChannelError({
              channel: 'lark',
              stage: 'send_status',
              reason: 'upstream_4xx',
              message: 'recipient rejected',
            }))
          : ok({ messageId: 'message-2' });
      },
      undefined,
      async () => err(new Error('approval status write failed')),
    );
    const input = {
      member,
      departmentId: 'department-1',
      execution: { version: 1 as const, threadId: 'thread-1', runId: 'run-definite-delivery', actionId: 'action-1' },
      title: 'Create retry-safe sheet',
      summary: 'Create one exact governed sheet.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    };

    const first = await service.create(input);
    const retry = await service.create(input);

    assert.equal(first.ok, false);
    assert.equal(first.status, 'approval_misconfigured');
    assert.equal(retry.ok, true);
    assert.equal((retry.data as any).status, 'waiting_for_manager_approval');
    assert.equal(created.length, 2);
    assert.equal(cards.length, 2);
    assert.equal(deliveryAttempts, 2);
  });

  it('keeps one actionable card when delivery succeeded but its message ID could not be stored', async () => {
    const { service, cards } = createHarness(
      'create',
      { kind: 'allowed' },
      { userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' },
      undefined,
      async () => err(new Error('database write failed')),
    );
    const input = {
      member,
      departmentId: 'department-1',
      execution: { version: 1 as const, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      title: 'Create daily summary sheet',
      summary: 'Create one exact output.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    };

    const first = await service.create(input);
    const retry = await service.create(input);

    assert.equal(first.ok, true);
    assert.equal((first.data as any).requestState, 'dispatching');
    assert.equal(retry.ok, true);
    assert.equal((retry.data as any).requestState, 'dispatching');
    assert.equal(cards.length, 1);
  });

  it('rejects read calls because reads must happen before a mutation plan', async () => {
    const { service, created, cards } = createHarness('read');
    const response = await service.create({
      member,
      departmentId: 'department-1',
      title: 'Read inbox',
      summary: 'Read messages.',
      invocations: [{ skillId: 'skill-1', toolId: 'googleGmail', args: { nativeTool: 'search_gmail_messages', input: { query: 'newer_than:1d' } } }],
    });

    assert.equal(response.ok, false);
    assert.equal(response.status, 'invalid_args');
    assert.equal(created.length, 0);
    assert.equal(cards.length, 0);
  });

  it('sends a governed batch to the exact connection approver instead of the department manager', async () => {
    const { service, created, cards } = createHarness('create', {
      kind: 'required',
      authority: 'connection_owner',
      approver: { userId: 'owner-1', larkOpenId: 'ou_owner', displayName: 'Connection Owner' },
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    });
    const response = await service.create({
      member,
      departmentId: 'department-1',
      title: 'Create governed sheet',
      summary: 'Create a sheet through a shared connection.',
      invocations: [{
        skillId: 'skill-1',
        toolId: 'googleSheets',
        args: { connectionId: 'connection-1', nativeTool: 'create_spreadsheet', input: { title: 'Leads' } },
      }],
    });

    assert.equal(response.ok, true);
    assert.equal(cards[0].openId, 'ou_owner');
    assert.equal(created[0].metadataJson.resolvedManagerUserId, 'owner-1');
    assert.equal(created[0].metadataJson.approvalAuthority, 'connection_owner');
    assert.deepEqual(created[0].payloadJson.approvalSignature, {
      kind: 'required',
      authority: 'connection_owner',
      approverUserId: 'owner-1',
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    });
    assert.deepEqual(created[0].payloadJson.invocations[0].approvalSignature, {
      kind: 'required',
      authority: 'connection_owner',
      approverUserId: 'owner-1',
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    });
  });

  it('does not require a department manager when connection policy selects its own approver', async () => {
    const { service, created, cards } = createHarness('create', {
      kind: 'required',
      authority: 'connection_owner',
      approver: { userId: 'owner-1', larkOpenId: 'ou_owner', displayName: 'Connection Owner' },
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    }, null);
    const response = await service.create({
      member,
      departmentId: 'department-without-manager',
      title: 'Create owner-approved sheet',
      summary: 'Create a sheet through its owner-governed connection.',
      invocations: [{
        skillId: 'skill-1',
        toolId: 'googleSheets',
        args: { connectionId: 'connection-1', nativeTool: 'create_spreadsheet', input: { title: 'Leads' } },
      }],
    });

    assert.equal(response.ok, true);
    assert.equal(cards[0].openId, 'ou_owner');
    assert.equal(created[0].metadataJson.resolvedManagerUserId, 'owner-1');
  });

  it('rejects a mixed batch controlled by different connection approvers', async () => {
    const { service, created, cards } = createHarness('create', (input) => ({
      kind: 'required',
      authority: 'connection_owner',
      approver: {
        userId: input.args.connectionId === 'connection-1' ? 'owner-1' : 'owner-2',
        larkOpenId: input.args.connectionId === 'connection-1' ? 'ou_owner_1' : 'ou_owner_2',
        displayName: input.args.connectionId === 'connection-1' ? 'Owner One' : 'Owner Two',
      },
      connectionScope: {
        connectionId: input.args.connectionId,
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    }));
    const response = await service.create({
      member,
      departmentId: 'department-1',
      title: 'Write two governed accounts',
      summary: 'Write to two separately owned accounts.',
      invocations: [
        { skillId: 'skill-1', toolId: 'googleSheets', args: { connectionId: 'connection-1', operation: 'create' } },
        { skillId: 'skill-1', toolId: 'googleSheets', args: { connectionId: 'connection-2', operation: 'create' } },
      ],
    });

    assert.equal(response.ok, false);
    assert.equal(response.status, 'approval_misconfigured');
    assert.match(response.error?.message ?? '', /different approval authorities/i);
    assert.equal(created.length, 0);
    assert.equal(cards.length, 0);
  });

  it('does not parse malformed stored payloads as executable batches', () => {
    assert.equal(parseAutomationPlanPayload({ version: 1, title: 'x', summary: 'y', invocations: [] }), null);
    assert.equal(parseAutomationPlanPayload({ version: 2, title: 'x', summary: 'y', invocations: [] }), null);
  });

  it('keeps an approved fingerprint valid when JSONB reorders nested object keys', () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const invocation = plan.payloadJson.invocations[0];
    invocation.args = {
      input: { title: invocation.args.input.title },
      nativeTool: invocation.args.nativeTool,
      connectionId: invocation.args.connectionId,
    };

    assert.notEqual(parseAutomationPlanPayload(plan.payloadJson), null);
  });
});

function createExecutorScenario(
  plan: any,
  currentRequirement: ApprovalRequirement | ((input: { args: Record<string, unknown> }) => ApprovalRequirement),
  currentBatchApproverUserId = plan.payloadJson.approvalSignature.approverUserId,
  resolvePermissions: () => Promise<ReturnType<typeof ok> | ReturnType<typeof err>> =
    async () => ok({ department: {} }),
  approvalResolver = createFixedApprovalResolver(currentBatchApproverUserId),
  runtimePreflight: (input: any) => Promise<any> =
    async (input) => ({ status: 'success', toolId: input.toolId, action: input.expectedAction }),
  authorizesTool: () => Promise<boolean> = async () => true,
) {
  const calls: unknown[] = [];
  const failures: any[] = [];
  const channelIdentityRepo = {
    resolveByUserId: async () => ok({
      userId: member.userId,
      companyId: member.companyId,
      aiRole: member.aiRole,
      channel: 'lark',
      larkOpenId: member.larkOpenId,
      email: member.email,
    }),
  };
  const executor = new AutomationPlanExecutor({
    skillCatalog: { authorizesTool } as any,
    skillAccessEnforcement,
    approvalRepo: {
      claimApprovedExecution: async () => ok(plan),
      persistExecutingResult: async () => ok(true),
      completeApprovedExecution: async () => ok(true),
      failApprovedExecution: async (_id: string, result: unknown) => {
        failures.push(result);
        return ok(true);
      },
      persistResult: async () => ok(undefined),
    } as any,
    channelIdentityRepo: channelIdentityRepo as any,
    permissions: { resolve: resolvePermissions } as any,
    approvalGate: {
      inspect: async (input: { args: Record<string, unknown> }) => typeof currentRequirement === 'function'
        ? currentRequirement(input)
        : currentRequirement,
    } as any,
    approvalResolver,
    toolExecutor: {
      preflightForRuntime: runtimePreflight,
      executeForRuntime: async (input: unknown) => {
        calls.push(input);
        return { status: 'success', toolId: 'googleSheets', action: 'create' };
      },
    } as any,
    logger: noopLogger,
  });
  return { executor, calls, failures, channelIdentityRepo };
}

function createSignedPlan(
  approvalSignature: Record<string, unknown>,
  approvedByUserId: string,
): any {
  const args = {
    connectionId: 'connection-1',
    nativeTool: 'create_spreadsheet',
    input: { title: 'Summary' },
  };
  const batchApprovalSignature = approvalSignature.kind === 'required'
    ? approvalSignature
    : {
        kind: 'required',
        authority: 'department_manager',
        approverUserId: approvedByUserId,
        connectionScope: null,
      };
  const plan = {
    id: 'approval-signature-test',
    companyId: member.companyId,
    kind: 'automation_script_plan',
    status: 'approved',
    requestedBy: member.userId,
    payloadJson: {
      version: 2,
      title: 'Create summary sheet',
      summary: 'Create the exact approved sheet.',
      approvalSignature: batchApprovalSignature,
      invocations: [{
        skillId: 'skill-1',
        toolId: 'googleSheets',
        action: 'create',
        args,
        argsHash: hashArgs(args),
        validation: { checked: true },
        callSummary: 'googleSheets.create_spreadsheet | title=Summary',
        approvalSignature,
      }],
    },
    metadataJson: { departmentId: 'department-1', resolvedManagerUserId: approvedByUserId },
  };
  refreshPlanHash(plan);
  return plan;
}

function createFixedApprovalResolver(userId: string) {
  const approver = { userId, larkOpenId: `ou_${userId}`, displayName: userId };
  return {
    resolveManager: async () => approver,
    resolveConnectionOwner: async () => approver,
    resolveCompanyAdmin: async () => approver,
  } as any;
}

describe('AutomationPlanExecutor', () => {
  it('continues deferred execution when only advisory skill provenance is revoked', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
      'manager-1',
      async () => ok({ department: {} }),
      createFixedApprovalResolver('manager-1'),
      undefined,
      async () => false,
    );

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 1);
    assert.equal(failures.length, 0);
  });

  it('fails closed when identity resolution returns a different requester or company', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const { executor, calls, failures, channelIdentityRepo } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
    );
    channelIdentityRepo.resolveByUserId = async () => ok({
      userId: 'different-user',
      companyId: 'different-company',
      aiRole: 'COMPANY_ADMIN',
      channel: 'lark',
      larkOpenId: 'ou_different',
      email: 'different@example.com',
    });

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'identity_scope_mismatch');
  });

  it('revalidates approval authority and durably checkpoints every completed mutation', async () => {
    const calls: any[] = [];
    const completed: any[] = [];
    const progress: any[] = [];
    const args = { nativeTool: 'create_spreadsheet', input: { title: 'Summary' } };
    const plan = {
      id: 'approval-1',
      companyId: member.companyId,
      kind: 'automation_script_plan',
      status: 'approved',
      requestedBy: member.userId,
      payloadJson: {
        version: 2,
        title: 'Create summary sheet',
        summary: 'Create the exact approved sheet.',
        approvalSignature: {
          kind: 'required',
          authority: 'department_manager',
          approverUserId: 'manager-1',
          connectionScope: null,
        },
        invocations: [{
          skillId: 'skill-1',
          toolId: 'googleSheets',
          action: 'create',
          args,
          argsHash: hashArgs(args),
          validation: { checked: true },
          callSummary: 'googleSheets.create_spreadsheet | title=Summary',
          approvalSignature: {
            kind: 'required',
            authority: 'department_manager',
            approverUserId: 'manager-1',
            connectionScope: null,
          },
        }],
      },
      metadataJson: {
        departmentId: 'department-1',
        resolvedManagerUserId: 'manager-1',
        execution: { version: 1, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      },
    } as any;
    refreshPlanHash(plan);
    const executor = new AutomationPlanExecutor({
      ...skillBindingDeps,
      approvalRepo: {
        claimApprovedExecution: async () => ok(plan),
        persistExecutingResult: async (_id: string, result: unknown) => {
          progress.push(result);
          return ok(true);
        },
        completeApprovedExecution: async (_id: string, result: unknown) => {
          completed.push(result);
          return ok(true);
        },
        failApprovedExecution: async () => ok(true),
        persistResult: async () => ok(undefined),
      } as any,
      channelIdentityRepo: {
        resolveByUserId: async () => ok({
          userId: member.userId,
          companyId: member.companyId,
          aiRole: member.aiRole,
          channel: 'lark',
          larkOpenId: member.larkOpenId,
          email: member.email,
        }),
      } as any,
      permissions: { resolve: async () => ok({ department: {} }) } as any,
      approvalGate: {
        inspect: async () => ({
          kind: 'required',
          authority: 'department_manager',
          approver: { userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' },
        }),
      } as any,
      approvalResolver: createFixedApprovalResolver('manager-1'),
      toolExecutor: {
        preflightForRuntime: async (input: any) => ({
          status: 'success',
          toolId: input.toolId,
          action: input.expectedAction,
        }),
        executeForRuntime: async (input: unknown) => {
          calls.push(input);
          return { status: 'success', toolId: 'googleSheets', action: 'create', result: { id: 'sheet-1' } };
        },
      } as any,
      logger: noopLogger,
    });

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedAction, 'create');
    assert.equal('approvalGate' in calls[0], false);
    assert.equal(calls[0].runContext.chatId, 'thread-1');
    assert.ok(progress.some((checkpoint) => checkpoint.completedCalls === 1
      && checkpoint.results?.[0]?.result?.id === 'sheet-1'));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 'completed');
  });

  it('fails closed before execution when the connection approver changed after approval', async () => {
    const calls: unknown[] = [];
    const failures: any[] = [];
    const args = {
      connectionId: 'connection-1',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Summary' },
    };
    const plan = {
      id: 'approval-1',
      companyId: member.companyId,
      kind: 'automation_script_plan',
      status: 'approved',
      requestedBy: member.userId,
      payloadJson: {
        version: 2,
        title: 'Create summary sheet',
        summary: 'Create the exact approved sheet.',
        approvalSignature: {
          kind: 'required',
          authority: 'connection_owner',
          approverUserId: 'old-owner',
          connectionScope: {
            connectionId: 'connection-1',
            mode: 'connection_owner',
            policySource: 'manager_policy',
          },
        },
        invocations: [{
          skillId: 'skill-1',
          toolId: 'googleSheets',
          action: 'create',
          args,
          argsHash: hashArgs(args),
          validation: { checked: true },
          callSummary: 'googleSheets.create_spreadsheet | title=Summary',
          approvalSignature: {
            kind: 'required',
            authority: 'connection_owner',
            approverUserId: 'old-owner',
            connectionScope: {
              connectionId: 'connection-1',
              mode: 'connection_owner',
              policySource: 'manager_policy',
            },
          },
        }],
      },
      metadataJson: { departmentId: 'department-1', resolvedManagerUserId: 'old-owner' },
    } as any;
    refreshPlanHash(plan);
    const executor = new AutomationPlanExecutor({
      ...skillBindingDeps,
      approvalRepo: {
        claimApprovedExecution: async () => ok(plan),
        persistExecutingResult: async () => ok(true),
        completeApprovedExecution: async () => ok(true),
        failApprovedExecution: async (_id: string, result: unknown) => {
          failures.push(result);
          return ok(true);
        },
        persistResult: async () => ok(undefined),
      } as any,
      channelIdentityRepo: {
        resolveByUserId: async () => ok({
          userId: member.userId,
          companyId: member.companyId,
          aiRole: member.aiRole,
          channel: 'lark',
          larkOpenId: member.larkOpenId,
          email: member.email,
        }),
      } as any,
      permissions: { resolve: async () => ok({ department: {} }) } as any,
      approvalGate: {
        inspect: async () => ({
          kind: 'required',
          authority: 'connection_owner',
          approver: { userId: 'new-owner', larkOpenId: 'ou_new_owner', displayName: 'New Owner' },
          connectionScope: {
            connectionId: 'connection-1',
            mode: 'connection_owner',
            policySource: 'manager_policy',
          },
        }),
      } as any,
      approvalResolver: createFixedApprovalResolver('old-owner'),
      toolExecutor: {
        preflightForRuntime: async (input: any) => ({
          status: 'success',
          toolId: input.toolId,
          action: input.expectedAction,
        }),
        executeForRuntime: async (input: unknown) => {
          calls.push(input);
          return { status: 'success', toolId: 'googleSheets', action: 'create' };
        },
      } as any,
      logger: noopLogger,
    });

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'approval_changed');
  });

  it('fails closed when the same person is selected under a different approval authority', async () => {
    const approver = { userId: 'multi-role-user', larkOpenId: 'ou_multi_role', displayName: 'Multi Role User' };
    const storedOwnerSignature = {
      kind: 'required',
      authority: 'connection_owner',
      approverUserId: approver.userId,
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    };
    const transitions: ApprovalRequirement[] = [
      {
        kind: 'required',
        authority: 'company_admin',
        approver,
        connectionScope: {
          connectionId: 'connection-1',
          mode: 'company_admin',
          policySource: 'company_admin_override',
        },
      },
      { kind: 'required', authority: 'department_manager', approver },
    ];

    for (const currentRequirement of transitions) {
      const plan = createSignedPlan(storedOwnerSignature, approver.userId);
      const { executor, calls, failures } = createExecutorScenario(plan, currentRequirement);

      await executor.resume(plan, 'approved');

      assert.equal(calls.length, 0);
      assert.equal(failures[0]?.status, 'approval_changed');
    }
  });

  it('rejects stored batch and invocation signatures that use different authority routes', async () => {
    const approverUserId = 'multi-role-user';
    const plan = createSignedPlan({
      kind: 'required',
      authority: 'connection_owner',
      approverUserId,
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    }, approverUserId);
    plan.payloadJson.approvalSignature = {
      kind: 'required',
      authority: 'department_manager',
      approverUserId,
      connectionScope: null,
    };
    refreshPlanHash(plan);
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'required', authority: 'department_manager', approver: {
        userId: approverUserId,
        larkOpenId: 'ou_multi_role',
        displayName: 'Multi Role User',
      } },
    );

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'invalid_plan');
  });

  it('fails closed when the governed connection scope or policy source changes', async () => {
    const approver = { userId: 'owner-1', larkOpenId: 'ou_owner', displayName: 'Connection Owner' };
    const storedOwnerSignature = {
      kind: 'required',
      authority: 'connection_owner',
      approverUserId: approver.userId,
      connectionScope: {
        connectionId: 'connection-1',
        mode: 'connection_owner',
        policySource: 'manager_policy',
      },
    };
    const changedScopes: ApprovalRequirement[] = [
      {
        kind: 'required',
        authority: 'connection_owner',
        approver,
        connectionScope: {
          connectionId: 'connection-2',
          mode: 'connection_owner',
          policySource: 'manager_policy',
        },
      },
      {
        kind: 'required',
        authority: 'connection_owner',
        approver,
        connectionScope: {
          connectionId: 'connection-1',
          mode: 'connection_owner',
          policySource: 'company_admin_override',
        },
      },
    ];

    for (const currentRequirement of changedScopes) {
      const plan = createSignedPlan(storedOwnerSignature, approver.userId);
      const { executor, calls, failures } = createExecutorScenario(plan, currentRequirement);

      await executor.resume(plan, 'approved');

      assert.equal(calls.length, 0);
      assert.equal(failures[0]?.status, 'approval_changed');
    }
  });

  it('fails legacy unsigned plans closed before any mutation executes', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    plan.payloadJson.version = 1;
    delete plan.payloadJson.invocations[0].approvalSignature;
    const { executor, calls, failures } = createExecutorScenario(plan, { kind: 'allowed' });

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'invalid_plan');
  });

  it('fails closed when the fallback department approver changed after approving the batch', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'old-manager');
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
      'new-manager',
    );

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'approval_changed');
    assert.match(failures[0]?.message ?? '', /human authority/i);
  });

  it('revalidates every invocation before executing the first mutation', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const secondArgs = {
      connectionId: 'governed-connection',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Second' },
    };
    plan.payloadJson.invocations.push({
      ...plan.payloadJson.invocations[0],
      args: secondArgs,
      argsHash: hashArgs(secondArgs),
      callSummary: 'googleSheets.create_spreadsheet | title=Second',
    });
    refreshPlanHash(plan);
    const approver = { userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' };
    const { executor, calls, failures } = createExecutorScenario(plan, ({ args }) => (
      args.connectionId === 'governed-connection'
        ? {
            kind: 'required',
            authority: 'connection_owner',
            approver,
            connectionScope: {
              connectionId: 'governed-connection',
              mode: 'connection_owner',
              policySource: 'manager_policy',
            },
          }
        : { kind: 'allowed' }
    ));

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'approval_changed');
  });

  it('preflights the full batch before executing its first mutation', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const secondArgs = {
      connectionId: 'connection-1',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Second' },
    };
    plan.payloadJson.invocations.push({
      ...plan.payloadJson.invocations[0],
      args: secondArgs,
      argsHash: hashArgs(secondArgs),
      callSummary: 'googleSheets.create_spreadsheet | title=Second',
    });
    refreshPlanHash(plan);
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
      'manager-1',
      async () => ok({ department: {} }),
      createFixedApprovalResolver('manager-1'),
      async (input) => input.args.input.title === 'Second'
        ? {
            status: 'invalid_args',
            toolId: input.toolId,
            action: input.expectedAction,
            message: 'The second call is no longer valid.',
          }
        : { status: 'success', toolId: input.toolId, action: input.expectedAction },
    );

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'preflight_failed');
    assert.equal(failures[0]?.completedCalls, 0);
    assert.equal(failures[0]?.failedCall?.index, 1);
  });

  it('rechecks tool readiness immediately before each mutation', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const secondArgs = {
      connectionId: 'connection-1',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Second' },
    };
    plan.payloadJson.invocations.push({
      ...plan.payloadJson.invocations[0],
      args: secondArgs,
      argsHash: hashArgs(secondArgs),
      callSummary: 'googleSheets.create_spreadsheet | title=Second',
    });
    refreshPlanHash(plan);
    let preflightCalls = 0;
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
      'manager-1',
      async () => ok({ department: {} }),
      createFixedApprovalResolver('manager-1'),
      async (input) => {
        preflightCalls += 1;
        return preflightCalls === 4
          ? {
              status: 'invalid_args',
              toolId: input.toolId,
              action: input.expectedAction,
              message: 'The second destination was removed after batch preflight.',
            }
          : { status: 'success', toolId: input.toolId, action: input.expectedAction };
      },
    );

    await executor.resume(plan, 'approved');

    assert.equal(preflightCalls, 4);
    assert.equal(calls.length, 1);
    assert.equal(failures[0]?.status, 'preflight_failed');
    assert.equal(failures[0]?.completedCalls, 1);
    assert.equal(failures[0]?.failedCall?.index, 1);
  });

  it('rejects stored arguments that no longer match their approved fingerprint', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    plan.payloadJson.invocations[0].args.input.title = 'Tampered after approval';
    const { executor, calls, failures } = createExecutorScenario(plan, { kind: 'allowed' });

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'invalid_plan');
  });

  it('rejects a valid-looking invocation added after the full batch was approved', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const unapprovedArgs = {
      connectionId: 'connection-1',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Unapproved extra sheet' },
    };
    plan.payloadJson.invocations.push({
      ...plan.payloadJson.invocations[0],
      args: unapprovedArgs,
      argsHash: hashArgs(unapprovedArgs),
      callSummary: 'googleSheets.create_spreadsheet | title=Unapproved extra sheet',
    });
    const { executor, calls, failures } = createExecutorScenario(plan, { kind: 'allowed' });

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures[0]?.status, 'invalid_plan');
    assert.match(failures[0]?.message ?? '', /approval fingerprint/i);
  });

  it('re-resolves RBAC before every mutation and stops when access is revoked mid-batch', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const secondArgs = {
      connectionId: 'connection-1',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Second' },
    };
    plan.payloadJson.invocations.push({
      ...plan.payloadJson.invocations[0],
      args: secondArgs,
      argsHash: hashArgs(secondArgs),
      callSummary: 'googleSheets.create_spreadsheet | title=Second',
    });
    refreshPlanHash(plan);
    let permissionChecks = 0;
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
      'manager-1',
      async () => {
        permissionChecks += 1;
        return permissionChecks < 3
          ? ok({ department: {} })
          : err({ code: 'permission_denied', message: 'Department access was revoked.' });
      },
    );

    await executor.resume(plan, 'approved');

    assert.equal(permissionChecks, 3);
    assert.equal(calls.length, 1);
    assert.equal(failures[0]?.status, 'permission_denied');
    assert.equal(failures[0]?.completedCalls, 1);
  });

  it('re-resolves the batch approver before every mutation and stops when it changes mid-batch', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const secondArgs = {
      connectionId: 'connection-1',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Second' },
    };
    plan.payloadJson.invocations.push({
      ...plan.payloadJson.invocations[0],
      args: secondArgs,
      argsHash: hashArgs(secondArgs),
      callSummary: 'googleSheets.create_spreadsheet | title=Second',
    });
    refreshPlanHash(plan);
    let managerChecks = 0;
    const approvalResolver = {
      resolveManager: async () => {
        managerChecks += 1;
        const userId = managerChecks < 3 ? 'manager-1' : 'manager-2';
        return { userId, larkOpenId: `ou_${userId}`, displayName: userId };
      },
      resolveConnectionOwner: async () => null,
      resolveCompanyAdmin: async () => null,
    } as any;
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      { kind: 'allowed' },
      'manager-1',
      async () => ok({ department: {} }),
      approvalResolver,
    );

    await executor.resume(plan, 'approved');

    assert.equal(managerChecks, 3);
    assert.equal(calls.length, 1);
    assert.equal(failures[0]?.status, 'approval_changed');
    assert.equal(failures[0]?.completedCalls, 1);
  });

  it('durably fails a claimed batch when an unexpected dependency exception escapes', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const { executor, calls, failures } = createExecutorScenario(
      plan,
      () => {
        throw new Error('approval policy lookup disconnected');
      },
    );

    await executor.resume(plan, 'approved');

    assert.equal(calls.length, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.status, 'execution_exception');
    assert.match(failures[0]?.message ?? '', /approval policy lookup disconnected/);
    assert.equal(failures[0]?.completedCalls, 0);
  });

  it('keeps a terminal uncertainty checkpoint when both terminal transitions fail', async () => {
    const plan = createSignedPlan({ kind: 'allowed' }, 'manager-1');
    const checkpoints: any[] = [];
    const executor = new AutomationPlanExecutor({
      ...skillBindingDeps,
      approvalRepo: {
        claimApprovedExecution: async () => ok(plan),
        persistExecutingResult: async (_id: string, result: unknown) => {
          checkpoints.push(result);
          return ok(true);
        },
        completeApprovedExecution: async () => ok(false),
        failApprovedExecution: async () => ok(false),
        persistResult: async () => ok(undefined),
      } as any,
      channelIdentityRepo: {
        resolveByUserId: async () => ok({
          userId: member.userId,
          companyId: member.companyId,
          aiRole: member.aiRole,
          channel: 'lark',
          larkOpenId: member.larkOpenId,
          email: member.email,
        }),
      } as any,
      permissions: { resolve: async () => ok({ department: {} }) } as any,
      approvalGate: { inspect: async () => ({ kind: 'allowed' }) } as any,
      approvalResolver: createFixedApprovalResolver('manager-1'),
      toolExecutor: {
        preflightForRuntime: async (input: any) => ({
          status: 'success',
          toolId: input.toolId,
          action: input.expectedAction,
        }),
        executeForRuntime: async () => ({
          status: 'success',
          toolId: 'googleSheets',
          action: 'create',
          result: { id: 'sheet-1' },
        }),
      } as any,
      logger: noopLogger,
    });

    await executor.resume(plan, 'approved');

    const terminal = checkpoints.at(-1);
    assert.equal(terminal?.status, 'terminal_checkpoint_failed');
    assert.equal(terminal?.intendedStatus, 'completion_checkpoint_failed');
    assert.equal(terminal?.completedCalls, 1);
    assert.equal(terminal?.totalCalls, 1);
    assert.equal(terminal?.results?.[0]?.result?.id, 'sheet-1');
    assert.equal(terminal?.retry, 'do_not_retry');
  });
});

function hashArgs(args: Record<string, unknown>): string {
  return sha256CanonicalJson(args);
}

function refreshPlanHash(plan: any): void {
  plan.metadataJson.planHash = computeAutomationPlanHash(plan.payloadJson);
}
