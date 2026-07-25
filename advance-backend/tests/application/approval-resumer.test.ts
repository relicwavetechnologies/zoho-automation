import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { ApprovalResumerService } from '../../src/application/approval/approval-resumer.service.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
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
  registry.register({
    id: asToolId('larkDoc'),
    family: 'lark',
    actionGroups: new Set(['create']),
    argsSchema: z.object({ title: z.string() }),
    resultSchema: z.unknown(),
    description: 'Create a Lark document',
    permissionCheck: () => ok('create'),
    execute: async (args: unknown) => {
      executed.push(args);
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
  const finalTexts: string[] = [];
  let resumedChatId: string | undefined;
  const service = new ApprovalResumerService({
    approvalRepo: {
      findById: async () => ok(row),
      failApprovedExecution: async () => ok(true),
      persistResult: async () => ok(undefined),
    } as any,
    larkAdapter: {
      restoreStatusCoordinator: () => {},
      sendStatus: async () => ok({}),
      sendFinalReply: async (_conversation: unknown, reply: { text: string }) => {
        finalTexts.push(reply.text);
        return ok({});
      },
    } as any,
    channelIdentityRepo: channelIdentityRepo as any,
    approvalGate: {
      check: async (input: { chatId: string }) => {
        resumedChatId = input.chatId;
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
    finalTexts,
    getResumedChatId: () => resumedChatId,
  };
}

describe('ApprovalResumerService', () => {
  it('executes the stored approved tool call without re-entering the agent loop', async () => {
    let resolvedTenantKey: string | undefined;
    const harness = makeExecutableResumer(approvedRow(), {
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
    assert.match(harness.finalTexts[0] ?? '', /Approved action completed/);
    assert.match(harness.finalTexts[0] ?? '', /documentUrl/);
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
