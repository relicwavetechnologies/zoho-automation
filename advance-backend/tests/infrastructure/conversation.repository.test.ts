import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConversationRepository } from '../../src/infrastructure/persistence/conversation.repository.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import { ok, err } from '../../src/shared/result.ts';
import type { Turn } from '../../src/domain/conversation/turn.ts';
import { conversationCacheKey } from '../../src/domain/conversation/conversation-scope.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTurn(id: string, role: Turn['role'], content: string): Turn {
  return { id, role, content, timestamp: new Date().toISOString() };
}

const CHAT_KEY = 'chat_001';
const CACHE_KEY = `history:v2:${CHAT_KEY}`;
const SCOPE = { companyId: 'company-1', channel: 'lark' } as const;

const turn1 = makeTurn('t1', 'user', 'hello');
const turn2 = makeTurn('t2', 'assistant', 'hi!');

function makeMessage(turn: Turn) {
  return {
    id: turn.id,
    role: turn.role,
    contentText: turn.content,
    contentJson: null,
    toolCallJson: null,
    toolResultJson: null,
    createdAt: new Date(turn.timestamp),
  };
}

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    runtimeConversation: {
      findFirst: async () => ({
        id: 'conv-1',
        messages: [makeMessage(turn1), makeMessage(turn2)],
      }),
      create: async () => ({ id: 'conv-1' }),
      update: async () => ({ lastMessageSequence: 1 }),
    },
    runtimeConversationMessage: {
      create: async (_input: unknown) => ({
        id: 'new-msg',
        role: 'user',
        contentText: 'hi',
        contentJson: null,
        toolCallJson: null,
        toolResultJson: null,
        createdAt: new Date(),
      }),
      deleteMany: async () => ({ count: 0 }),
    },
    ...overrides,
  };
}

function makeCache(store = new Map<string, unknown>()): CachePort & { store: Map<string, unknown>; delCalls: string[] } {
  const delCalls: string[] = [];
  return {
    store,
    delCalls,
    get: async (k) => ok(store.has(k) ? (store.get(k) as any) : null),
    set: async (k, v) => { store.set(k, v); return ok(undefined); },
    setNx: async (k, v) => { if (store.has(k)) return ok(false); store.set(k, v); return ok(true); },
    del: async (k) => { delCalls.push(k); store.delete(k); return ok(undefined); },
    scanDel: async () => ok(0),
  };
}

function makeFailingCache(): CachePort {
  return {
    get: async () => err({ kind: 'infra', source: 'redis', operation: 'get', cause: new Error('redis down') } as any),
    set: async () => err({ kind: 'infra', source: 'redis', operation: 'set', cause: new Error('redis down') } as any),
    setNx: async () => err({ kind: 'infra', source: 'redis', operation: 'setNx', cause: new Error('redis down') } as any),
    del: async () => err({ kind: 'infra', source: 'redis', operation: 'del', cause: new Error('redis down') } as any),
    scanDel: async () => err({ kind: 'infra', source: 'redis', operation: 'scanDel', cause: new Error('redis down') } as any),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConversationRepository.getHistory', () => {
  it('uses the compound company/channel/chat identity and a scoped cache key', async () => {
    let query: any = null;
    const db = makeDb({
      runtimeConversation: {
        findUnique: async (input: unknown) => {
          query = input;
          return { id: 'company-conv', messages: [makeMessage(turn1)] };
        },
        findFirst: async () => { throw new Error('unscoped lookup must not run'); },
        create: async () => ({ id: 'company-conv' }),
        update: async () => ({ lastMessageSequence: 1 }),
      },
    });
    const cache = makeCache();
    const repo = new ConversationRepository(db as any, cache);

    const result = await repo.getHistory(CHAT_KEY, 40, SCOPE);
    assert.ok(result.ok);
    assert.deepEqual(query.where.companyId_channel_channelConversationKey, {
      companyId: 'company-1', channel: 'lark', channelConversationKey: CHAT_KEY,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cache.store.has(conversationCacheKey(CHAT_KEY, SCOPE)));
    assert.ok(!cache.store.has(CACHE_KEY));
  });

  it('cache miss: queries Prisma and populates cache', async () => {
    let dbCalls = 0;
    const db = makeDb({
      runtimeConversation: {
        findFirst: async () => { dbCalls++; return { id: 'conv-1', messages: [makeMessage(turn1), makeMessage(turn2)] }; },
        create: async () => ({ id: 'conv-1' }),
        update: async () => ({ lastMessageSequence: 1 }),
      },
    });
    const cache = makeCache();
    const repo = new ConversationRepository(db as any, cache);

    const result = await repo.getHistory(CHAT_KEY);

    assert.ok(result.ok);
    assert.equal(result.value.length, 2);
    assert.equal(dbCalls, 1);
    // Give fire-and-forget a tick to settle
    await new Promise(r => setImmediate(r));
    assert.ok(cache.store.has(CACHE_KEY), 'cache should be populated after DB query');
  });

  it('cache hit: returns cached turns without querying Prisma', async () => {
    let dbCalls = 0;
    const db = makeDb({
      runtimeConversation: {
        findFirst: async () => { dbCalls++; return null; },
        create: async () => ({ id: 'conv-1' }),
        update: async () => ({ lastMessageSequence: 1 }),
      },
    });
    const store = new Map<string, unknown>([[CACHE_KEY, [turn1, turn2]]]);
    const cache = makeCache(store);
    const repo = new ConversationRepository(db as any, cache);

    const result = await repo.getHistory(CHAT_KEY);

    assert.ok(result.ok);
    assert.equal(result.value.length, 2);
    assert.equal(dbCalls, 0, 'DB should not be queried on cache hit');
  });

  it('cache hit: respects the limit param by returning newest cached turns', async () => {
    const store = new Map<string, unknown>([[CACHE_KEY, [turn1, turn2]]]);
    const cache = makeCache(store);
    const repo = new ConversationRepository(makeDb() as any, cache);

    const result = await repo.getHistory(CHAT_KEY, 1);

    assert.ok(result.ok);
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0]!.id, turn2.id);
  });

  it('DB miss: fetches newest rows and returns them in chronological order', async () => {
    const older = makeTurn('old', 'user', 'old');
    const middle = makeTurn('middle', 'assistant', 'middle');
    const newest = makeTurn('newest', 'user', 'newest');
    let query: any = null;
    const db = makeDb({
      runtimeConversation: {
        findFirst: async (input: unknown) => {
          query = input;
          // Prisma returns desc-ordered rows for the query below.
          return { id: 'conv-1', messages: [makeMessage(newest), makeMessage(middle), makeMessage(older)] };
        },
        create: async () => ({ id: 'conv-1' }),
        update: async () => ({ lastMessageSequence: 1 }),
      },
    });
    const repo = new ConversationRepository(db as any);

    const result = await repo.getHistory(CHAT_KEY, 2);

    assert.ok(result.ok);
    assert.deepEqual(result.value.map(t => t.id), ['middle', 'newest']);
    assert.equal(query.include.messages.orderBy.sequence, 'desc');
    assert.equal(query.include.messages.take, 60);
  });

  it('no cache set when DB returns empty array', async () => {
    const db = makeDb({
      runtimeConversation: {
        findFirst: async () => null, // no conversation → returns []
        create: async () => ({ id: 'conv-1' }),
        update: async () => ({ lastMessageSequence: 1 }),
      },
    });
    const cache = makeCache();
    const repo = new ConversationRepository(db as any, cache);

    const result = await repo.getHistory(CHAT_KEY);
    await new Promise(r => setImmediate(r));

    assert.ok(result.ok);
    assert.equal(result.value.length, 0);
    assert.ok(!cache.store.has(CACHE_KEY), 'empty result must NOT be cached');
  });

  it('cache error falls through to Prisma', async () => {
    let dbCalls = 0;
    const db = makeDb({
      runtimeConversation: {
        findFirst: async () => { dbCalls++; return { id: 'conv-1', messages: [makeMessage(turn1)] }; },
        create: async () => ({ id: 'conv-1' }),
        update: async () => ({ lastMessageSequence: 1 }),
      },
    });
    const repo = new ConversationRepository(db as any, makeFailingCache());

    const result = await repo.getHistory(CHAT_KEY);

    assert.ok(result.ok);
    assert.equal(dbCalls, 1, 'should fall back to Prisma when cache errors');
  });
});

describe('ConversationRepository.appendTurn', () => {
  it('writes and invalidates only the scoped company conversation', async () => {
    let lookup: any = null;
    const scopedCacheKey = conversationCacheKey(CHAT_KEY, SCOPE);
    const cache = makeCache(new Map([[scopedCacheKey, [turn1]], [CACHE_KEY, [turn1]]]));
    const db = makeDb({
      runtimeConversation: {
        findUnique: async (input: unknown) => { lookup = input; return { id: 'company-conv' }; },
        findFirst: async () => { throw new Error('unscoped lookup must not run'); },
        create: async () => ({ id: 'company-conv' }),
        update: async () => ({ lastMessageSequence: 2 }),
      },
    });
    const repo = new ConversationRepository(db as any, cache);

    const result = await repo.appendTurn(CHAT_KEY, {
      role: 'user', content: 'scoped message', timestamp: new Date().toISOString(),
    }, SCOPE);
    assert.ok(result.ok);
    assert.deepEqual(lookup.where.companyId_channel_channelConversationKey, {
      companyId: 'company-1', channel: 'lark', channelConversationKey: CHAT_KEY,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cache.delCalls.includes(scopedCacheKey));
    assert.ok(!cache.delCalls.includes(CACHE_KEY));
  });

  it('invalidates cache after successful append', async () => {
    const cache = makeCache(new Map([[CACHE_KEY, [turn1]]]));
    const repo = new ConversationRepository(makeDb() as any, cache);

    await repo.appendTurn(CHAT_KEY, { role: 'user', content: 'new message', timestamp: new Date().toISOString() });
    await new Promise(r => setImmediate(r));

    assert.ok(cache.delCalls.includes(CACHE_KEY), 'cache should be invalidated after appendTurn');
  });
});

describe('ConversationRepository.clearHistory', () => {
  it('clears only the exact scoped conversation and its cached window', async () => {
    const calls: { find?: any; deleted?: any; updated?: any } = {};
    const db = {
      runtimeConversation: {
        findUnique: async (input: unknown) => {
          calls.find = input;
          return { id: 'conv-thread' };
        },
        update: async (input: unknown) => {
          calls.updated = input;
          return {};
        },
      },
      runtimeConversationMessage: {
        deleteMany: async (input: unknown) => {
          calls.deleted = input;
          return { count: 2 };
        },
      },
    };
    const cache = makeCache();
    const repo = new ConversationRepository(db as any, cache);
    const key = `${CHAT_KEY}:thread:om_alice`;

    const result = await repo.clearHistory(key, SCOPE);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(
      calls.find.where.companyId_channel_channelConversationKey,
      { companyId: 'company-1', channel: 'lark', channelConversationKey: key },
    );
    assert.deepEqual(calls.deleted.where, { conversationId: 'conv-thread' });
    assert.equal(calls.updated.where.id, 'conv-thread');
    assert.equal(calls.updated.data.lastSummarizedSequence, 0);
    assert.ok(cache.delCalls.includes(conversationCacheKey(key, SCOPE)));
  });

  it('invalidates a stale cache without issuing deletes when no row exists', async () => {
    let deleted = false;
    const db = {
      runtimeConversation: {
        findUnique: async () => null,
        update: async () => ({}),
      },
      runtimeConversationMessage: {
        deleteMany: async () => {
          deleted = true;
          return { count: 0 };
        },
      },
    };
    const cache = makeCache();
    const repo = new ConversationRepository(db as any, cache);

    const result = await repo.clearHistory(CHAT_KEY, SCOPE);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(result, { ok: true, value: false });
    assert.equal(deleted, false);
    assert.ok(cache.delCalls.includes(conversationCacheKey(CHAT_KEY, SCOPE)));
  });
});


describe('ConversationRepository.clearChatHistories', () => {
  /** Records the queries a clear issues, so the match rule itself is inspectable. */
  function makeSweepDb(rows: Array<{ id: string; channelConversationKey: string }>) {
    const calls: { find?: any; deleteMany?: any; updateMany?: any } = {};
    return {
      db: {
        runtimeConversation: {
          findMany: async (input: unknown) => { calls.find = input; return rows; },
          updateMany: async (input: unknown) => { calls.updateMany = input; return { count: rows.length }; },
        },
        runtimeConversationMessage: {
          deleteMany: async (input: unknown) => { calls.deleteMany = input; return { count: 0 }; },
        },
      },
      calls,
    };
  }

  it('clears the chat, every thread, and every inline requester beneath it', async () => {
    const { db, calls } = makeSweepDb([
      { id: 'conv-room', channelConversationKey: CHAT_KEY },
      { id: 'conv-a', channelConversationKey: `${CHAT_KEY}:thread:om_alice` },
      { id: 'conv-b', channelConversationKey: `${CHAT_KEY}:thread:om_bob` },
      { id: 'conv-inline', channelConversationKey: `${CHAT_KEY}:user:ou_alice` },
    ]);
    const repo = new ConversationRepository(db as any, makeCache());

    const result = await repo.clearChatHistories(CHAT_KEY, SCOPE);

    assert.deepEqual(result, { ok: true, value: 4 });
    // Since working context became thread-scoped, clearing one exact key would
    // report success while leaving each thread's transcript intact.
    assert.deepEqual(calls.find.where.OR, [
      { channelConversationKey: CHAT_KEY },
      // `_` is a LIKE wildcard and real Lark chat IDs contain one, so the
      // prefix arm is escaped while the equality arm is not.
      { channelConversationKey: { startsWith: 'chat\\_001:thread:' } },
      { channelConversationKey: { startsWith: 'chat\\_001:user:' } },
    ]);
    assert.deepEqual(
      calls.deleteMany.where.conversationId.in,
      ['conv-room', 'conv-a', 'conv-b', 'conv-inline'],
    );
    assert.equal(calls.updateMany.data.lastSummarizedSequence, 0);
  });

  it('refuses to reach outside the asking company', async () => {
    const { db, calls } = makeSweepDb([]);
    const repo = new ConversationRepository(db as any, makeCache());

    await repo.clearChatHistories(CHAT_KEY, SCOPE);

    // A bare chat-key lookup is not bound to a tenant; a clear must be.
    assert.equal(calls.find.where.companyId, SCOPE.companyId);
    assert.equal(calls.find.where.channel, SCOPE.channel);
  });

  it('invalidates the cached window for every conversation it cleared', async () => {
    const { db } = makeSweepDb([
      { id: 'conv-a', channelConversationKey: `${CHAT_KEY}:thread:om_alice` },
    ]);
    const cache = makeCache();
    const repo = new ConversationRepository(db as any, cache);

    await repo.clearChatHistories(CHAT_KEY, SCOPE);
    await new Promise(r => setImmediate(r));

    assert.ok(
      cache.delCalls.includes(conversationCacheKey(`${CHAT_KEY}:thread:om_alice`, SCOPE)),
      'the thread window is dropped from cache',
    );
    // The chat key may hold a cached window with no row of its own.
    assert.ok(cache.delCalls.includes(conversationCacheKey(CHAT_KEY, SCOPE)));
  });

  it('writes nothing when the chat has no conversations', async () => {
    const { db, calls } = makeSweepDb([]);
    const repo = new ConversationRepository(db as any, makeCache());

    const result = await repo.clearChatHistories(CHAT_KEY, SCOPE);

    assert.deepEqual(result, { ok: true, value: 0 });
    assert.equal(calls.deleteMany, undefined, 'no blanket delete when nothing matched');
    assert.equal(calls.updateMany, undefined);
  });
});

describe('ConversationRepository.clearChatHistories LIKE safety', () => {
  it('escapes wildcard characters in the chat ID before matching', async () => {
    let where: any;
    const db = {
      runtimeConversation: {
        findMany: async (input: any) => { where = input.where; return []; },
        updateMany: async () => ({ count: 0 }),
      },
      runtimeConversationMessage: { deleteMany: async () => ({ count: 0 }) },
    } as any;
    const repo = new ConversationRepository(db, makeCache());

    await repo.clearChatHistories('oc%_1', SCOPE);

    // `startsWith` compiles to LIKE without escaping, and this is a delete path
    // whose match set comes from an event payload. Unescaped, `oc%` would match
    // every conversation in the company.
    const prefixes = where.OR.slice(1).map(
      (arm: any) => arm.channelConversationKey.startsWith,
    );
    assert.deepEqual(prefixes, ['oc\\%\\_1:thread:', 'oc\\%\\_1:user:']);
    assert.ok(prefixes.every((prefix: string) => !prefix.includes('%:')));
  });

  it('leaves an ordinary chat ID untouched', async () => {
    let where: any;
    const db = {
      runtimeConversation: {
        findMany: async (input: any) => { where = input.where; return []; },
        updateMany: async () => ({ count: 0 }),
      },
      runtimeConversationMessage: { deleteMany: async () => ({ count: 0 }) },
    } as any;
    const repo = new ConversationRepository(db, makeCache());

    await repo.clearChatHistories('ocabc123', SCOPE);

    assert.equal(where.OR[1].channelConversationKey.startsWith, 'ocabc123:thread:');
    assert.equal(where.OR[2].channelConversationKey.startsWith, 'ocabc123:user:');
    // The exact-key arm is an equality match and must stay unescaped.
    assert.equal(where.OR[0].channelConversationKey, 'ocabc123');
  });
});
