import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WhatsappHistoryRepair } from '../../src/application/whatsapp/whatsapp-history-repair.ts';
import { ok, err } from '../../src/shared/result.ts';
import { InfraError } from '../../src/shared/errors.ts';
import type { WhatsappSessionRow } from '../../src/infrastructure/persistence/whatsapp.repository.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

const SESSION: WhatsappSessionRow = {
  id: 'session-1', companyId: 'company-1', departmentId: 'dept-ua',
  label: 'Bookings desk', openwaSessionId: 'divo-ua-bookings-x1',
  phoneE164: '+919876543210', status: 'linked',
  lastSeenAt: new Date('2026-08-23T09:00:00Z'),
  createdAt: new Date('2026-08-01T00:00:00Z'),
  darkSince: new Date('2026-08-23T09:00:00Z'),
};

const message = (id: string) => ({
  id, from: '919876543210@c.us', body: `body ${id}`, timestamp: 1_700_000_000,
});

function makeRepo(alreadyHeld: string[] = []) {
  const held = new Set(alreadyHeld);
  return {
    held,
    cleared: [] as string[],
    renamed: [] as { waChatId: string; name: string }[],
    async storeMessage(input: any) {
      const id = input.message.waMessageId;
      const isNew = !held.has(id);
      held.add(id);
      return ok({ stored: isNew, chatId: 'chat-1', chatIsNew: false, deferredToOwner: false });
    },
    async renameChat(input: any) {
      this.renamed.push({ waChatId: input.waChatId, name: input.name });
      return ok(undefined);
    },
    async clearDark(sessionId: string) { this.cleared.push(sessionId); return ok(undefined); },
  } as any;
}

const gateway = (opts: { chats: any[]; history: Record<string, any[]>; failChat?: string }) => ({
  async chats() { return ok(opts.chats); },
  async chatHistory(_s: string, chatId: string) {
    if (opts.failChat === chatId) {
      return err(new InfraError({ layer: 'http', op: 'openwa.chatHistory', cause: 'boom', message: 'gateway refused' }));
    }
    return ok(opts.history[chatId] ?? []);
  },
} as any);

describe('WhatsappHistoryRepair', () => {
  it('stores only what was actually missing, and clears the gap', async () => {
    const repo = makeRepo(['m1']);          // m1 already held; m2, m3 were missed
    const repair = new WhatsappHistoryRepair({
      repo,
      gateway: gateway({
        chats: [{ id: 'c1@g.us', name: 'Venue — Taj', isGroup: true }],
        history: { 'c1@g.us': [message('m1'), message('m2'), message('m3')] },
      }),
      logger: noopLogger,
    });

    const result = await repair.repair(SESSION, { pacingMs: 0 });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.value.chatsRead, 1);
    assert.equal(result.value.messagesRecovered, 2, 'm1 was already held, so only m2 and m3 count');
    assert.deepEqual(repo.cleared, ['session-1'], 'a complete pass clears the gap');
  });

  it('is safe to run when nothing is missing', async () => {
    // Pressing the button twice must cost time, not data.
    const repo = makeRepo(['m1', 'm2']);
    const repair = new WhatsappHistoryRepair({
      repo,
      gateway: gateway({
        chats: [{ id: 'c1@g.us', name: 'Venue — Taj' }],
        history: { 'c1@g.us': [message('m1'), message('m2')] },
      }),
      logger: noopLogger,
    });

    const result = await repair.repair(SESSION, { pacingMs: 0 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.messagesRecovered, 0);
  });

  it('names the group from the live chat list, which payloads never carry', async () => {
    const repo = makeRepo();
    const repair = new WhatsappHistoryRepair({
      repo,
      gateway: gateway({
        chats: [{ id: 'c1@g.us', name: 'Venue — Taj', isGroup: true }],
        history: { 'c1@g.us': [message('m1')] },
      }),
      logger: noopLogger,
    });
    await repair.repair(SESSION, { pacingMs: 0 });
    assert.deepEqual(repo.renamed, [{ waChatId: 'c1@g.us', name: 'Venue — Taj' }]);
  });

  it('a partial repair keeps reading, reports the failure, and does NOT clear the gap', async () => {
    const repo = makeRepo();
    const repair = new WhatsappHistoryRepair({
      repo,
      gateway: gateway({
        chats: [{ id: 'c1@g.us', name: 'A' }, { id: 'c2@g.us', name: 'B' }],
        history: { 'c2@g.us': [message('m9')] },
        failChat: 'c1@g.us',
      }),
      logger: noopLogger,
    });

    const result = await repair.repair(SESSION, { pacingMs: 0 });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // One unreadable chat must not abandon the rest.
    assert.equal(result.value.messagesRecovered, 1, 'the readable chat was still repaired');
    assert.equal(result.value.failures.length, 1);
    assert.equal(result.value.failures[0]!.chat, 'A');

    // The hole is still there, so the signal that says so must survive.
    assert.deepEqual(repo.cleared, [], 'an incomplete repair does not clear the gap');
  });
});
