import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutomationPlanService, parseAutomationPlanPayload } from '../../src/application/gateway/automation-plan.service.ts';
import { AutomationPlanExecutor } from '../../src/application/gateway/automation-plan.executor.ts';
import { gatewaySuccess } from '../../src/application/gateway/gateway.types.ts';
import { ok } from '../../src/shared/result.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';
import type { GatewayMemberContext } from '../../src/application/gateway/gateway.types.ts';

const member: GatewayMemberContext = {
  companyId: 'company-1',
  userId: 'member-1',
  aiRole: 'MEMBER',
  email: 'member@example.com',
  larkOpenId: 'ou_member',
  sessionId: 'session-1',
};

function createHarness(action: 'read' | 'create' = 'create') {
  const created: any[] = [];
  const cards: any[] = [];
  const service = new AutomationPlanService({
    toolExecutor: {
      preflight: async ({ toolId, args }: { toolId: string; args: Record<string, unknown> }) =>
        gatewaySuccess({ toolId, action, args, validation: { checked: true } }),
    } as any,
    permissions: {
      resolve: async () => ok({ department: { name: 'Finance' } }),
    } as any,
    approvalRepo: {
      findActiveByIdempotencyKey: async () => ok(null),
      create: async (input: any) => {
        created.push(input);
        return ok({
          id: '7c2b4c47-6b8d-4ee4-ae1c-9c94a7a8a1f0',
          status: 'pending',
          kind: input.kind,
          payloadJson: input.payloadJson,
          metadataJson: input.metadataJson,
          requestedBy: input.requestedBy,
          expiresAt: input.expiresAt,
          executionResultJson: null,
        });
      },
      setDecisionMessageId: async () => ok(undefined),
      markFailed: async () => ok(undefined),
    } as any,
    approvalResolver: {
      resolveManager: async () => ({ userId: 'manager-1', larkOpenId: 'ou_manager', displayName: 'Manager' }),
    } as any,
    larkAdapter: {
      sendDirectCard: async (openId: string, card: string) => {
        cards.push({ openId, card });
        return ok({ messageId: 'message-1' });
      },
    } as any,
    logger: noopLogger,
  });
  return { service, created, cards };
}

describe('AutomationPlanService', () => {
  it('stores only exact preflighted mutations and sends a manager card', async () => {
    const { service, created, cards } = createHarness('create');
    const response = await service.create({
      member,
      departmentId: 'department-1',
      execution: { version: 1, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      title: 'Create daily summary sheet',
      summary: 'Create a Google Sheet with today’s qualified leads.',
      invocations: [{ toolId: 'googleSheets', args: { nativeTool: 'create_spreadsheet', input: { title: 'Leads' } } }],
    });

    assert.equal(response.ok, true);
    assert.equal(created.length, 1);
    assert.equal(cards.length, 1);
    assert.equal(created[0].kind, 'automation_script_plan');
    assert.equal(created[0].metadataJson.approvalOrigin, 'automation');
    assert.equal(created[0].payloadJson.invocations[0].toolId, 'googleSheets');
    assert.equal(created[0].payloadJson.invocations[0].action, 'create');
    assert.match(created[0].payloadJson.invocations[0].callSummary, /googleSheets/);
    assert.match(cards[0].card, /Approve exact batch/);
    assert.match(cards[0].card, /googleSheets/);
  });

  it('rejects read calls because reads must happen before a mutation plan', async () => {
    const { service, created, cards } = createHarness('read');
    const response = await service.create({
      member,
      departmentId: 'department-1',
      title: 'Read inbox',
      summary: 'Read messages.',
      invocations: [{ toolId: 'googleGmail', args: { nativeTool: 'search_gmail_messages', input: { query: 'newer_than:1d' } } }],
    });

    assert.equal(response.ok, false);
    assert.equal(response.status, 'invalid_args');
    assert.equal(created.length, 0);
    assert.equal(cards.length, 0);
  });

  it('does not parse malformed stored payloads as executable batches', () => {
    assert.equal(parseAutomationPlanPayload({ version: 1, title: 'x', summary: 'y', invocations: [] }), null);
    assert.equal(parseAutomationPlanPayload({ version: 2, title: 'x', summary: 'y', invocations: [] }), null);
  });
});

describe('AutomationPlanExecutor', () => {
  it('revalidates and executes only the immutable approved calls without a second approval gate', async () => {
    const calls: any[] = [];
    const completed: any[] = [];
    const plan = {
      id: 'approval-1',
      kind: 'automation_script_plan',
      status: 'approved',
      requestedBy: member.userId,
      payloadJson: {
        version: 1,
        title: 'Create summary sheet',
        summary: 'Create the exact approved sheet.',
        invocations: [{
          toolId: 'googleSheets',
          action: 'create',
          args: { nativeTool: 'create_spreadsheet', input: { title: 'Summary' } },
          argsHash: 'a'.repeat(64),
          validation: { checked: true },
          callSummary: 'googleSheets.create_spreadsheet | title=Summary',
        }],
      },
      metadataJson: {
        departmentId: 'department-1',
        execution: { version: 1, threadId: 'thread-1', runId: 'run-1', actionId: 'action-1' },
      },
    } as any;
    const executor = new AutomationPlanExecutor({
      approvalRepo: {
        claimApprovedExecution: async () => ok(plan),
        persistExecutingResult: async () => ok(undefined),
        completeApprovedExecution: async (_id: string, result: unknown) => {
          completed.push(result);
          return ok(undefined);
        },
        failApprovedExecution: async () => ok(undefined),
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
      toolExecutor: {
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
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 'completed');
  });
});
