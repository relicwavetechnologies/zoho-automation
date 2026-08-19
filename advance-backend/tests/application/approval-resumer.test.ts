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

function makeExecutableResumer(
  row: unknown,
  channelIdentityRepo: unknown,
  toolResult: unknown = { documentUrl: 'https://example.test/doc-1' },
) {
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
      return ok(toolResult);
    },
  } as any);
  const executor = new ToolExecutor({
    toolRegistry: registry,
    permissions: {} as any,
    connectionRegistry: {
      listAccessibleLarkConnections: async () => ok([{
        connectionId: 'lark-connection-1',
        provider: 'lark',
        label: 'Primary Lark',
        ownerType: 'user',
        ownerUserId: 'user-1',
        access: 'read_write',
        scopes: [],
        connectedAt: new Date('2026-08-11T00:00:00.000Z'),
      }]),
    } as any,
    logger: noopLogger,
    clock: { now: () => new Date(), nowMs: () => Date.now() },
  });

  const completions: unknown[] = [];
  const failures: unknown[] = [];
  const webTurns: any[] = [];
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
    webTranscript: {
      appendTurn: async (chatId: string, turn: any, scope: any, metadata: any) => {
        webTurns.push({ chatId, text: turn.content, role: turn.role, scope, metadata });
        return undefined;
      },
    },
    logger: noopLogger,
  });

  return {
    service,
    executed,
    webTurns,
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
    assert.equal(harness.getResumedChatId(), 'chat-1');
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
    assert.match(JSON.stringify(harness.failures[0] ?? ''), /requester company/i);
    assert.equal(harness.finalTexts.length, 0);
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

describe('what an approved action reports back', () => {
  const identity = {
    resolveByLarkTenantIdentity: async () => ok({
      userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark',
      larkOpenId: 'ou-user-1', activeDepartmentId: 'dept-1',
    }),
  };

  it('says the tool\'s own sentence rather than dumping its return value', async () => {
    // This path does not go through the model — the approval comes back long
    // after the run that asked for it — so whatever is rendered here is read
    // verbatim by a person. It used to be the whole result as a JSON block:
    // somebody who approved a mail rule was shown twenty-three lines of
    // `ruleId`, `connectionId` and nested `destination` objects to say one
    // sentence's worth of thing.
    const harness = makeExecutableResumer(
      approvedRow('approved'),
      identity,
      {
        success: true,
        operation: 'create',
        rule: { ruleId: 'rule-1', connectionId: 'conn-1', destination: { type: 'email' } },
        message: 'Mail automation is active. Matching mail is now forwarded whole to a@b.com.',
      },
    );

    await harness.service.resume('approval-1', 'approved');

    const text = harness.dmDeliveries[0]?.text ?? harness.finalTexts[0] ?? '';
    assert.match(text, /Approved action completed/);
    assert.match(text, /forwarded whole to a@b\.com/);
    assert.equal(text.includes('```json'), false, 'the raw result was shown as well');
    assert.equal(text.includes('connectionId'), false, 'internal ids reached the reader');
  });

  it('still shows the fields when a tool wrote no sentence', async () => {
    // A result with no `message` is one nobody has written a sentence for, and
    // showing its fields is better than showing nothing.
    const harness = makeExecutableResumer(
      approvedRow('approved'),
      identity,
      { documentUrl: 'https://example.test/doc-1' },
    );

    await harness.service.resume('approval-1', 'approved');

    const text = harness.dmDeliveries[0]?.text ?? harness.finalTexts[0] ?? '';
    assert.match(text, /documentUrl/);
  });

  it('writes a web-raised approval\'s outcome into the thread that asked', async () => {
    /* Every non-Lark source used to resolve to no destination at all, so an
       approval raised in a browser executed correctly and reported into the
       void: the request vanished from the list and no answer ever arrived.
       The thread id is on the execution context, which is the only place a web
       run records it — the stored chat id is a namespacing key. */
    const harness = makeExecutableResumer(approvedRow('approved', {
      approvalOrigin: 'gateway',
      sourceChannel: 'web',
      requesterLarkOpenId: null,
      tenantKey: null,
      statusMessageId: null,
      execution: { version: 1, threadId: 'web_abcd1234', runId: 'run-1', actionId: 'act-1' },
    }), {
      resolveByUserId: async () => ok({
        userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'web',
        larkOpenId: null, activeDepartmentId: 'dept-1',
      }),
    });

    await harness.service.resume('approval-1', 'approved');

    assert.equal(harness.webTurns.length, 1);
    assert.equal(harness.webTurns[0].chatId, 'web_abcd1234');
    assert.equal(harness.webTurns[0].role, 'assistant');
    assert.match(harness.webTurns[0].text, /Approved action completed/);
    // Keyed on the approval, so a card and a browser racing leave one message.
    assert.equal(harness.webTurns[0].metadata.dedupeKey, 'approval:approval-1:outcome');
    // And nothing was posted into Lark for a run that never lived there.
    assert.deepEqual(harness.finalTexts, []);
  });

  it('tells a web thread when its approval was refused', async () => {
    const harness = makeExecutableResumer(approvedRow('rejected', {
      approvalOrigin: 'gateway',
      sourceChannel: 'web',
      requesterLarkOpenId: null,
      tenantKey: null,
      statusMessageId: null,
      execution: { version: 1, threadId: 'web_abcd1234', runId: 'run-1', actionId: 'act-1' },
    }), {
      resolveByUserId: async () => ok({
        userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'web',
        larkOpenId: null, activeDepartmentId: 'dept-1',
      }),
    });

    await harness.service.resume('approval-1', 'rejected');

    assert.equal(harness.webTurns.length, 1);
    assert.match(harness.webTurns[0].text, /not approved/);
    assert.deepEqual(harness.executed, []);
  });

  it('stays silent for a web approval with no thread to answer into', async () => {
    /* A gateway approval with no execution context has no conversation this
       could land in. Silence is right; inventing a thread id would put an
       answer in front of the wrong reader. */
    const harness = makeExecutableResumer(approvedRow('approved', {
      approvalOrigin: 'gateway',
      sourceChannel: 'web',
      requesterLarkOpenId: null,
      tenantKey: null,
      statusMessageId: null,
      execution: null,
    }), {
      resolveByUserId: async () => ok({
        userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'web',
        larkOpenId: null, activeDepartmentId: 'dept-1',
      }),
    });

    await harness.service.resume('approval-1', 'approved');

    assert.deepEqual(harness.webTurns, []);
    assert.deepEqual(harness.finalTexts, []);
  });
});
