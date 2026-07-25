/**
 * Working context is per thread; ambient room context is per chat.
 *
 * The pure key function is covered in tests/domain/conversation-key.test.ts.
 * What this file proves is that the engine actually uses it — that a turn's
 * history reads and writes carry the thread key while delivery and the room
 * transcript keep using the bare chat ID. Those are different keys for the
 * same run, and only an engine-level test shows both at once.
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
}

async function runTurn(
  observed: Observed,
  message: {
    messageId: string;
    rootMessageId?: string;
    threadId?: string;
    text: string;
    userExternalId?: string;
  },
): Promise<void> {
  // A run with no permitted tools short-circuits before history is ever loaded,
  // so the turn has to be genuinely runnable for this file to observe anything.
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
    messageId: asMessageId(message.messageId),
    chatId: asChatId(CHAT_ID),
    chatType: 'group',
    userExternalId: message.userExternalId ?? 'ou_alice',
    text: message.text,
    attachments: [],
    timestamp: '2026-07-26T00:00:00.000Z',
    traceId: asCorrelationId(`corr-${message.messageId}`),
    mentions: [],
    mentionsSelf: true,
    raw: {},
    ...(message.rootMessageId ? { rootMessageId: asMessageId(message.rootMessageId) } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
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
    toolRegistry: { forRuntime: () => [tool] } as unknown as OrchestrationEngineDeps['toolRegistry'],
    history: {
      loadWindow: async (key: unknown) => {
        observed.loadedKeys.push(String(key));
        return ok({ turns: [], truncated: false, tokenEstimate: 0 });
      },
      appendTurn: async (key: unknown) => {
        observed.appendedKeys.push(String(key));
      },
    } as unknown as OrchestrationEngineDeps['history'],
    chatContext: {
      loadContext: async (_companyId: string, chatId: string) => {
        observed.roomContextChatIds.push(chatId);
        return ok({ summary: null, recentMessages: [], totalMessageCount: 0 });
      },
    } as unknown as OrchestrationEngineDeps['chatContext'],
    supervisor: {
      run: async () => ok({
        finalReply: { kind: 'final', text: 'done', format: 'text' },
        toolsCalled: [],
        toolResults: [],
      }),
      getModel: () => { throw new Error('not used'); },
    } as unknown as OrchestrationEngineDeps['supervisor'],
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

    await runTurn(observed, { messageId: 'om_a2', rootMessageId: 'om_alice', text: 'hello' });

    // Room-level ambient context is deliberately shared: it is what everyone in
    // the room already said out loud. Only the working context is partitioned.
    assert.deepEqual(observed.roomContextChatIds, [CHAT_ID]);
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
