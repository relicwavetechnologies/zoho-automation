import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';

import { processDesktopChatStart } from '../../src/http/desktop/desktop-ws.gateway.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

function makeWs() {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload); },
  } as unknown as WebSocket;
  return { ws, sent };
}

describe('desktop websocket chat runner', () => {
  it('turns chat.start into a desktop engine run and final done event', async () => {
    const { ws, sent } = makeWs();
    const createdMessages: any[] = [];
    let runtimeConversationUpsert: any;
    let capturedEngineInput: any;

    const prisma = {
      desktopThread: {
        findUnique: async () => ({
          id: 'thread-1',
          userId: 'user-1',
          companyId: 'company-1',
          departmentId: 'dept-1',
          title: 'New conversation',
          workspaceId: null,
          workspacePath: null,
          workspaceName: null,
        }),
        update: async () => ({}),
      },
      desktopWorkspace: {
        upsert: async () => ({
          id: 'workspace-1',
          userId: 'user-1',
          companyId: 'company-1',
          path: '/tmp/repo',
          name: 'repo',
          lastOpenedAt: new Date('2026-05-28T12:00:00.000Z'),
          createdAt: new Date('2026-05-28T12:00:00.000Z'),
          updatedAt: new Date('2026-05-28T12:00:00.000Z'),
        }),
      },
      desktopMessage: {
        create: async ({ data }: any) => {
          const row = {
            id: `desktop-message-${createdMessages.length + 1}`,
            threadId: data.threadId,
            role: data.role,
            content: data.content,
            metadata: data.metadata ?? null,
            createdAt: new Date('2026-05-28T12:00:00.000Z'),
          };
          createdMessages.push(row);
          return row;
        },
      },
      runtimeConversation: {
        upsert: async (args: any) => {
          runtimeConversationUpsert = args;
          return { id: 'runtime-conv-1' };
        },
      },
    };

    const engine = {
      run: async (input: any) => {
        capturedEngineInput = input;
        await input.channelAdapter.sendFinalReply(input.conversation, {
          kind: 'final',
          text: 'Desktop answer',
          format: 'markdown',
        });
        return ok({
          finalReply: { kind: 'final', text: 'Desktop answer', format: 'markdown' },
          toolsCalled: [],
        });
      },
    };

    await processDesktopChatStart({
      ws,
      session: {
        sessionId: 'session-1',
        userId: 'user-1',
        companyId: 'company-1',
        role: 'MEMBER',
        larkOpenId: 'ou_desktop_user',
        userEmail: 'user@example.com',
      },
      message: {
        type: 'chat.start',
        requestId: 'request-1',
        threadId: 'thread-1',
        message: 'Check Zoho books',
        workspace: { name: 'repo', path: '/tmp/repo' },
      },
      deps: {
        prisma: prisma as any,
        memberJwtSecret: 'secret',
        logger: noopLogger,
        engine: engine as any,
        chatSerializer: {} as any,
      },
      log: noopLogger,
    });

    assert.equal(createdMessages.length, 2);
    assert.equal(createdMessages[0].role, 'user');
    assert.equal(createdMessages[0].content, 'Check Zoho books');
    assert.equal(createdMessages[1].role, 'assistant');
    assert.equal(createdMessages[1].content, 'Desktop answer');

    assert.equal(runtimeConversationUpsert.create.channel, 'desktop');
    assert.equal(runtimeConversationUpsert.create.companyId, 'company-1');
    assert.equal(runtimeConversationUpsert.create.channelConversationKey, 'thread-1');
    assert.deepEqual(runtimeConversationUpsert.create.refsJson, {
      desktopWorkspace: {
        id: 'workspace-1',
        path: '/tmp/repo',
        name: 'repo',
      },
    });

    assert.equal(capturedEngineInput.incoming.channel, 'desktop');
    assert.equal(capturedEngineInput.incoming.chatId, 'thread-1');
    assert.equal(capturedEngineInput.runContext.channel, 'desktop');
    assert.equal(capturedEngineInput.runContext.companyId, 'company-1');
    assert.equal(capturedEngineInput.runContext.departmentId, 'dept-1');
    assert.equal(capturedEngineInput.runContext.workspacePath, '/tmp/repo');
    assert.equal(capturedEngineInput.runContext.userExternalId, 'ou_desktop_user');

    const events = sent.map(item => JSON.parse(item));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'chat.event');
    assert.equal(events[0].requestId, 'request-1');
    assert.equal(events[0].event.type, 'done');
    assert.equal(events[0].event.data.message.content, 'Desktop answer');
  });
});
