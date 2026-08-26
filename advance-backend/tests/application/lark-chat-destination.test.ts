import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLarkChatDestinationAuthorizer,
  larkChatDeliveryAllowed,
  type LarkChatDirectoryPort,
} from '../../src/application/mail-ops/lark-chat-destination';
import { ok, err } from '../../src/shared/result';
import { wrapInfra } from '../../src/shared/errors';

function directory(rooms: ReadonlyArray<{ companyId: string; chatId: string }>): LarkChatDirectoryPort {
  return {
    async get({ companyId, chatId }) {
      const found = rooms.find(r => r.companyId === companyId && r.chatId === chatId);
      return ok(found ? { chatId: found.chatId } : null);
    },
    async listCompanyIdsForChat(chatId) {
      return ok([...new Set(rooms.filter(r => r.chatId === chatId).map(r => r.companyId))]);
    },
  };
}

describe('Lark chat destinations', () => {
  it('allows a room this company has been in', async () => {
    const authorize = createLarkChatDestinationAuthorizer(
      directory([{ companyId: 'co-1', chatId: 'oc_team' }]),
    );
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_team' }),
      { status: 'allowed' },
    );
  });

  it('refuses a room belonging to another company on the same Lark install', async () => {
    // The whole point of the guard: one Lark installation serving two Divo
    // companies used to let a rule in one pipe mail into the other's room.
    const authorize = createLarkChatDestinationAuthorizer(
      directory([{ companyId: 'co-2', chatId: 'oc_theirs' }]),
    );
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_theirs' }),
      { status: 'other_company' },
    );
  });

  it('separates a room it has never seen from one that is somebody else\'s', async () => {
    // Different remedies. The member can add Divo to an unknown room; they
    // cannot do anything about a room in a company they cannot see.
    const authorize = createLarkChatDestinationAuthorizer(directory([]));
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_nowhere' }),
      { status: 'unknown_chat' },
    );
  });

  it('reports an unreadable directory rather than allowing the send', async () => {
    const authorize = createLarkChatDestinationAuthorizer({
      async get() { return err(wrapInfra('prisma', 'get', new Error('db down'))); },
      async listCompanyIdsForChat() { return ok([]); },
    });
    const verdict = await authorize({ companyId: 'co-1', chatId: 'oc_team' });
    assert.equal(verdict.status, 'unavailable');
  });

  it('lets delivery proceed for anything but another company\'s room', () => {
    // A member's own DM with Divo never has a room record, and it is the
    // commonest destination there is — so the delivery backstop cannot demand
    // one. It refuses only what it positively knows to be wrong.
    assert.equal(larkChatDeliveryAllowed({ status: 'allowed' }), true);
    assert.equal(larkChatDeliveryAllowed({ status: 'unknown_chat' }), true);
    assert.equal(
      larkChatDeliveryAllowed({ status: 'unavailable', reason: 'db down' }),
      true,
    );
    assert.equal(larkChatDeliveryAllowed({ status: 'other_company' }), false);
  });

  // ── Asking Lark, rather than waiting to overhear it ─────────────────────

  const membership = (answer: boolean | Error) => ({
    async botIsInChat() {
      return answer instanceof Error ? err({ message: answer.message }) : ok(answer);
    },
  });

  it('allows a room Divo has never overheard but is demonstrably in', async () => {
    // The failure this was built for. An administrator named a room, added the
    // bot, and the digest still declined to post — because nothing had spoken
    // there yet. The record that would have unblocked it was not being written
    // at all, so the wait was for something that would never arrive.
    const authorize = createLarkChatDestinationAuthorizer(directory([]), membership(true));
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_quiet' }),
      { status: 'allowed' },
    );
  });

  it('still refuses a room the bot is not in', async () => {
    const authorize = createLarkChatDestinationAuthorizer(directory([]), membership(false));
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_elsewhere' }),
      { status: 'unknown_chat' },
    );
  });

  it('never lets membership overturn the cross-tenant refusal', async () => {
    // One Lark install, two Divo companies, and a bot that is legitimately in
    // both. Ownership is asked first and settles it: membership can rescue an
    // unknown room, never a room known to be somebody else's.
    const authorize = createLarkChatDestinationAuthorizer(
      directory([{ companyId: 'co-2', chatId: 'oc_theirs' }]),
      membership(true),
    );
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_theirs' }),
      { status: 'other_company' },
    );
  });

  it('a membership lookup that failed is unavailable, not a refusal', async () => {
    // "We could not ask" must not arrive wearing the same face as "no": one is
    // retried, the other sends somebody hunting for a permission problem that
    // does not exist.
    const authorize = createLarkChatDestinationAuthorizer(
      directory([]),
      membership(new Error('Lark timed out')),
    );
    const verdict = await authorize({ companyId: 'co-1', chatId: 'oc_quiet' });
    assert.equal(verdict.status, 'unavailable');
    // And delivery still goes ahead on it, because only `other_company` is a
    // permanent no.
    assert.equal(larkChatDeliveryAllowed(verdict), true);
  });

  it('without a membership port, an unknown room is still unknown', async () => {
    const authorize = createLarkChatDestinationAuthorizer(directory([]));
    assert.deepEqual(
      await authorize({ companyId: 'co-1', chatId: 'oc_quiet' }),
      { status: 'unknown_chat' },
    );
  });
});
