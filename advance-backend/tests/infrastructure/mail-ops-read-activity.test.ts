/**
 * The query behind the mail heatmap.
 *
 * A calendar drawn from the wrong rows fails silently: it renders ordinary
 * empty squares whether a day was quiet, belonged to somebody else, or was
 * simply never fetched. So the shape of this query is asserted rather than
 * trusted — what it selects, what it bounds, and whose mail it can reach.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MailOpsReadRepository } from '../../src/infrastructure/persistence/mail-ops-read.repository.ts';

const since = new Date('2026-04-20T00:00:00.000Z');

function repoCapturing(rows: unknown[]) {
  let query: any;
  const db = {
    mailDelivery: {
      findMany: async (input: any) => { query = input; return rows; },
    },
  } as any;
  return { repo: new MailOpsReadRepository(db), read: () => query };
}

describe('listCaughtActivityForUser', () => {
  it('scopes to the rule owner inside the query, not after it', async () => {
    // Filtering afterwards would leave a window in which another member's
    // history had already been read out of the database.
    const { repo, read } = repoCapturing([]);
    await repo.listCaughtActivityForUser({
      companyId: 'company-1', userId: 'user-1', since, limit: 20_000,
    });

    assert.equal(read().where.companyId, 'company-1');
    assert.deepEqual(read().where.rule, {
      createdByUserId: 'user-1',
      companyId: 'company-1',
    });
  });

  it('asks only for the window, and only for what a square needs', async () => {
    // The subject, sender, rule join and frozen payload are what make the
    // caught feed too heavy to fetch a season of. None of them is visible here.
    const { repo, read } = repoCapturing([]);
    await repo.listCaughtActivityForUser({
      companyId: 'company-1', userId: 'user-1', since, limit: 20_000,
    });

    assert.deepEqual(read().where.firstAttemptAt, { gte: since });
    assert.deepEqual(Object.keys(read().select).sort(), [
      'deliveredAt', 'firstAttemptAt', 'lastError', 'status',
    ]);
    assert.equal(read().take, 20_000);
  });

  it('returns the four scalars unchanged, including a null delivery', async () => {
    // A held message has no `deliveredAt`, and turning that into a date would
    // report it as passed on.
    const first = new Date('2026-08-09T09:00:00.000Z');
    const { repo } = repoCapturing([
      { status: 'delivered', lastError: null, firstAttemptAt: first, deliveredAt: first },
      { status: 'held', lastError: null, firstAttemptAt: first, deliveredAt: null },
    ]);

    const result = await repo.listCaughtActivityForUser({
      companyId: 'company-1', userId: 'user-1', since, limit: 20_000,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, [
      { status: 'delivered', lastError: null, firstAttemptAt: first, deliveredAt: first },
      { status: 'held', lastError: null, firstAttemptAt: first, deliveredAt: null },
    ]);
  });

  it('reports a database failure rather than an empty season', async () => {
    // An empty array here would draw 112 quiet days, which is a claim about
    // the member's mail rather than about the query.
    const db = {
      mailDelivery: { findMany: async () => { throw new Error('connection reset'); } },
    } as any;

    const result = await new MailOpsReadRepository(db).listCaughtActivityForUser({
      companyId: 'company-1', userId: 'user-1', since, limit: 20_000,
    });

    assert.equal(result.ok, false);
  });
});
