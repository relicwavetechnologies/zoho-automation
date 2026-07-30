/**
 * Scheduled workflow delivery lock — integration-style chain tests.
 *
 * A scheduled run executes as one person: their history, their permissions,
 * their private chat recall. Its result is delivered by the runtime to that
 * person's own Lark DM and must reach no one else. These tests chain the
 * scheduler's prompt rewriting and run context with the messaging tool's
 * enforcement, which is the gap unit tests on either side leave open.
 *
 * What a run may still do is contact somebody the task explicitly names — that
 * is the task doing its job, not the run delivering itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  usesLockedCurrentChatDelivery,
  buildScheduledExecutionPrompt,
} from '../../src/application/scheduling/scheduled-workflow.service.ts';
import { createLarkMessagingTool } from '../../src/application/tools/families/lark-messaging.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

/** Where every scheduled result goes: the creator's own DM. */
const CREATOR_DM = 'ou_4da3c8e6a6a2b9eb29a2aea24fd17e50';
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

function scheduledCtx() {
  return makeCtx('larkMessaging', ['read', 'send'], {
    chatId: CREATOR_DM,
    deliveryMode: 'scheduled_runtime_delivery',
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

  it('detects a delivery destination left in an older workflow', () => {
    assert.equal(usesLockedCurrentChatDelivery(PROMPT_WITH_DELIVERY), true);
  });

  it('does not falsely detect non-delivery prompts', () => {
    assert.equal(usesLockedCurrentChatDelivery(PROMPT_WITHOUT_DELIVERY), false);
  });

  it('strips the destination an older workflow names and says who receives it', () => {
    const rewritten = buildScheduledExecutionPrompt(PROMPT_WITH_DELIVERY);

    // Left standing, the task text and the runtime override contradict each
    // other, and the model may satisfy the task by posting to that chat itself.
    assert.doesNotMatch(rewritten, /Deliver to:\s+dest_1:lark_current_chat/);
    assert.match(rewritten, /runtime_creator_dm/);
    assert.match(rewritten, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(rewritten, /Ignore any delivery destination named in the task above/i);
    assert.match(rewritten, /schedule creator's Lark DM/i);
  });

  it('adds runtime ownership to raw-intent scheduled prompts', () => {
    const rewritten = buildScheduledExecutionPrompt(PROMPT_WITHOUT_DELIVERY);
    assert.match(rewritten, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(rewritten, /schedule creator's Lark DM/i);
  });
});

// ─── Tool enforcement under scheduled delivery ───────────────────────────────

describe('Scheduled delivery lock: larkMessaging enforcement', () => {
  const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });

  it('send: blocks explicit delivery to the creator DM', async () => {
    const r = await tool.execute({ op: 'send', chatId: CREATOR_DM, text: 'Daily summary' }, scheduledCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /runtime owns final delivery/i);
  });

  it('send: blocks implicit delivery', async () => {
    const r = await tool.execute({ op: 'send', text: 'Daily summary' }, scheduledCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /runtime owns final delivery/i);
  });

  it('send: blocks delivery to any other chat as well', async () => {
    // The run's own chat is now a DM, so a guard that only rejected the current
    // chat would wave through every group id — the whole point of the rule.
    const r = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'Rerouted' }, scheduledCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /runtime owns final delivery/i);
  });

  it('mention: blocks posting into a group', async () => {
    const r = await tool.execute({
      op: 'mention',
      chatId: OTHER_GROUP,
      text: 'Hey @Anish',
      mentionNames: ['Anish'],
    }, scheduledCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /runtime owns final delivery/i);
  });

  it('reply: blocks a destination that cannot be verified as external', async () => {
    const r = await tool.execute({ op: 'reply', messageId: 'msg-1', text: 'response' }, scheduledCtx());
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /runtime owns final delivery/i);
  });

  it('send_dm: still allows an explicit external action to another person', async () => {
    // A task that says "tell Anish when the report is ready" is doing the work
    // it was written to do, and is not the run delivering its own result.
    const r = await tool.execute({ op: 'send_dm', text: 'hey', recipientName: 'Anish' }, scheduledCtx());
    assert.equal(r.ok, true);
    assert.equal((r as any).value.messageId, 'msg-dm');
  });

  it('list_chats: still allowed (read action)', async () => {
    const r = await tool.execute({ op: 'list_chats' }, scheduledCtx());
    assert.equal(r.ok, true);
  });

  it('list: still allowed (read action)', async () => {
    const r = await tool.execute({ op: 'list', chatId: CREATOR_DM }, scheduledCtx());
    assert.equal(r.ok, true);
  });
});

// ─── Normal (non-scheduled) behavior still works ─────────────────────────────

describe('Scheduled delivery lock: normal mode unaffected', () => {
  const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });

  it('send to any chat works outside a scheduled run', async () => {
    const r = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'hello' }, normalCtx());
    assert.equal(r.ok, true);
    assert.equal((r as any).value.messageId, `msg-${OTHER_GROUP}`);
  });

  it('send_dm works outside a scheduled run', async () => {
    const r = await tool.execute({ op: 'send_dm', text: 'hey', recipientName: 'Anish' }, normalCtx());
    assert.equal(r.ok, true);
  });

  it('reply works outside a scheduled run', async () => {
    const r = await tool.execute({ op: 'reply', messageId: 'msg-1', text: 'pong' }, normalCtx());
    assert.equal(r.ok, true);
  });

  it('mention works outside a scheduled run', async () => {
    const r = await tool.execute({
      op: 'mention',
      chatId: OTHER_GROUP,
      text: 'Hey @Anish',
      mentionNames: ['Anish'],
    }, normalCtx());
    assert.equal(r.ok, true);
  });
});

// ─── Full chain: scheduler → RunContext → tool guard ─────────────────────────

describe('Scheduled delivery lock: full chain', () => {
  it('an older group-bound workflow cannot reach that group once redirected', async () => {
    // The exact population the redirect exists for: written when a schedule
    // still posted into the room it was created in.
    const compiledPrompt = [
      'Workflow: Daily standup',
      '1. [execute] Check tasks',
      '2. [deliver] Post summary',
      '   Deliver to: dest_1:lark_current_chat',
    ].join('\n');

    assert.equal(usesLockedCurrentChatDelivery(compiledPrompt), true);

    const executionPrompt = buildScheduledExecutionPrompt(compiledPrompt);
    assert.match(executionPrompt, /runtime_creator_dm/);
    assert.doesNotMatch(executionPrompt, /Deliver to:\s+dest_1:lark_current_chat/);

    const ctx = scheduledCtx();
    assert.equal(ctx.runContext.deliveryMode, 'scheduled_runtime_delivery');
    assert.equal(ctx.runContext.chatId, CREATOR_DM);

    const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });

    // Neither the run's own destination nor the group it was written for.
    assert.equal((await tool.execute({ op: 'send', text: 'Summary here' }, ctx)).ok, false);
    assert.equal(
      (await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'Summary here' }, ctx)).ok,
      false,
    );
    assert.equal(
      (await tool.execute(
        { op: 'mention', chatId: OTHER_GROUP, text: 'Standup @Anish', mentionNames: ['Anish'] },
        ctx,
      )).ok,
      false,
    );

    // The one thing that survives: contacting a named person on purpose.
    assert.equal((await tool.execute({ op: 'send_dm', text: 'hi', recipientName: 'Anish' }, ctx)).ok, true);
  });

  it('normal non-scheduled workflow: no lock, no restrictions', async () => {
    const compiledPrompt = 'Workflow: Generate CRM report\n1. Pull records from zohoCrm';

    assert.equal(usesLockedCurrentChatDelivery(compiledPrompt), false);

    const ctx = normalCtx();
    assert.equal(ctx.runContext.deliveryMode, undefined);

    const tool = createLarkMessagingTool({ client: fakeClient, peopleResolver: fakePeopleResolver });
    const r = await tool.execute({ op: 'send', chatId: OTHER_GROUP, text: 'Report attached' }, ctx);
    assert.equal(r.ok, true);
  });
});
