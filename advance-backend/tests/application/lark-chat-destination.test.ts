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
});
