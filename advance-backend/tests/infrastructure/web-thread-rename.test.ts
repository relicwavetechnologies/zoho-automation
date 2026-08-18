/**
 * Naming a thread, against the run that is creating it at the same moment.
 *
 * The browser names a new chat from a small model as soon as the ask is sent;
 * the row is written when the run persists its first turn. Those two race, and
 * on every real chat measured the name arrived first — so a rename that
 * required the row to exist threw the name away and left the rail full of
 * "hi there".
 *
 * A fake store rather than a database: what is being pinned is the decision
 * sequence — owned update, then existence check, then create, then one retry —
 * and that is exactly what a real Postgres would hide behind timing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebThreadRepository } from '../../src/infrastructure/persistence/web-thread.repository';

interface Row {
  companyId: string;
  channel: string;
  channelConversationKey: string;
  createdByUserId: string | null;
  title: string | null;
}

/** Just enough of `runtimeConversation` for rename, and a record of the calls. */
function store(rows: Row[], hooks: { onCreate?: () => void } = {}) {
  const calls: string[] = [];
  const match = (where: Record<string, unknown>) => rows.filter(row =>
    row.companyId === where['companyId']
    && row.channel === where['channel']
    && row.channelConversationKey === where['channelConversationKey']
    && (where['createdByUserId'] === undefined || row.createdByUserId === where['createdByUserId']));

  return {
    calls,
    rows,
    db: {
      runtimeConversation: {
        updateMany: async ({ where, data }: never) => {
          calls.push('updateMany');
          const hit = match(where as Record<string, unknown>);
          for (const row of hit) row.title = (data as { title: string }).title;
          return { count: hit.length };
        },
        findUnique: async ({ where }: never) => {
          calls.push('findUnique');
          const key = (where as Record<string, Record<string, unknown>>)[
            'companyId_channel_channelConversationKey'
          ]!;
          return match(key)[0] ?? null;
        },
        create: async ({ data }: never) => {
          calls.push('create');
          // Runs before the insert, so a hook can simulate the run winning the
          // gap between the existence check and the write.
          hooks.onCreate?.();
          const row = data as Row;
          if (match({
            companyId: row.companyId,
            channel: row.channel,
            channelConversationKey: row.channelConversationKey,
          }).length > 0) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          rows.push(row);
          return row;
        },
      },
    },
  };
}

const owner = { companyId: 'c1', userId: 'u1' };
const ask = { ...owner, threadId: 'web_abcdefgh', title: 'Quarterly invoice chase' };

const existing = (over: Partial<Row> = {}): Row => ({
  companyId: 'c1', channel: 'web', channelConversationKey: 'web_abcdefgh',
  createdByUserId: 'u1', title: 'hi there', ...over,
});

describe('WebThreadRepository.rename', () => {
  it('names a thread nobody has spoken in yet', async () => {
    const fake = store([]);
    const result = await new WebThreadRepository(fake.db as never).rename(ask);

    assert.equal(result.ok && result.value, true);
    assert.equal(fake.rows.length, 1);
    assert.equal(fake.rows[0]?.title, 'Quarterly invoice chase');
    // The owner is written down, or `list` — which filters on it — would never
    // show the member the thread they just named.
    assert.equal(fake.rows[0]?.createdByUserId, 'u1');
  });

  it('renames a thread that already exists, without a second write', async () => {
    const fake = store([existing()]);
    const result = await new WebThreadRepository(fake.db as never).rename(ask);

    assert.equal(result.ok && result.value, true);
    assert.equal(fake.rows[0]?.title, 'Quarterly invoice chase');
    assert.deepEqual(fake.calls, ['updateMany']);
  });

  it('refuses a thread that belongs to somebody else', async () => {
    const fake = store([existing({ createdByUserId: 'someone-else' })]);
    const result = await new WebThreadRepository(fake.db as never).rename(ask);

    /* The unique key carries no owner, so an upsert keyed on it alone would let
       any member rename any thread by guessing an id. */
    assert.equal(result.ok && result.value, false);
    assert.equal(fake.rows[0]?.title, 'hi there');
    assert.equal(fake.calls.includes('create'), false);
  });

  it('applies the name when the run creates the row mid-flight', async () => {
    const rows: Row[] = [];
    // The run wins the gap between the existence check and the insert.
    const fake = store(rows, { onCreate: () => { rows.push(existing()); } });
    const result = await new WebThreadRepository(fake.db as never).rename(ask);

    assert.equal(result.ok && result.value, true);
    assert.equal(rows.length, 1, 'the run\'s row is the only one');
    assert.equal(rows[0]?.title, 'Quarterly invoice chase');
    assert.deepEqual(fake.calls, ['updateMany', 'findUnique', 'create', 'updateMany']);
  });

  it('gives up rather than looping when the raced row is not theirs', async () => {
    const rows: Row[] = [];
    const fake = store(rows, {
      onCreate: () => { rows.push(existing({ createdByUserId: 'someone-else' })); },
    });
    const result = await new WebThreadRepository(fake.db as never).rename(ask);

    assert.equal(result.ok && result.value, false);
    assert.equal(rows[0]?.title, 'hi there');
  });
});
