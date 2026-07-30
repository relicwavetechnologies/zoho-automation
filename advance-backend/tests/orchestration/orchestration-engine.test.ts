import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { OrchestrationEngine } from '../../src/application/orchestration/engine/core.ts';
import type { OrchestrationEngineDeps } from '../../src/application/orchestration/engine/core.ts';
import { ok, err } from '../../src/shared/result.ts';
import { OrchestrationError } from '../../src/shared/errors.ts';
import { asUserFacing } from '../../src/shared/user-facing-error.ts';
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
import type { Tool } from '../../src/application/tools/tool.contract.ts';
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
  it('starts context and lets a zero-tool Lark greeting reach the supervisor', async () => {
    const started: string[] = [];
    const loggerEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const perm: PermissionResult = {
      allowedToolIds: new Set(),
      allowedActionsByTool: new Map(),
      decisions: [],
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
      text: 'hello',
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
      }, {
        id: 'msg-1',
        senderOpenId: 'ou_1',
        senderName: 'Invoker',
        role: 'user',
        content: 'raw current message',
        createdAt: '2026-05-14T00:00:01.000Z',
        botMentioned: true,
        attachments: [{
          type: 'image',
          status: 'ready',
          label: 'current chart',
          text: 'current attachment OCR',
        }],
      }],
      totalMessageCount: 2,
    };
    const deps: OrchestrationEngineDeps = {
      permissions: {
        resolve: async () => ok(perm),
      } as unknown as OrchestrationEngineDeps['permissions'],
      toolRegistry: {
        forRuntime: () => [],
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
          assert.doesNotMatch(input.groupContext ?? '', /raw current message|current attachment OCR/);
          assert.deepEqual(input.history.turns, []);
          assert.equal(input.userMessage, 'hello');
          assert.deepEqual(input.permittedTools, []);
          assert.equal((input.model as { modelId?: string } | undefined)?.modelId, 'deepseek-v4-pro');
          assert.equal(typeof input.resolveModel, 'function');
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
      larkInference: {
        createModel: () => ({ modelId: 'deepseek-v4-pro' }),
      } as unknown as NonNullable<OrchestrationEngineDeps['larkInference']>,
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

  it('redacts voice-derived telemetry and persistence without hiding it from the supervisor', async () => {
    const transcript = 'SECRET_VOICE_TRANSCRIPT list my tasks';
    const loggerEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const appendedTurns: Array<{ role: string; content: string }> = [];
    const memoryExtractions: Array<{ userMessage: string }> = [];
    const incoming: IncomingMessage = {
      channel: 'lark',
      messageId: asMessageId('msg-voice'),
      chatId: asChatId('chat-voice'),
      chatType: 'p2p',
      userExternalId: 'ou_1',
      text: transcript,
      attachments: [{ type: 'audio', fileKey: 'file_voice_1', mimeType: 'audio/ogg' }],
      timestamp: '2026-05-14T00:00:00.000Z',
      traceId: asCorrelationId('corr-voice'),
      mentions: [],
      mentionsSelf: true,
      raw: {},
    };
    const conversation: ConversationHandle = {
      channel: 'lark',
      chatId: incoming.chatId,
      correlationId: incoming.traceId,
    };
    const channelAdapter: ChannelAdapter = {
      key: 'lark',
      parseIncoming: () => ok(incoming),
      sendStatus: async () => ok({
        channel: 'lark',
        messageId: asMessageId('status-voice'),
        correlationId: incoming.traceId,
      }),
      editStatus: async handle => ok(handle),
      sendFinalReply: async () => ok({
        channel: 'lark',
        messageId: asMessageId('reply-voice'),
      }),
    };
    const deps: OrchestrationEngineDeps = {
      permissions: {
        resolve: async () => ok({
          allowedToolIds: new Set(),
          allowedActionsByTool: new Map(),
          decisions: [],
        }),
      } as unknown as OrchestrationEngineDeps['permissions'],
      toolRegistry: {
        forRuntime: () => [],
      } as unknown as OrchestrationEngineDeps['toolRegistry'],
      history: {
        loadWindow: async () => ok({ turns: [], truncated: false, tokenEstimate: 0 }),
        appendTurn: async (_key: unknown, turn: { role: string; content: string }) => {
          appendedTurns.push(turn);
        },
      } as unknown as OrchestrationEngineDeps['history'],
      mem0: {
        searchForContext: async () => undefined,
        extractAndStore: async (input: { userMessage: string }) => {
          memoryExtractions.push(input);
          return { attemptedScopes: [], storedMemories: 0, scopes: [] };
        },
      } as unknown as OrchestrationEngineDeps['mem0'],
      supervisor: {
        run: async input => {
          assert.equal(input.userMessage, transcript);
          return ok({
            finalReply: { kind: 'final', text: 'done', format: 'text' },
            toolsCalled: [],
            toolResults: [],
          });
        },
        getModel: () => { throw new Error('not used'); },
      } as unknown as OrchestrationEngineDeps['supervisor'],
      larkInference: {
        createModel: () => ({ modelId: 'deepseek-v4-pro' }),
      } as unknown as NonNullable<OrchestrationEngineDeps['larkInference']>,
      logger: createLogger(loggerEvents),
      clock,
    };

    const result = await new OrchestrationEngine(deps).run({
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

    assert.equal(result.ok, true);
    assert.equal(
      loggerEvents.find(entry => entry.event === 'engine.run.start')?.data?.['userMessage'],
      '[voice transcript redacted]',
    );
    assert.doesNotMatch(JSON.stringify(loggerEvents), /SECRET_VOICE_TRANSCRIPT/);
    assert.match(appendedTurns[0]?.content ?? '', /Voice note transcript omitted after processing/);
    assert.doesNotMatch(appendedTurns[0]?.content ?? '', /SECRET_VOICE_TRANSCRIPT/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      memoryExtractions[0]?.userMessage,
      '[Voice note transcript omitted after processing.]',
    );
  });

  /**
   * The engine's reply when the supervisor fails. Two cases matter and they
   * pull in opposite directions: a policy refusal is the answer and must be
   * shown, while an ordinary failure carries internals and must not be.
   */
  async function replyForSupervisorError(error: unknown): Promise<string> {
    const toolId = asToolId('larkTask');
    const perm: PermissionResult = {
      allowedToolIds: new Set([toolId]),
      allowedActionsByTool: new Map([[toolId, new Set(['read'])]]),
      decisions: [],
    };
    const tool: Tool<unknown, unknown> = {
      id: toolId, family: 'lark', actionGroups: new Set(['read']),
      argsSchema: z.unknown(), resultSchema: z.unknown(),
      description: 'test tool', parameterDocs: '',
      permissionCheck: () => ok('read'), execute: async () => ok({}),
    };
    const conversation: ConversationHandle = {
      channel: 'lark', chatId: asChatId('chat-1'), correlationId: asCorrelationId('corr-1'),
    };
    const incoming: IncomingMessage = {
      channel: 'lark', messageId: asMessageId('msg-1'), chatId: asChatId('chat-1'),
      chatType: 'p2p', userExternalId: 'ou_1', text: 'hello', attachments: [],
      timestamp: '2026-05-14T00:00:00.000Z', traceId: asCorrelationId('corr-1'),
      mentions: [], mentionsSelf: true, raw: {},
    };
    let sent = '';
    const channelAdapter: ChannelAdapter = {
      key: 'lark',
      parseIncoming: () => ok(incoming),
      sendStatus: async () => ok({
        channel: 'lark', messageId: asMessageId('status-1'), correlationId: asCorrelationId('corr-1'),
      } as StatusHandle),
      editStatus: async () => ok({
        channel: 'lark', messageId: asMessageId('status-1'), correlationId: asCorrelationId('corr-1'),
      } as StatusHandle),
      sendFinalReply: async (_c, reply) => {
        sent = reply.text;
        return ok({ channel: 'lark', messageId: asMessageId('reply-1') });
      },
    };
    const deps: OrchestrationEngineDeps = {
      permissions: { resolve: async () => ok(perm) } as unknown as OrchestrationEngineDeps['permissions'],
      toolRegistry: { forRuntime: () => [tool] } as unknown as OrchestrationEngineDeps['toolRegistry'],
      history: {
        loadWindow: async () => ok({ turns: [], truncated: false, tokenEstimate: 0 }),
        appendTurn: async () => undefined,
      } as unknown as OrchestrationEngineDeps['history'],
      supervisor: {
        run: async () => err(new OrchestrationError({
          stage: 'plan',
          reason: 'llm_invalid_output',
          message: 'Supervisor LLM failed',
          cause: error,
        })),
        getModel: () => { throw new Error('not used'); },
      } as unknown as OrchestrationEngineDeps['supervisor'],
      logger: createLogger([]),
      clock,
    };

    await new OrchestrationEngine(deps).run({
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
    return sent;
  }

  it('shows a policy refusal instead of a generic apology', async () => {
    const denied = asUserFacing(
      new Error('denied'),
      'Model deepseek-v4-pro is not enabled for this account.',
    );

    const reply = await replyForSupervisorError(denied);

    // "Something went wrong, please try again" sends the user to retry
    // something that will never work, and an engineer to read logs for
    // something that is not a bug.
    assert.match(reply, /not enabled for this account/);
  });

  it('stays generic for a failure the user cannot act on', async () => {
    const reply = await replyForSupervisorError(new Error('ECONNRESET at 10.0.0.4:5432'));

    assert.equal(reply, 'Something went wrong. Please try again.');
    assert.ok(!reply.includes('10.0.0.4'), 'internals never reach the chat');
  });

});
