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

function approvedRow(status: 'approved' | 'rejected' = 'approved') {
  return {
    id: 'approval-1',
    status,
    toolId: 'larkDoc',
    actionGroup: 'create',
    payloadJson: {
      toolId: 'larkDoc',
      action: 'create',
      args: { title: 'Approved document' },
      argsHash: 'exact-args-hash',
    },
    metadataJson: {
      chatId: 'chat-1',
      requesterId: 'user-1',
      requesterLarkOpenId: 'ou-user-1',
      statusMessageId: 'status-1',
      departmentId: 'dept-1',
      execution: null,
    },
  } as any;
}

describe('ApprovalResumerService', () => {
  it('executes the stored approved tool call without re-entering the agent loop', async () => {
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
    const service = new ApprovalResumerService({
      approvalRepo: {
        findById: async () => ok(approvedRow()),
        failApprovedExecution: async () => ok(undefined),
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
      channelIdentityRepo: {
        resolveByLarkOpenId: async () => ok({
          userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark',
          larkOpenId: 'ou-user-1', activeDepartmentId: 'dept-1',
        }),
      } as any,
      approvalGate: {
        check: async () => ({ kind: 'allowed', executionGrant: { approvalId: 'approval-1' } }),
        completeExecution: async (_grant: unknown, result: unknown) => { completions.push(result); },
        failExecution: async () => {},
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

    await service.resume('approval-1', 'approved');

    assert.deepEqual(executed, [{ title: 'Approved document' }]);
    assert.equal(completions.length, 1);
    assert.match(finalTexts[0] ?? '', /Approved action completed/);
    assert.match(finalTexts[0] ?? '', /documentUrl/);
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
