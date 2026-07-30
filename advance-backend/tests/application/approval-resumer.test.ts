import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { ApprovalResumerService } from '../../src/application/approval/approval-resumer.service.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { ToolRegistry } from '../../src/application/tools/tool-registry.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

function approvedRow(
  status: 'approved' | 'rejected' = 'approved',
  metadataOverrides: Record<string, unknown> = {},
) {
  return {
    id: 'approval-1',
    companyId: 'company-1',
    status,
    toolId: 'larkDoc',
    actionGroup: 'create',
    payloadJson: {
      toolId: 'larkDoc',
      action: 'create',
      args: { title: 'Approved document', connectionId: 'lark-connection-1' },
      argsHash: 'exact-args-hash',
    },
    metadataJson: {
      chatId: 'chat-1:approval:department:dept-1:manager:user-manager',
      sourceChatId: 'chat-1',
      approvalOrigin: 'lark',
      requesterId: 'user-1',
      requesterLarkOpenId: 'ou-user-1',
      tenantKey: 'tenant-1',
      statusMessageId: 'status-1',
      departmentId: 'dept-1',
      execution: null,
      ...metadataOverrides,
    },
  } as any;
}

function makeExecutableResumer(row: unknown, channelIdentityRepo: unknown) {
  const registry = new ToolRegistry();
  const executed: unknown[] = [];
  let resumedRunContext: any;
  const dmDeliveries: any[] = [];
  registry.register({
    id: asToolId('larkDoc'),
    family: 'lark',
    actionGroups: new Set(['create']),
    argsSchema: z.object({ title: z.string() }),
    resultSchema: z.unknown(),
    description: 'Create a Lark document',
    permissionCheck: () => ok('create'),
    execute: async (args: unknown, ctx: any) => {
      executed.push(args);
      resumedRunContext = ctx?.runContext;
      return ok({ documentUrl: 'https://example.test/doc-1' });
    },
  } as any);
  const executor = new ToolExecutor({
    toolRegistry: registry,
    permissions: {} as any,
    logger: noopLogger,
    clock: { now: () => new Date(), nowMs: () => Date.now() },
  });

  const completions: unknown[] = [];
  const failures: unknown[] = [];
  const finalTexts: string[] = [];
  const finalConversations: unknown[] = [];
  const statusSends: unknown[] = [];
  let resumedChatId: string | undefined;
  let resumedExecution: unknown;
  const expectedExecution = (row as any)?.metadataJson?.execution;
  const service = new ApprovalResumerService({
    scheduledDmAdapter: {
      sendFinalReply: async (conversation: any, reply: any) => {
        dmDeliveries.push({ chatId: String(conversation.chatId), text: reply.text });
        return ok({ channel: 'lark', messageId: 'dm-1' });
      },
    } as any,
    approvalRepo: {
      findById: async () => ok(row),
      failApprovedExecution: async (_id: string, result: unknown) => {
        failures.push(result);
        return ok(true);
      },
      persistResult: async () => ok(undefined),
    } as any,
    larkAdapter: {
      restoreStatusCoordinator: () => {},
      sendStatus: async (conversation: unknown) => { statusSends.push(conversation); return ok({}); },
      sendFinalReply: async (conversation: unknown, reply: { text: string }) => {
        finalConversations.push(conversation);
        finalTexts.push(reply.text);
        return ok({});
      },
    } as any,
    channelIdentityRepo: channelIdentityRepo as any,
    approvalGate: {
      check: async (input: { chatId: string; execution?: unknown }) => {
        resumedChatId = input.chatId;
        resumedExecution = input.execution;
        if (expectedExecution && JSON.stringify(input.execution) !== JSON.stringify(expectedExecution)) {
          return { kind: 'misconfigured', message: 'Execution context mismatch' };
        }
        return { kind: 'allowed', executionGrant: { approvalId: 'approval-1' } };
      },
      completeExecution: async (_grant: unknown, result: unknown) => { completions.push(result); return true; },
      failExecution: async () => true,
    } as any,
    toolExecutor: executor,
    permissions: {
      resolve: async () => ok({
        allowedToolIds: new Set([asToolId('larkDoc')]),
        allowedActionsByTool: new Map([[asToolId('larkDoc'), new Set(['create'])]]),
        decisions: [],
        department: { id: 'dept-1', zohoReadScope: 'all' },
      }),
    } as any,
    logger: noopLogger,
  });

  return {
    service,
    executed,
    completions,
    failures,
    finalTexts,
    finalConversations,
    getResumedChatId: () => resumedChatId,
    getResumedExecution: () => resumedExecution,
    getResumedRunContext: () => resumedRunContext,
    dmDeliveries,
    statusSends,
  };
}

describe('ApprovalResumerService', () => {
  it('reports a scheduled run\'s approved outcome to the creator, not its synthetic thread', async () => {
    // A scheduled run's recorded conversation is `scheduled-workflow:<id>`,
    // which is not a chat anyone can receive on. Delivering there fails
    // silently, so the creator is never told the approved action ran.
    const harness = makeExecutableResumer(approvedRow('approved', {
      deliveryMode: 'scheduled_runtime_delivery',
      sourceChatId: 'scheduled-workflow:wf-1',
      statusMessageId: null,
    }), {
      resolveByLarkTenantIdentity: async () => ok({
        userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark',
        larkOpenId: 'ou-user-1', activeDepartmentId: 'dept-1',
      }),
    });

    await harness.service.resume('approval-1', 'approved');

    assert.equal(harness.dmDeliveries.length, 1);
    assert.equal(harness.dmDeliveries[0].chatId, 'ou-user-1');
    assert.match(harness.dmDeliveries[0].text, /Approved action completed/);
    // Nothing addressed to the thread that cannot receive it — including the
    // interim progress card, which has no live conversation waiting on it.
    assert.equal(harness.finalTexts.length, 0);
    assert.equal(harness.statusSends.length, 0);
  });

  it('tells the creator when a scheduled run\'s action was refused', async () => {
    // The rejection and failure branches deliver through the same path. If only
    // the success branch were routed, a declined scheduled action would go
    // unreported to the one person waiting on it.
    const harness = makeExecutableResumer(approvedRow('rejected', {
      deliveryMode: 'scheduled_runtime_delivery',
      sourceChatId: 'scheduled-workflow:wf-1',
      statusMessageId: null,
    }), {
      resolveByLarkTenantIdentity: async () => ok({
        userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark',
        larkOpenId: 'ou-user-1', activeDepartmentId: 'dept-1',
      }),
    });

    await harness.service.resume('approval-1', 'rejected');

    assert.equal(harness.dmDeliveries.length, 1);
    assert.equal(harness.dmDeliveries[0].chatId, 'ou-user-1');
    assert.match(harness.dmDeliveries[0].text, /not approved/i);
    assert.equal(harness.finalTexts.length, 0);
  });

  it('replays a scheduled run\'s delivery rules into the approved execution', async () => {
    // Approval is checked before a tool runs, so a scheduled run reaches the
    // gate with its delivery guards untested. The context is rebuilt here from
    // stored metadata rather than from the session, which is revoked by the
    // time an approval comes back — so without replaying this, approving a
    // scheduled run's message would deliver it where the run itself could not.
    const identity = {
      resolveByLarkTenantIdentity: async () => ok({
        userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark',
        larkOpenId: 'ou-user-1', activeDepartmentId: 'dept-1',
      }),
    };

    const scheduled = makeExecutableResumer(
      approvedRow('approved', { deliveryMode: 'scheduled_runtime_delivery' }),
      identity,
    );
    await scheduled.service.resume('approval-1', 'approved');
    assert.equal(
      scheduled.getResumedRunContext()?.deliveryMode,
      'scheduled_runtime_delivery',
    );

    // An ordinary interactive approval must not inherit it. Assert the tool ran
    // at all first: otherwise a resume that never executed reads as "no
    // restriction" and this passes for the wrong reason.
    const interactive = makeExecutableResumer(approvedRow('approved'), identity);
    await interactive.service.resume('approval-1', 'approved');
    assert.ok(interactive.getResumedRunContext(), 'the approved tool must execute');
    assert.equal(interactive.getResumedRunContext()?.deliveryMode, undefined);
  });

  it('executes the stored approved tool call without re-entering the agent loop', async () => {
    let resolvedTenantKey: string | undefined;
    const execution = {
      version: 1,
      threadId: 'chat-1',
      runId: 'run-1',
      actionId: 'action-1',
    };
    const harness = makeExecutableResumer(approvedRow('approved', {
      approvalOrigin: 'cloud_pi',
      execution,
    }), {
      resolveByLarkTenantIdentity: async (_openId: string, tenantKey: string) => {
        resolvedTenantKey = tenantKey;
        return ok({
          userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark',
          larkOpenId: 'ou-user-1', activeDepartmentId: 'dept-1',
        });
      },
    });

    await harness.service.resume('approval-1', 'approved');

    assert.deepEqual(harness.executed, [{ title: 'Approved document' }]);
    assert.equal(harness.completions.length, 1);
    assert.equal(
      harness.getResumedChatId(),
      'chat-1:approval:department:dept-1:manager:user-manager',
    );
    assert.equal(resolvedTenantKey, 'tenant-1');
    assert.deepEqual(harness.getResumedExecution(), execution);
    assert.match(harness.finalTexts[0] ?? '', /Approved action completed/);
    assert.match(harness.finalTexts[0] ?? '', /documentUrl/);
  });

  it('delivers a deferred approval result back to its immutable thread target', async () => {
    const harness = makeExecutableResumer(approvedRow('approved', {
      replyToMessageId: 'om_request',
      replyInThread: true,
      statusMessageId: null,
    }), {
      resolveByLarkTenantIdentity: async () => ok({
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        channel: 'lark',
        larkOpenId: 'ou-user-1',
        activeDepartmentId: 'dept-1',
      }),
    });

    await harness.service.resume('approval-1', 'approved');

    assert.deepEqual(harness.finalConversations[0], {
      channel: 'lark',
      chatId: 'chat-1',
      replyToMessageId: 'om_request',
      replyInThread: true,
      correlationId: 'approval-approval-1',
    });
  });

  it('does not execute a cloud Pi approval with missing execution provenance', async () => {
    const harness = makeExecutableResumer(approvedRow('approved', {
      approvalOrigin: 'cloud_pi',
      execution: null,
    }), {
      resolveByLarkTenantIdentity: async () => {
        assert.fail('Identity resolution must not run for malformed cloud approval provenance');
      },
    });

    await harness.service.resume('approval-1', 'approved');

    assert.deepEqual(harness.executed, []);
    assert.equal(harness.failures.length, 1);
    assert.match(harness.finalTexts[0] ?? '', /missing its verified Pi execution context/i);
  });

  it('resumes a desktop approval by authenticated user ID without requiring a Lark tenant', async () => {
    let resolvedUserId: string | undefined;
    const harness = makeExecutableResumer(approvedRow('approved', {
      approvalOrigin: 'gateway',
      requesterLarkOpenId: null,
      tenantKey: null,
    }), {
      resolveByUserId: async (userId: string, companyId: string) => {
        resolvedUserId = userId;
        assert.equal(companyId, 'company-1');
        return ok({
          userId, companyId: 'company-1', aiRole: 'MEMBER', channel: 'desktop',
          activeDepartmentId: 'dept-1',
        });
      },
    });

    await harness.service.resume('approval-1', 'approved');

    assert.equal(resolvedUserId, 'user-1');
    assert.deepEqual(harness.executed, [{ title: 'Approved document' }]);
    assert.equal(harness.completions.length, 1);
  });

  it('rejects a desktop requester resolved into a different company', async () => {
    const harness = makeExecutableResumer(approvedRow('approved', {
      approvalOrigin: 'gateway',
      requesterLarkOpenId: null,
      tenantKey: null,
    }), {
      resolveByUserId: async () => ok({
        userId: 'user-1',
        companyId: 'company-other',
        aiRole: 'MEMBER',
        channel: 'internal',
      }),
    });

    await harness.service.resume('approval-1', 'approved');

    assert.deepEqual(harness.executed, []);
    assert.equal(harness.completions.length, 0);
    assert.match(harness.finalTexts[0] ?? '', /requester company/i);
  });

  it('does not execute anything when the manager rejects the stored action', async () => {
    const finalTexts: string[] = [];
    const service = new ApprovalResumerService({
      approvalRepo: {
        findById: async () => ok(approvedRow('rejected')),
        persistResult: async () => ok(undefined),
      } as any,
      larkAdapter: {
        restoreStatusCoordinator: () => {},
        sendFinalReply: async (_conversation: unknown, reply: { text: string }) => {
          finalTexts.push(reply.text);
          return ok({});
        },
      } as any,
      channelIdentityRepo: {} as any,
      approvalGate: {} as any,
      toolExecutor: {} as any,
      permissions: {} as any,
      logger: noopLogger,
    });

    await service.resume('approval-1', 'rejected');

    assert.match(finalTexts[0] ?? '', /nothing was changed/i);
  });
});
