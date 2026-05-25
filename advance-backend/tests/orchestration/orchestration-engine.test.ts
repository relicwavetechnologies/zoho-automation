import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { OrchestrationEngine } from '../../src/application/orchestration/engine/core.ts';
import type { OrchestrationEngineDeps } from '../../src/application/orchestration/engine/core.ts';
import { ok } from '../../src/shared/result.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { Clock } from '../../src/shared/clock.ts';
import {
  asChatId,
  asCompanyId,
  asCorrelationId,
  asMessageId,
  asToolId,
  asUserId,
} from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { ChannelAdapter, ConversationHandle, StatusHandle } from '../../src/application/channels/channel.adapter.ts';
import type { IncomingMessage } from '../../src/domain/channel/incoming-message.ts';
import type { GroupChatWindow } from '../../src/domain/conversation/group-context.ts';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function createLogger(events: Array<{ event: string; data?: Record<string, unknown> }>): Logger {
  return {
    debug: (event, data) => events.push({ event, data }),
    info:  (event, data) => events.push({ event, data }),
    warn:  (event, data) => events.push({ event, data }),
    error: (event, data) => events.push({ event, data }),
    child: () => createLogger(events),
  };
}

const clock: Clock = {
  now: () => new Date('2026-05-14T00:00:00.000Z'),
  nowMs: () => Date.now(),
};

describe('OrchestrationEngine', () => {
  it('starts status, history, memory, and group context before invoking supervisor', async () => {
    const started: string[] = [];
    const loggerEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const toolId = asToolId('larkTask');
    const perm: PermissionResult = {
      allowedToolIds: new Set([toolId]),
      allowedActionsByTool: new Map([[toolId, new Set(['read'])]]),
      decisions: [],
    };
    const tool: Tool<unknown, unknown> = {
      id: toolId,
      family: 'lark',
      actionGroups: new Set(['read']),
      argsSchema: z.unknown(),
      resultSchema: z.unknown(),
      description: 'test tool',
      parameterDocs: '',
      permissionCheck: () => ok('read'),
      execute: async () => ok({}),
    };
    const conversation: ConversationHandle = {
      channel: 'lark',
      chatId: asChatId('chat-1'),
      correlationId: asCorrelationId('corr-1'),
    };
    const statusHandle: StatusHandle = {
      channel: 'lark',
      messageId: asMessageId('status-1'),
      correlationId: asCorrelationId('corr-1'),
    };
    const incoming: IncomingMessage = {
      channel: 'lark',
      messageId: asMessageId('msg-1'),
      chatId: asChatId('chat-1'),
      chatType: 'group',
      userExternalId: 'ou_1',
      text: 'list my tasks',
      attachments: [],
      timestamp: '2026-05-14T00:00:00.000Z',
      traceId: asCorrelationId('corr-1'),
      mentions: [],
      mentionsSelf: true,
      raw: {},
    };

    const channelAdapter: ChannelAdapter = {
      key: 'lark',
      parseIncoming: () => ok(incoming),
      sendStatus: async () => {
        started.push('status');
        await wait(25);
        return ok(statusHandle);
      },
      editStatus: async () => ok(statusHandle),
      sendFinalReply: async () => ok({
        channel: 'lark',
        messageId: asMessageId('reply-1'),
      }),
    };
    const groupContext: GroupChatWindow = {
      summary: null,
      recentMessages: [{
        id: 'm1',
        senderOpenId: 'ou_2',
        senderName: 'Alice',
        role: 'user',
        content: 'Please track these tasks.',
        createdAt: '2026-05-14T00:00:00.000Z',
        botMentioned: false,
      }],
      totalMessageCount: 1,
    };
    const deps: OrchestrationEngineDeps = {
      permissions: {
        resolve: async () => ok(perm),
      } as unknown as OrchestrationEngineDeps['permissions'],
      toolRegistry: {
        forRuntime: () => [tool],
      } as unknown as OrchestrationEngineDeps['toolRegistry'],
      history: {
        loadWindow: async () => {
          started.push('history');
          await wait(25);
          return ok({ turns: [], truncated: false, tokenEstimate: 0 });
        },
        appendTurn: async () => undefined,
      } as unknown as OrchestrationEngineDeps['history'],
      mem0: {
        searchForContext: async () => {
          started.push('memory');
          await wait(25);
          return 'remembered context';
        },
        extractAndStore: async () => ({ attemptedScopes: [], storedMemories: 0, scopes: [] }),
      } as unknown as OrchestrationEngineDeps['mem0'],
      chatContext: {
        loadContext: async () => {
          started.push('group');
          await wait(25);
          return ok(groupContext);
        },
      } as unknown as OrchestrationEngineDeps['chatContext'],
      supervisor: {
        run: async input => {
          started.push('supervisor');
          assert.equal(input.memoryContext, 'remembered context');
          assert.ok(input.groupContext?.includes('Alice'));
          return ok({
            finalReply: { kind: 'final', text: 'done', format: 'text' },
            toolsCalled: [],
            toolResults: [],
          });
        },
        getModel: () => {
          throw new Error('not used');
        },
      } as unknown as OrchestrationEngineDeps['supervisor'],
      logger: createLogger(loggerEvents),
      clock,
    };

    const runPromise = new OrchestrationEngine(deps).run({
      incoming,
      runContext: {
        companyId: asCompanyId('company-1'),
        userId: asUserId('user-1'),
        companyRole: asCompanyRoleSlug('MEMBER'),
        channel: 'lark',
      },
      conversation,
      channelAdapter,
    });

    await wait(5);

    assert.deepEqual(new Set(started), new Set(['status', 'history', 'memory', 'group']));
    assert.equal(started.includes('supervisor'), false);

    const result = await runPromise;
    assert.equal(result.ok, true);
    assert.equal(started.at(-1), 'supervisor');
    assert.ok(loggerEvents.some(entry => entry.event === 'engine.pre_supervisor.duration'));
  });
});
