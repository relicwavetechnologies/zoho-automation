import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { LanguageModel } from 'ai';

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
          assert.doesNotMatch(input.groupContext ?? '', /raw current message|current attachment OCR/);
          assert.deepEqual(input.history.turns, []);
          assert.equal(input.userMessage, 'list my tasks');
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

  it('cancels fast-path model work and always releases the registered controller', async () => {
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
    const incoming: IncomingMessage = {
      channel: 'lark',
      messageId: asMessageId('msg-fast'),
      chatId: asChatId('chat-fast'),
      chatType: 'p2p',
      userExternalId: 'ou_1',
      text: 'hello',
      attachments: [],
      timestamp: '2026-05-14T00:00:00.000Z',
      traceId: asCorrelationId('corr-fast'),
      mentions: [],
      mentionsSelf: false,
      raw: {},
    };
    const conversation: ConversationHandle = {
      channel: 'lark',
      chatId: incoming.chatId,
      correlationId: incoming.traceId,
    };
    const modelStarted = Promise.withResolvers<void>();
    const fastPathModel = {
      provider: 'mock',
      modelId: 'abortable-fast-path',
      specificationVersion: 'v2',
      doGenerate: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        modelStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          abortSignal?.addEventListener(
            'abort',
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      },
      doStream: async () => { throw new Error('not used'); },
    } as unknown as LanguageModel;
    let registered = 0;
    let cleaned = 0;
    let finalReplies = 0;
    const channelAdapter = {
      key: 'lark',
      parseIncoming: () => ok(incoming),
      sendStatus: async () => ok({
        channel: 'lark',
        messageId: asMessageId('status-fast'),
        correlationId: incoming.traceId,
      }),
      editStatus: async handle => ok(handle),
      sendFinalReply: async () => {
        finalReplies++;
        return ok({ channel: 'lark', messageId: asMessageId('reply-fast') });
      },
      registerAbortController: () => { registered++; },
      cleanupAbortController: () => { cleaned++; },
    } as ChannelAdapter & {
      registerAbortController: () => void;
      cleanupAbortController: () => void;
    };
    const deps: OrchestrationEngineDeps = {
      permissions: {
        resolve: async () => ok(perm),
      } as unknown as OrchestrationEngineDeps['permissions'],
      toolRegistry: {
        forRuntime: () => [tool],
      } as unknown as OrchestrationEngineDeps['toolRegistry'],
      history: {
        loadWindow: async () => ok({ turns: [], truncated: false, tokenEstimate: 0 }),
        appendTurn: async () => undefined,
      } as unknown as OrchestrationEngineDeps['history'],
      supervisor: {
        run: async () => { throw new Error('not used'); },
        getModel: () => fastPathModel,
      } as unknown as OrchestrationEngineDeps['supervisor'],
      fastPathModel,
      logger: createLogger([]),
      clock,
    };
    const controller = new AbortController();

    const resultPromise = new OrchestrationEngine(deps).run({
      incoming,
      runContext: {
        companyId: asCompanyId('company-1'),
        userId: asUserId('user-1'),
        companyRole: asCompanyRoleSlug('MEMBER'),
        channel: 'lark',
      },
      conversation,
      channelAdapter,
      abortSignal: controller.signal,
    });

    await modelStarted.promise;
    controller.abort(new Error('lane timed out'));
    const result = await resultPromise;

    assert.equal(result.ok, false);
    assert.equal(registered, 1);
    assert.equal(cleaned, 1);
    assert.equal(finalReplies, 0);
  });
});
