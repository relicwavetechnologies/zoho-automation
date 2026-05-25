/**
 * Scheduled workflow delivery lock — integration-style chain tests.
 *
 * Verifies that when a scheduled workflow targets lark_current_chat:
 *   1. The prompt is rewritten to remove the delivery instruction
 *   2. RunContext carries deliveryMode: 'current_chat_only'
 *   3. larkMessaging refuses to send to other chats
 *   4. larkMessaging allows sending to the locked chat (or no chatId → defaults)
 *   5. send_dm and reply are blocked under the lock
 *   6. mention defaults to locked chat when no chatId supplied
 *   7. Non-locked scheduled workflows pass through normally
 *
 * These chain the scheduler's prompt rewriting + runContext building with the
 * tool's enforcement logic — the gap between unit tests and live replay.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  usesLockedCurrentChatDelivery,
  buildScheduledExecutionPrompt,
} from '../../src/application/scheduling/scheduled-workflow.service.ts';
import { createLarkMessagingTool } from '../../src/application/orchestration/tools/families/lark-messaging.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

const LOCKED_CHAT = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const OTHER_GROUP = 'oc_b9169aab0765f46b2fe9147068e3c79f';

const fakeClient = {
  sendMessage:     async (chatId: string, _text: string) => ({ messageId: `msg-${chatId}` }),
  replyMessage:    async (_msgId: string, _text: string) => ({ messageId: 'msg-reply' }),
  listMessages:    async () => [],
  getMessage:      async () => ({ messageId: 'msg-1', text: 'hi', senderId: 'u1', timestamp: 'ts' }),
  sendDm:          async (_openId: string, _text: string) => ({ messageId: 'msg-dm' }),
  listChats:       async () => [],
  searchMessages:  async () => [],
  mentionMessage:  async (chatId: string, _text: string, _ids: string[]) => ({ messageId: `msg-mention-${chatId}` }),
};

const fakePeopleResolver = {
  resolve: async (_companyId: string, names: string[], _requesterOpenId: string) => ({
    resolved: names.map(n => ({ query: n, openId: `ou_${n.toLowerCase()}`, displayName: n })),
    ambiguous: [],
    notFound: [],
  }),
};

function lockedCtx() {
  return makeCtx('larkMessaging', ['read', 'send'], {
    chatId: LOCKED_CHAT,
    deliveryMode: 'current_chat_only',
  });
}

function normalCtx() {
  return makeCtx('larkMessaging', ['read', 'send']);
}

// ─── Prompt rewriting ────────────────────────────────────────────────────────

describe('Scheduled delivery lock: prompt rewriting', () => {
  const PROMPT_WITH_DELIVERY = [
    'Workflow: Daily email summary',
    'Original intent: check my mails every day in the morning',
    '1. [execute] Check latest emails',
    '   Use googleGmail with op=list to read recent emails',
    '2. [deliver] Deliver result',
    '   Deliver to: dest_1:lark_current_chat',
  ].join('\n');

  const PROMPT_WITHOUT_DELIVERY = [
    'Workflow: Generate report',
    '1. [execute] Pull data from CRM',
    '   Use zohoCrm with op=search_records',
  ].join('\n');

  it('detects lark_current_chat delivery in prompt', () => {
    assert.equal(usesLockedCurrentChatDelivery(PROMPT_WITH_DELIVERY), true);
  });

  it('does not falsely detect non-delivery prompts', () => {
    assert.equal(usesLockedCurrentChatDelivery(PROMPT_WITHOUT_DELIVERY), false);
  });

  it('rewrites prompt: removes delivery line, adds runtime override', () => {
    const rewritten = buildScheduledExecutionPrompt(PROMPT_WITH_DELIVERY, LOCKED_CHAT);

    assert.doesNotMatch(rewritten, /Deliver to:\s+dest_1:lark_current_chat/);
    assert.match(rewritten, /runtime_locked_current_chat/);
    assert.match(rewritten, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(rewritten, new RegExp(LOCKED_CHAT));
    assert.match(rewritten, /Do NOT call larkMessaging/);
  });

  it('leaves non-delivery prompts unchanged', () => {
    const rewritten = buildScheduledExecutionPrompt(PROMPT_WITHOUT_DELIVERY, LOCKED_CHAT);
    assert.equal(rewritten, PROMPT_WITHOUT_DELIVERY);
    assert.doesNotMatch(rewritten, /RUNTIME DELIVERY OVERRIDE/);
  });
});

// ─── Tool enforcement under delivery lock ────────────────────────────────────

describe('Scheduled delivery lock: larkMessaging enforcement', () => {
  const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });

  it('send: allows sending to the locked chat explicitly', async () => {
    const r = await tool.execute({ op: 'send', chatId: LOCKED_CHAT, text: 'Daily summary' }, lockedCtx());
    assert.equal(r.ok, true);
    assert.equal((r as any).value.messageId, `msg-${LOCKED_CHAT}`);
  });

  it('send: defaults to locked chat when no chatId supplied', async () => {
    const r = await tool.execute({ op: 'send', text: 'Daily summary' }, lockedCtx());
    assert.equal(r.ok, true);
    assert.equal((r as any).value.messageId, `msg-${LOCKED_CHAT}`);
  });

  it('send: blocks sending to a DIFFERENT chat under lock', async () => {
    const r = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'Rerouted' }, lockedCtx());
    assert.equal(r.ok, false);
    assert.equal((r as any).error.payload.reason, 'bad_args');
    assert.match((r as any).error.message, /locked to the current chat/i);
  });

  it('send_dm: blocked under delivery lock', async () => {
    const r = await tool.execute({ op: 'send_dm', text: 'hey', recipientName: 'Anish' }, lockedCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /locked to the current chat/i);
  });

  it('reply: blocked under delivery lock', async () => {
    const r = await tool.execute({ op: 'reply', messageId: 'msg-1', text: 'response' }, lockedCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /locked to the current chat/i);
  });

  it('mention: defaults to locked chat when no chatId', async () => {
    const r = await tool.execute({
      op: 'mention',
      text: 'Hey check this @Anish',
      mentionNames: ['Anish'],
    }, lockedCtx());
    assert.equal(r.ok, true);
    assert.equal((r as any).value.messageId, `msg-mention-${LOCKED_CHAT}`);
  });

  it('mention: blocks different chat under lock', async () => {
    const r = await tool.execute({
      op: 'mention',
      chatId: OTHER_GROUP,
      text: 'Hey @Anish',
      mentionNames: ['Anish'],
    }, lockedCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /locked to the current chat/i);
  });

  it('list_chats: still allowed under lock (read action)', async () => {
    const r = await tool.execute({ op: 'list_chats' }, lockedCtx());
    assert.equal(r.ok, true);
  });

  it('list: still allowed under lock (read action)', async () => {
    const r = await tool.execute({ op: 'list', chatId: LOCKED_CHAT }, lockedCtx());
    assert.equal(r.ok, true);
  });
});

// ─── Normal (non-locked) behavior still works ────────────────────────────────

describe('Scheduled delivery lock: normal mode unaffected', () => {
  const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });

  it('send to any chat works without lock', async () => {
    const r = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'hello' }, normalCtx());
    assert.equal(r.ok, true);
    assert.equal((r as any).value.messageId, `msg-${OTHER_GROUP}`);
  });

  it('send_dm works without lock', async () => {
    const r = await tool.execute({ op: 'send_dm', text: 'hey', recipientName: 'Anish' }, normalCtx());
    assert.equal(r.ok, true);
  });

  it('reply works without lock', async () => {
    const r = await tool.execute({ op: 'reply', messageId: 'msg-1', text: 'pong' }, normalCtx());
    assert.equal(r.ok, true);
  });
});

// ─── Full chain: scheduler → RunContext → tool guard ─────────────────────────

describe('Scheduled delivery lock: full chain', () => {
  it('scheduler detects delivery, builds locked RunContext, tool enforces it', async () => {
    // Step 1: Scheduler detects lark_current_chat
    const compiledPrompt = [
      'Workflow: Daily standup',
      '1. [execute] Check tasks',
      '2. [deliver] Post summary',
      '   Deliver to: dest_1:lark_current_chat',
    ].join('\n');

    assert.equal(usesLockedCurrentChatDelivery(compiledPrompt), true);

    // Step 2: Scheduler rewrites prompt
    const executionPrompt = buildScheduledExecutionPrompt(compiledPrompt, LOCKED_CHAT);
    assert.match(executionPrompt, /runtime_locked_current_chat/);

    // Step 3: Scheduler would build RunContext with deliveryMode
    const ctx = lockedCtx();
    assert.equal(ctx.runContext.deliveryMode, 'current_chat_only');
    assert.equal(ctx.runContext.chatId, LOCKED_CHAT);

    // Step 4: Tool enforces — same chat OK, different chat blocked
    const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });

    const okResult = await tool.execute({ op: 'send', text: 'Summary here' }, ctx);
    assert.equal(okResult.ok, true);

    const blockedResult = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'Rerouted' }, ctx);
    assert.equal(blockedResult.ok, false);
    assert.match((blockedResult as any).error.message, /locked/i);

    const dmBlocked = await tool.execute({ op: 'send_dm', text: 'hi', recipientName: 'Anish' }, ctx);
    assert.equal(dmBlocked.ok, false);
  });

  it('non-delivery workflow: no lock, no restrictions', async () => {
    const compiledPrompt = 'Workflow: Generate CRM report\n1. Pull records from zohoCrm';

    assert.equal(usesLockedCurrentChatDelivery(compiledPrompt), false);

    const executionPrompt = buildScheduledExecutionPrompt(compiledPrompt, LOCKED_CHAT);
    assert.equal(executionPrompt, compiledPrompt);

    const ctx = normalCtx();
    assert.equal(ctx.runContext.deliveryMode, undefined);

    const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });
    const r = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'Report attached' }, ctx);
    assert.equal(r.ok, true);
  });
});
