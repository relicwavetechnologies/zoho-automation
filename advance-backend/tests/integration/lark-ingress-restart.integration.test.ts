/**
 * Lark durable ingress — process-restart recovery against real Redis and Postgres.
 *
 * Every other test in this area mocks Prisma and BullMQ, so they prove the
 * repository's intent but not that an accepted message actually survives a
 * worker dying. That is the whole premise of Wave 2, so it needs a fixture that
 * uses the real infrastructure.
 *
 * Required (suite is skipped when absent):
 *   DATABASE_URL            — reachable Postgres; start the tunnel first with
 *                             `bash scripts/db-tunnel.sh start`
 *   REDIS_QUEUE_URL / REDIS_URL — reachable Redis for BullMQ
 *
 * Each test uses its own queue name and tenant key, and deletes its rows
 * afterwards, so runs cannot collide with each other or with dev data.
 *
 * KNOWN HAZARD — check this first when these tests fail mysteriously. A run
 * that dies without completing its cleanup can leave a worker alive in an
 * orphaned node process. `listRecoverable` filters on channel, not queue name,
 * so that stray worker recovers the *next* run's receipts onto its own dead
 * queue: the receipt reaches `completed` having never executed, and the failure
 * reads exactly like a durability bug. Confirm with
 * `ps aux | grep lark-ingress-restart`, clear with
 * `pkill -f lark-ingress-restart.integration.test.ts`, and re-run. The
 * reachability probe below removes the most common cause but not the class.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { IngressReceiptRepository } from '../../src/infrastructure/persistence/ingress-receipt.repository.ts';
import { LarkIngressQueue } from '../../src/application/lark-ingress/lark-ingress.queue.ts';
import { LarkIngressWorker } from '../../src/application/lark-ingress/lark-ingress.worker.ts';
import type { Logger } from '../../src/shared/logger.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_QUEUE_URL'] ?? process.env['REDIS_URL'];
const missing = !DATABASE_URL
  ? 'DATABASE_URL not set'
  : !REDIS_URL
    ? 'REDIS_QUEUE_URL / REDIS_URL not set'
    : false;

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const TENANT = 'zz-restart-tenant';

/** Poll until `condition` holds. Real infrastructure has genuine latency. */
async function waitFor(
  condition: () => Promise<boolean>,
  label: string,
  budgetMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe('Lark durable ingress — restart recovery', { skip: missing }, () => {
  const db = new PrismaClient();
  const repo = new IngressReceiptRepository(db);
  const queues: LarkIngressQueue[] = [];
  const workers: LarkIngressWorker[] = [];

  const statusOf = async (receiptId: string): Promise<string | undefined> =>
    (await db.ingressIdempotencyKey.findUnique({
      where: { id: receiptId },
      select: { status: true },
    }))?.status;

  /**
   * Set when the services are configured but unreachable — typically the SSH
   * tunnel being down.
   *
   * Checked eagerly because the alternative is worse than a slow failure. With
   * an unreachable database the first test hangs until the whole suite is
   * cancelled, and a cancelled test never runs its cleanup: the worker it
   * started stays alive in an orphaned process. That worker keeps polling
   * `listRecoverable`, which filters on channel rather than queue name, so it
   * recovers the *next* run's receipts onto its own dead queue. The next run
   * then fails with receipts that reach `completed` having never executed —
   * a symptom that looks like a durability bug and is not one.
   */
  let unreachable: string | undefined;

  before(async () => {
    try {
      await Promise.race([
        db.$queryRaw`SELECT 1`,
        // Generous: a cold Prisma connect over an SSH tunnel is slow, and a
        // false "unreachable" would silently skip Wave 2's exit gate — a worse
        // outcome than waiting. This only has to beat the suite budget that
        // would otherwise cancel the test and orphan its worker.
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timed out after 20s')), 20_000)),
      ]);
    } catch (error) {
      unreachable = `database unreachable (${String(error)}) — start the tunnel with \`bash scripts/db-tunnel.sh start\``;
      return;
    }
    await db.ingressIdempotencyKey.deleteMany({ where: { tenantKey: TENANT } });
  });

  after(async () => {
    for (const worker of workers) await worker.stop().catch(() => {});
    for (const queue of queues) await queue.close().catch(() => {});
    if (!unreachable) {
      await db.ingressIdempotencyKey.deleteMany({ where: { tenantKey: TENANT } });
    }
    await db.$disconnect();
  });

  /**
   * Run `body` against a worker bound to its own queue, then shut it down.
   *
   * Exactly one worker may run at a time. `listRecoverable` filters on channel
   * alone, so a worker left running from an earlier test will happily reconcile
   * a later test's receipt onto its own queue and execute it with the wrong
   * callback. That is correct for production, which runs a single queue name,
   * but it means these tests cannot overlap.
   *
   * `staleProcessingAfterMs` is tiny so the test need not wait out the
   * production five-minute lease.
   */
  const withWorker = async (
    queueName: string,
    processReceipt: (id: string) => Promise<void>,
    body: (ctx: { queue: LarkIngressQueue; worker: LarkIngressWorker }) => Promise<void>,
  ): Promise<void> => {
    const queue = new LarkIngressQueue(REDIS_URL!, queueName);
    const worker = new LarkIngressWorker({
      redisUrl: REDIS_URL!,
      queueName,
      queue,
      receiptRepo: repo,
      processReceipt: receipt => processReceipt(receipt.receiptId),
      staleProcessingAfterMs: 500,
      reconcileIntervalMs: 1_000,
      logger: noopLogger,
    });
    queues.push(queue);
    workers.push(worker);
    try {
      await body({ queue, worker });
    } finally {
      await worker.stop().catch(() => {});
      await queue.close().catch(() => {});
    }
  };

  it('resumes work accepted before a crash, without Lark redelivering it', async t => {
    if (unreachable) return t.skip(unreachable);
    const queueName = `zz-lark-ingress-resume-${process.pid}`;
    const messageId = `zz-resume-${process.pid}`;

    const accepted = await repo.accept({
      channel: 'lark', tenantKey: TENANT, messageId, payload: { probe: 'resume' },
    });
    assert.ok(accepted.ok, 'receipt accepted');
    const receiptId = accepted.value.receiptId;

    // The crash: a worker claimed this receipt and died before finishing, so it
    // is left in `processing` with a lease nobody will ever release.
    const orphaned = await repo.claim(receiptId, { staleProcessingAfterMs: 0 });
    assert.equal(orphaned.ok && orphaned.value.outcome, 'claimed');
    assert.equal(await statusOf(receiptId), 'processing');

    // The restart. Nothing re-delivers from Lark; recovery is the only path in.
    const executed: string[] = [];
    await withWorker(queueName, async id => { executed.push(id); }, async ({ queue, worker }) => {
      await queue.enqueue(receiptId);
      worker.start();
      await waitFor(async () => (await statusOf(receiptId)) === 'completed', 'receipt completes');
    });
    assert.deepEqual(executed, [receiptId], 'the orphaned receipt ran exactly once');
  });

  it('recovers an orphaned receipt from reconciliation alone', async t => {
    if (unreachable) return t.skip(unreachable);
    const queueName = `zz-lark-ingress-reconcile-${process.pid}`;
    const messageId = `zz-reconcile-${process.pid}`;

    const accepted = await repo.accept({
      channel: 'lark', tenantKey: TENANT, messageId, payload: { probe: 'reconcile' },
    });
    assert.ok(accepted.ok);
    const receiptId = accepted.value.receiptId;

    // No enqueue at all — this models the crash window between persisting the
    // receipt and admitting it to the queue. Only the reconcile sweep can save it.
    const executed: string[] = [];
    await withWorker(queueName, async id => { executed.push(id); }, async ({ worker }) => {
      worker.start();
      await waitFor(async () => (await statusOf(receiptId)) === 'completed', 'reconcile recovers receipt');
    });
    assert.deepEqual(executed, [receiptId], 'recovered receipt ran exactly once');
  });

  it('executes one run for a duplicate Lark delivery and never re-runs a completed one', async t => {
    if (unreachable) return t.skip(unreachable);
    const queueName = `zz-lark-ingress-dupe-${process.pid}`;
    const messageId = `zz-dupe-${process.pid}`;

    const first = await repo.accept({
      channel: 'lark', tenantKey: TENANT, messageId, payload: { probe: 'dupe' },
    });
    const second = await repo.accept({
      channel: 'lark', tenantKey: TENANT, messageId, payload: { probe: 'dupe' },
    });
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.isNew, true);
    assert.equal(second.value.isNew, false, 'redelivery reuses the receipt');
    assert.equal(second.value.receiptId, first.value.receiptId);
    const receiptId = first.value.receiptId;

    const executed: string[] = [];
    await withWorker(queueName, async id => { executed.push(id); }, async ({ queue, worker }) => {
      await queue.enqueue(receiptId);
      await queue.enqueue(receiptId);
      worker.start();
      await waitFor(async () => (await statusOf(receiptId)) === 'completed', 'receipt completes');

      // A late redelivery after completion must not start a second run: the
      // receipt, not the queue, is what makes this idempotent.
      await queue.enqueue(receiptId);
      await new Promise<void>(resolve => setTimeout(resolve, 2_000));
    });

    assert.deepEqual(executed, [receiptId], 'exactly one execution across three deliveries');
    assert.equal(await statusOf(receiptId), 'completed');
  });

  it('re-runs a receipt whose worker died mid-execution', async t => {
    if (unreachable) return t.skip(unreachable);
    const queueName = `zz-lark-ingress-midrun-${process.pid}`;
    const messageId = `zz-midrun-${process.pid}`;

    const accepted = await repo.accept({
      channel: 'lark', tenantKey: TENANT, messageId, payload: { probe: 'midrun' },
    });
    assert.ok(accepted.ok);
    const receiptId = accepted.value.receiptId;

    // First attempt gets partway and dies; the second must finish the work.
    // Wave 2 guarantees at-least-once *execution* — a partial side effect can
    // be repeated. Exactly-once *final output* is Wave 5's delivery identity,
    // so this test pins current behaviour rather than asserting no repeat.
    const attempts: string[] = [];
    await withWorker(queueName, async id => {
      attempts.push(id);
      if (attempts.length === 1) throw new Error('zz simulated crash mid-execution');
    }, async ({ queue, worker }) => {
      await queue.enqueue(receiptId);
      worker.start();
      await waitFor(async () => (await statusOf(receiptId)) === 'completed', 'receipt eventually completes');
    });
    assert.ok(attempts.length >= 2, `expected a retry, saw ${attempts.length} attempt(s)`);
  });
});
