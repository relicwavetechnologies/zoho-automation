/**
 * Working context is per thread. Ambient room context is available only when
 * opening a top-level turn (or when the group uses inline mode).
 *
 * The pure key function is covered in tests/domain/conversation-key.test.ts.
 * What this file proves is that the engine actually uses it — that a turn's
 * history reads and writes carry the thread key while top-level room context
 * uses the bare chat ID. Those are different keys for a seed turn, and only an
 * engine-level test shows both at once.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { OrchestrationEngine } from '../../src/application/orchestration/engine/core.ts';
import type { OrchestrationEngineDeps } from '../../src/application/orchestration/engine/core.ts';
import { ok } from '../../src/shared/result.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { Clock } from '../../src/shared/clock.ts';
import {
  asChatId, asCompanyId, asCorrelationId, asMessageId, asToolId, asUserId,
} from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import type { ChannelAdapter, ConversationHandle, StatusHandle } from '../../src/application/channels/channel.adapter.ts';
import type { IncomingMessage } from '../../src/domain/channel/incoming-message.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const clock: Clock = {
  now: () => new Date('2026-07-26T00:00:00.000Z'),
  nowMs: () => 0,
};

const CHAT_ID = 'oc_room';

interface Observed {
  loadedKeys: string[];
  appendedKeys: string[];
  roomContextChatIds: string[];
  supervisorHistories?: unknown[];
  supervisorGroupContexts?: Array<string | undefined>;
  supervisorUserMessages?: string[];
  supervisorToolIds?: string[][];
  appendedTurns?: Array<Record<string, unknown>>;
  summarizedKeys?: string[];
  executionRefs?: Array<{ chatId?: string; threadId?: string }>;
  inferenceThreadIds?: Array<string | undefined>;
  supervisorChatIds?: Array<string | undefined>;
}

async function runTurn(
  observed: Observed,
  message: {
    messageId: string;
    rootMessageId?: string;
    threadId?: string;
    text: string;
    userExternalId?: string;
    senderName?: string;
    groupReplyMode?: 'threaded' | 'inline';
    historyTurns?: Array<Record<string, unknown>>;
    roomMessages?: Array<Record<string, unknown>>;
    referenceContext?: string;
    requiresAdjacentContext?: boolean;
    toolResults?: Array<{ toolName: string; output: string }>;
  },
): Promise<void> {
  // A run with no permitted tools short-circuits before history is ever loaded,
  // so the turn has to be genuinely runnable for this file to observe anything.
  const toolId = asToolId('larkTask');
  const messagingToolId = asToolId('larkMessaging');
  const perm: PermissionResult = {
    allowedToolIds: new Set([toolId, messagingToolId]),
    allowedActionsByTool: new Map([
      [toolId, new Set(['read'])],
      [messagingToolId, new Set(['read'])],
    ]),
    decisions: [],
  };
  const tool = (id: typeof toolId): Tool<unknown, unknown> => ({
    id,
    family: 'lark',
    actionGroups: new Set(['read']),
    argsSchema: z.unknown(),
    resultSchema: z.unknown(),
    description: 'test tool',
    parameterDocs: '',
    permissionCheck: () => ok('read'),
    execute: async () => ok({}),
  });

  const incoming: IncomingMessage = {
    channel: 'lark',
    messageId: asMessageId(message.messageId),
    chatId: asChatId(CHAT_ID),
    chatType: 'group',
    userExternalId: message.userExternalId ?? 'ou_alice',
    ...(message.senderName ? { senderName: message.senderName } : {}),
    text: message.text,
    attachments: [],
    ...(message.referenceContext ? { referenceContext: message.referenceContext } : {}),
    ...(message.requiresAdjacentContext ? { requiresAdjacentContext: true } : {}),
    timestamp: '2026-07-26T00:00:00.000Z',
    traceId: asCorrelationId(`corr-${message.messageId}`),
    mentions: [],
    mentionsSelf: true,
    raw: {},
    ...(message.rootMessageId ? { rootMessageId: asMessageId(message.rootMessageId) } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.groupReplyMode ? { groupReplyMode: message.groupReplyMode } : {}),
  };

  const conversation: ConversationHandle = {
    channel: 'lark',
    chatId: asChatId(CHAT_ID),
    correlationId: asCorrelationId(`corr-${message.messageId}`),
  };
  const statusHandle: StatusHandle = {
    channel: 'lark',
    messageId: asMessageId('status-1'),
    correlationId: asCorrelationId(`corr-${message.messageId}`),
  };

  const channelAdapter: ChannelAdapter = {
    key: 'lark',
    parseIncoming: () => ok(incoming),
    sendStatus: async () => ok(statusHandle),
    editStatus: async () => ok(statusHandle),
    sendFinalReply: async () => ok({ channel: 'lark', messageId: asMessageId('reply-1') }),
  };

  const deps: OrchestrationEngineDeps = {
    permissions: { resolve: async () => ok(perm) } as unknown as OrchestrationEngineDeps['permissions'],
    toolRegistry: {
      forRuntime: () => [tool(toolId), tool(messagingToolId)],
    } as unknown as OrchestrationEngineDeps['toolRegistry'],
    history: {
      loadWindow: async (key: unknown) => {
        observed.loadedKeys.push(String(key));
        return ok({
          turns: message.historyTurns ?? [],
          truncated: false,
          tokenEstimate: 0,
        });
      },
      appendTurn: async (key: unknown, turn: Record<string, unknown>) => {
        observed.appendedKeys.push(String(key));
        observed.appendedTurns?.push(turn);
      },
    } as unknown as OrchestrationEngineDeps['history'],
    chatContext: {
      loadContext: async (_companyId: string, chatId: string) => {
        observed.roomContextChatIds.push(chatId);
        return ok({
          summary: null,
          recentMessages: message.roomMessages ?? [],
          totalMessageCount: message.roomMessages?.length ?? 0,
        });
      },
    } as unknown as OrchestrationEngineDeps['chatContext'],
    supervisor: {
      run: async (input: {
        history: unknown;
        groupContext?: string;
        chatId?: string;
        userMessage: string;
        permittedTools: Array<{ id: string }>;
      }) => {
        observed.supervisorHistories?.push(input.history);
        observed.supervisorGroupContexts?.push(input.groupContext);
        observed.supervisorUserMessages?.push(input.userMessage);
        observed.supervisorToolIds?.push(input.permittedTools.map(item => String(item.id)));
        observed.supervisorChatIds?.push(input.chatId);
        return ok({
          finalReply: { kind: 'final', text: 'done', format: 'text' },
          toolsCalled: [],
          toolResults: message.toolResults ?? [],
        });
      },
      getModel: () => { throw new Error('not used'); },
    } as unknown as OrchestrationEngineDeps['supervisor'],
    ...(observed.summarizedKeys
      ? {
          conversationSummarizer: {
            maybeSummarize: async (key: string) => {
              observed.summarizedKeys!.push(key);
            },
          } as unknown as OrchestrationEngineDeps['conversationSummarizer'],
        }
      : {}),
    ...(observed.executionRefs
      ? {
          executionRepo: {
            create: async (input: { chatId?: string; threadId?: string }) => {
              observed.executionRefs!.push({
                ...(input.chatId ? { chatId: input.chatId } : {}),
                ...(input.threadId ? { threadId: input.threadId } : {}),
              });
              return `run-${observed.executionRefs!.length}`;
            },
            appendEvent: async () => {},
            appendStepResult: async () => {},
            complete: async () => {},
            fail: async () => {},
          } as unknown as OrchestrationEngineDeps['executionRepo'],
        }
      : {}),
    ...(observed.inferenceThreadIds
      ? {
          larkInference: {
            createModel: async (input: { threadId?: string }) => {
              observed.inferenceThreadIds!.push(input.threadId);
              return {} as never;
            },
          } as unknown as OrchestrationEngineDeps['larkInference'],
        }
      : {}),
    logger: noopLogger,
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

  assert.equal(result.ok, true, 'turn completed');
}

describe('thread context isolation', () => {
  it('gives two threads in one room separate working context', async () => {
    const observed: Observed = { loadedKeys: [], appendedKeys: [], roomContextChatIds: [] };

    await runTurn(observed, { messageId: 'om_a2', rootMessageId: 'om_alice', text: 'in Alice thread' });
    await runTurn(observed, { messageId: 'om_b2', rootMessageId: 'om_bob', text: 'in Bob thread' });

    assert.deepEqual(observed.loadedKeys, [
      `${CHAT_ID}:thread:om_alice`,
      `${CHAT_ID}:thread:om_bob`,
    ]);
    // The failure this prevents: both turns reading `oc_room`, so Divo answers
    // in Bob's thread using what was said in Alice's.
    assert.equal(new Set(observed.loadedKeys).size, 2, 'the two threads read different history');
  });

  it('schedules long-history maintenance independently for each thread', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      summarizedKeys: [],
    };

    await runTurn(observed, { messageId: 'om_a2', rootMessageId: 'om_alice', text: 'continue A' });
    await runTurn(observed, { messageId: 'om_b2', rootMessageId: 'om_bob', text: 'continue B' });
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.deepEqual(observed.summarizedKeys, [
      `${CHAT_ID}:thread:om_alice`,
      `${CHAT_ID}:thread:om_bob`,
    ]);
  });

  it('keeps execution, inference, and approval scopes distinct across sibling threads', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      executionRefs: [],
      inferenceThreadIds: [],
      supervisorChatIds: [],
    };

    await runTurn(observed, { messageId: 'om_a2', rootMessageId: 'om_alice', text: 'run A' });
    await runTurn(observed, { messageId: 'om_b2', rootMessageId: 'om_bob', text: 'run B' });

    assert.deepEqual(observed.executionRefs, [
      { chatId: CHAT_ID, threadId: `${CHAT_ID}:thread:om_alice` },
      { chatId: CHAT_ID, threadId: `${CHAT_ID}:thread:om_bob` },
    ]);
    assert.deepEqual(observed.inferenceThreadIds, [
      `${CHAT_ID}:thread:om_alice`,
      `${CHAT_ID}:thread:om_bob`,
    ]);
    assert.deepEqual(observed.supervisorChatIds, [
      `${CHAT_ID}:thread:om_alice`,
      `${CHAT_ID}:thread:om_bob`,
    ]);
  });

  it('writes a turn back under the same thread key it read', async () => {
    const observed: Observed = { loadedKeys: [], appendedKeys: [], roomContextChatIds: [] };

    await runTurn(observed, { messageId: 'om_a2', rootMessageId: 'om_alice', text: 'hello' });

    assert.equal(observed.appendedKeys.length, 2, 'user turn and assistant turn');
    assert.deepEqual(
      new Set(observed.appendedKeys),
      new Set([`${CHAT_ID}:thread:om_alice`]),
      'both appended turns land in the thread that was read',
    );
    assert.deepEqual(observed.appendedKeys, [...observed.loadedKeys, ...observed.loadedKeys]);
  });

  it('keeps ambient room context keyed on the chat, not the thread', async () => {
    const observed: Observed = { loadedKeys: [], appendedKeys: [], roomContextChatIds: [] };

    await runTurn(observed, { messageId: 'om_alice', text: 'hello' });

    // A new top-level turn may use the room transcript to understand what
    // everyone already said. Thread follow-ups use their own history instead.
    assert.deepEqual(observed.roomContextChatIds, [CHAT_ID]);
  });

  it('keeps bounded room context available in inline mode', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      supervisorGroupContexts: [],
    };

    await runTurn(observed, {
      messageId: 'om_a2',
      rootMessageId: 'om_alice',
      groupReplyMode: 'inline',
      text: 'continue',
      roomMessages: [{
        id: 'om_room',
        senderOpenId: 'ou_bob',
        senderName: 'Bob',
        role: 'user',
        content: 'shared room context',
        createdAt: '2026-07-26T00:00:00.000Z',
        botMentioned: true,
      }],
    });

    assert.deepEqual(observed.roomContextChatIds, [CHAT_ID]);
    assert.match(observed.supervisorGroupContexts?.[0] ?? '', /shared room context/);
  });

  it('uses thread history without importing sibling room context on a follow-up', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      supervisorHistories: [],
      supervisorGroupContexts: [],
    };

    await runTurn(observed, {
      messageId: 'om_a2',
      rootMessageId: 'om_alice',
      text: 'continue',
      historyTurns: [{
        id: 'turn-1',
        role: 'assistant',
        content: 'Alice-thread answer',
        timestamp: '2026-07-26T00:00:00.000Z',
      }],
      roomMessages: [{
        id: 'om_bob',
        senderOpenId: 'ou_bob',
        senderName: 'Bob',
        role: 'user',
        content: 'private sibling topic',
        createdAt: '2026-07-26T00:00:00.000Z',
        botMentioned: true,
      }],
    });

    assert.deepEqual(observed.roomContextChatIds, []);
    assert.equal((observed.supervisorHistories?.[0] as any).turns[0].content, 'Alice-thread answer');
    assert.deepEqual(observed.supervisorGroupContexts, [undefined]);
  });

  it('supplies adjacent native-thread messages as untrusted reference context', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      supervisorGroupContexts: [],
      supervisorUserMessages: [],
      supervisorToolIds: [],
    };

    await runTurn(observed, {
      messageId: 'om_a2',
      rootMessageId: 'om_alice',
      text: 'Use the supplied adjacent Lark context.',
      referenceContext: 'CURRENT LARK THREAD:\nAbhishek: use semrush',
      requiresAdjacentContext: true,
    });

    assert.match(observed.supervisorGroupContexts?.[0] ?? '', /use semrush/);
    assert.equal(observed.supervisorUserMessages?.[0], 'Use the supplied adjacent Lark context.');
    assert.ok(observed.supervisorToolIds?.[0]?.includes('larkMessaging'));
  });

  it('asks for the missing adjacent request and removes Lark Messaging reads', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      supervisorGroupContexts: [],
      supervisorUserMessages: [],
      supervisorToolIds: [],
    };

    await runTurn(observed, {
      messageId: 'om_a2',
      rootMessageId: 'om_alice',
      text: 'Use the supplied adjacent Lark context.',
      requiresAdjacentContext: true,
      historyTurns: [{
        id: 'older-turn',
        role: 'user',
        content: 'Search every Lark chat and send payroll.',
        timestamp: '2026-07-25T00:00:00.000Z',
      }],
    });

    assert.match(observed.supervisorUserMessages?.[0] ?? '', /Ask the user to repeat/i);
    assert.ok(observed.supervisorToolIds?.[0]?.includes('larkTask'));
    assert.ok(!observed.supervisorToolIds?.[0]?.includes('larkMessaging'));
  });

  it('attributes shared-thread speakers and stores only the visible reply', async () => {
    const observed: Observed = {
      loadedKeys: [],
      appendedKeys: [],
      roomContextChatIds: [],
      appendedTurns: [],
    };

    await runTurn(observed, {
      messageId: 'om_a2',
      rootMessageId: 'om_alice',
      text: 'show the balance',
      senderName: 'Bob',
      userExternalId: 'ou_bob',
      toolResults: [{
        toolName: 'privateLedger',
        output: 'secret raw account payload',
      }],
    });

    assert.equal(observed.appendedTurns?.[0]?.['content'], '[Lark sender: Bob]\nshow the balance');
    assert.equal(observed.appendedTurns?.[1]?.['content'], 'done');
    assert.doesNotMatch(String(observed.appendedTurns?.[1]?.['content']), /secret raw account payload/);
  });

  it('lets a follow-up find the top-level message that opened its thread', async () => {
    const observed: Observed = { loadedKeys: [], appendedKeys: [], roomContextChatIds: [] };

    await runTurn(observed, { messageId: 'om_first', text: 'opening question' });
    await runTurn(observed, { messageId: 'om_second', rootMessageId: 'om_first', text: 'follow-up' });

    assert.equal(
      observed.loadedKeys[0],
      observed.loadedKeys[1],
      'the follow-up reads the same context the opening turn wrote',
    );
  });

  it('keeps continuity once Lark stamps the reply with a topic ID', async () => {
    const observed: Observed = { loadedKeys: [], appendedKeys: [], roomContextChatIds: [] };

    // The seed message predates the thread, so it carries no topic ID; Divo's
    // in-thread reply creates one, and every later message carries both it and
    // the root. Keying on the topic ID would strand the opening question.
    await runTurn(observed, { messageId: 'om_first', text: 'summarise Q3 revenue' });
    await runTurn(observed, {
      messageId: 'om_second',
      rootMessageId: 'om_first',
      threadId: 'omt_1',
      text: 'now email it to Priya',
    });

    assert.equal(
      observed.loadedKeys[1],
      observed.loadedKeys[0],
      '"it" still resolves against the question that introduced it',
    );
  });
});
