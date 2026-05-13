import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConversationRepository } from '../../src/infrastructure/persistence/conversation.repository.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import { ok, err } from '../../src/shared/result.ts';
import type { Turn } from '../../src/domain/conversation/turn.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTurn(id: string, role: Turn['role'], content: string): Turn {
  return { id, role, content, timestamp: new Date().toISOString() };
}

const CHAT_KEY = 'chat_001';
const CACHE_KEY = `history:v2:${CHAT_KEY}`;

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
    del: async (k) => { delCalls.push(k); store.delete(k); return ok(undefined); },
    scanDel: async () => ok(0),
  };
}

function makeFailingCache(): CachePort {
  return {
    get: async () => err({ kind: 'infra', source: 'redis', operation: 'get', cause: new Error('redis down') } as any),
    set: async () => err({ kind: 'infra', source: 'redis', operation: 'set', cause: new Error('redis down') } as any),
    del: async () => err({ kind: 'infra', source: 'redis', operation: 'del', cause: new Error('redis down') } as any),
    scanDel: async () => err({ kind: 'infra', source: 'redis', operation: 'scanDel', cause: new Error('redis down') } as any),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConversationRepository.getHistory', () => {
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
  it('invalidates cache after successful append', async () => {
    const cache = makeCache(new Map([[CACHE_KEY, [turn1]]]));
    const repo = new ConversationRepository(makeDb() as any, cache);

    await repo.appendTurn(CHAT_KEY, { role: 'user', content: 'new message', timestamp: new Date().toISOString() });
    await new Promise(r => setImmediate(r));

    assert.ok(cache.delCalls.includes(CACHE_KEY), 'cache should be invalidated after appendTurn');
  });
});

describe('ConversationRepository.clearHistory', () => {
  it('invalidates cache after clear', async () => {
    const cache = makeCache(new Map([[CACHE_KEY, [turn1]]]));
    const repo = new ConversationRepository(makeDb() as any, cache);

    await repo.clearHistory(CHAT_KEY);
    await new Promise(r => setImmediate(r));

    assert.ok(cache.delCalls.includes(CACHE_KEY), 'cache should be invalidated after clearHistory');
  });
});
