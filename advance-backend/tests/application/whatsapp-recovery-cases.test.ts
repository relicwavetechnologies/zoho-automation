import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WhatsappIngestService } from '../../src/application/whatsapp/whatsapp-ingest.service.ts';
import { WhatsappReconcileWorker } from '../../src/application/whatsapp/whatsapp-reconcile.worker.ts';
import { err, ok } from '../../src/shared/result.ts';
import { InfraError } from '../../src/shared/errors.ts';
import type { IngressReceiptRepoPort } from '../../src/infrastructure/persistence/ingress-receipt.repository.ts';
import type {
  WhatsappRepoPort,
  WhatsappSessionRow,
} from '../../src/infrastructure/persistence/whatsapp.repository.ts';

/**
 * The three failure cases, exercised end to end against the real services.
 *
 * The fakes implement the same contract the Prisma adapters do, including the
 * parts recovery actually depends on: `accept` is idempotent on
 * (channel, tenantKey, messageId), `claim` is a *lease* rather than a status
 * stamp, and `listRecoverable` returns accepted/processing/failed but never
 * completed or dead.
 */

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
} as any;

const SESSION: WhatsappSessionRow = {
  id: 'session-1',
  companyId: 'company-1',
  departmentId: 'dept-ua',
  label: 'Bookings desk',
  openwaSessionId: 'divo-ua-bookings-x1',
  phoneE164: '+919876543210',
  status: 'linked',
  lastSeenAt: new Date('2026-08-25T09:00:00Z'),
  darkSince: null,
};

const STALE_PROCESSING_MS = 5 * 60_000;

interface FakeReceipt {
  id: string;
  channel: string;
  tenantKey: string;
  messageId: string;
  payload: Record<string, unknown>;
  status: 'accepted' | 'processing' | 'completed' | 'failed' | 'dead';
  startedAt: Date | null;
  attempts: number;
  acceptedAt: Date;
}

class FakeReceipts implements IngressReceiptRepoPort {
  readonly rows: FakeReceipt[] = [];
  private seq = 0;

  async accept(input: any) {
    const existing = this.rows.find(r =>
      r.channel === input.channel && r.tenantKey === input.tenantKey && r.messageId === input.messageId);
    if (existing) return ok({ receiptId: existing.id, isNew: false });
    const row: FakeReceipt = {
      id: `receipt-${++this.seq}`,
      channel: input.channel, tenantKey: input.tenantKey, messageId: input.messageId,
      payload: input.payload, status: 'accepted', startedAt: null, attempts: 0, acceptedAt: new Date(),
    };
    this.rows.push(row);
    return ok({ receiptId: row.id, isNew: true });
  }

  async markQueued() { return ok(undefined); }

  async claim(receiptId: string) {
    const row = this.rows.find(r => r.id === receiptId);
    if (!row) return ok({ outcome: 'terminal' } as const);
    if (row.status === 'completed' || row.status === 'dead') return ok({ outcome: 'terminal' } as const);
    // A lease: a receipt someone else is actively running stays theirs until stale.
    const leaseLive = row.status === 'processing'
      && row.startedAt !== null
      && Date.now() - row.startedAt.getTime() < STALE_PROCESSING_MS;
    if (leaseLive) return ok({ outcome: 'leased' } as const);
    row.status = 'processing';
    row.startedAt = new Date();
    row.attempts += 1;
    return ok({
      outcome: 'claimed' as const,
      receipt: {
        receiptId: row.id, tenantKey: row.tenantKey, messageId: row.messageId,
        payload: row.payload, attempts: row.attempts, acceptedAt: row.acceptedAt,
      },
    });
  }

  async markCompleted(receiptId: string) {
    const row = this.rows.find(r => r.id === receiptId);
    if (row) row.status = 'completed';
    return ok(undefined);
  }

  async markFailed(receiptId: string, _e: unknown, options: any = {}) {
    const row = this.rows.find(r => r.id === receiptId);
    if (row && row.status !== 'completed') row.status = options.terminal ? 'dead' : 'failed';
    return ok(undefined);
  }

  async listRecoverable(limit: number, options: any = {}) {
    return ok(this.rows
      .filter(r => r.channel === (options.channel ?? 'lark'))
      .filter(r => r.status === 'accepted' || r.status === 'processing' || r.status === 'failed')
      .slice(0, limit).map(r => r.id));
  }

  async listExhausted() { return ok([] as string[]); }
  async listBatchable() { return ok([]); }
}

class FakeWhatsappRepo implements WhatsappRepoPort {
  readonly stored: string[] = [];
  readonly touched: string[] = [];
  statusWrites: { sessionId: string; status: string }[] = [];
  darkMarks: { sessionId: string; since: Date }[] = [];
  darkCleared: string[] = [];
  sessionRow: WhatsappSessionRow | null = SESSION;
  failStoreOnce = false;

  async findSessionByOpenwaId() { return ok(this.sessionRow); }
  async listSessions() { return ok(this.sessionRow ? [this.sessionRow] : []); }
  async listLinkedSessions() { return ok(this.sessionRow ? [this.sessionRow] : []); }
  async createSession() { return ok(SESSION); }
  async updateSessionStatus(input: any) {
    this.statusWrites.push({ sessionId: input.sessionId, status: input.status });
    const current = this.sessionRow;
    if (current && current.id === input.sessionId) {
      this.sessionRow = { ...current, status: String(input.status) };
    }
    return ok(undefined);
  }
  async touchSession(sessionId: string) { this.touched.push(sessionId); return ok(undefined); }
  async markDark(sessionId: string, since: Date) {
    // Mirrors the real `updateMany({ where: { darkSince: null } })`: the mark
    // does not move once set.
    if (!this.darkMarks.some(m => m.sessionId === sessionId)) {
      this.darkMarks.push({ sessionId, since });
    }
    return ok(undefined);
  }
  async clearDark(sessionId: string) {
    this.darkCleared.push(sessionId);
    this.darkMarks = this.darkMarks.filter(m => m.sessionId !== sessionId);
    return ok(undefined);
  }
  async listStaleSessions(quietSince: Date) {
    const row = this.sessionRow;
    if (!row || (row.status !== 'linked' && row.status !== 'disconnected')) return ok([]);
    if (row.status === 'disconnected') return ok([row]);
    const stale = row.lastSeenAt === null || row.lastSeenAt.getTime() < quietSince.getTime();
    return ok(stale ? [row] : []);
  }
  async storeMessage(input: any) {
    if (this.failStoreOnce) { this.failStoreOnce = false; throw new Error('simulated crash mid-write'); }
    const already = this.stored.includes(input.message.waMessageId);
    if (!already) this.stored.push(input.message.waMessageId);
    return ok({ stored: !already, chatId: 'chat-1', chatIsNew: !already, deferredToOwner: false });
  }
  async renameChat() { return ok(undefined); }
  async pruneMessagesBefore() { return ok(0); }
}

const envelope = (id: string) => ({
  event: 'message.received',
  sessionId: SESSION.openwaSessionId,
  data: { id, from: '919876543210@c.us', body: 'Can you confirm the venue?', timestamp: 1_700_000_000 },
});

const gatewayStub = (connected: boolean) => ({
  session: async () => ok({ id: SESSION.openwaSessionId, status: connected ? 'connected' : 'disconnected' }),
  chats: async () => ok([]),
} as any);

describe('WhatsApp durability — the three failure cases', () => {
  it('CASE 1: a crash mid-ingest leaves a receipt the sweep replays', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });

    // The process dies part-way through storing; markCompleted is never reached.
    repo.failStoreOnce = true;
    await assert.rejects(() => ingest.ingest(envelope('wa-crash'), 'idem-1'));

    assert.equal(receipts.rows.length, 1, 'the receipt survives the crash');
    assert.equal(receipts.rows[0]!.status, 'processing');
    assert.equal(repo.stored.length, 0, 'nothing was stored before the crash');

    // Its lease goes stale once the owner is gone.
    receipts.rows[0]!.startedAt = new Date(Date.now() - STALE_PROCESSING_MS - 1000);

    const worker = new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(true), logger: noopLogger,
    });
    await worker.runOnce();

    assert.deepEqual(repo.stored, ['wa-crash'], 'replayed from the stored payload');
    assert.equal(receipts.rows[0]!.status, 'completed');
  });

  it('CASE 1b: a live lease is not stolen by the sweep', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });

    repo.failStoreOnce = true;
    await assert.rejects(() => ingest.ingest(envelope('wa-live'), 'idem-2'));
    // startedAt is fresh, so another worker is presumed still running it.

    const worker = new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(true), logger: noopLogger,
    });
    await worker.runOnce();

    assert.deepEqual(repo.stored, [], 'the sweep left the live lease alone');
  });

  it('CASE 2: a redelivered webhook is deduplicated, not stored twice', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });

    const first = await ingest.ingest(envelope('wa-dup'), 'idem-3');
    const second = await ingest.ingest(envelope('wa-dup'), 'idem-3');

    assert.equal(first.status, 'stored');
    assert.equal(second.status, 'duplicate');
    assert.equal(receipts.rows.length, 1, 'one receipt, not two');
    assert.deepEqual(repo.stored, ['wa-dup'], 'stored exactly once');
  });

  it('CASE 2b: admission survives the session-registration race', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });
    repo.sessionRow = null;

    const admitted = await ingest.admit(envelope('wa-early'), 'idem-early');
    assert.equal(admitted.status, 'accepted');
    if (admitted.status !== 'accepted') return;
    const first = await ingest.process(admitted.receiptId);
    assert.equal(first.status, 'unknown_session');
    assert.equal(receipts.rows[0]!.status, 'failed', 'retryable, not dead-lettered');

    repo.sessionRow = SESSION;
    await new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(true), logger: noopLogger,
    }).runOnce();

    assert.deepEqual(repo.stored, ['wa-early']);
    assert.equal(receipts.rows[0]!.status, 'completed');
  });

  it('CASE 3: a dark handset raises the alarm — and no message is recovered', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });

    // Two days of silence. The messages were never delivered, so there is no
    // receipt anywhere to replay: no request was ever made.
    repo.sessionRow = { ...SESSION, lastSeenAt: new Date(Date.now() - 48 * 60 * 60_000) };

    const worker = new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(false), logger: noopLogger,
    });
    await worker.runOnce();

    assert.deepEqual(repo.statusWrites, [{ sessionId: 'session-1', status: 'disconnected' }],
      'the alarm fires and the number is marked dark');

    // The gap is recorded from when delivery stopped, not from when we noticed.
    assert.equal(repo.darkMarks.length, 1);
    assert.equal(repo.darkMarks[0]!.since.getTime(), repo.sessionRow!.lastSeenAt!.getTime());

    // There is still no automatic history recovery. Restoring a session later
    // leaves the gap marker until the explicit re-read fills it.
    assert.equal(receipts.rows.length, 0, 'nothing to replay — no receipt was ever created');
    assert.deepEqual(repo.stored, [], 'the sweep does not fetch what it missed');
  });

  it('CASE 3c: the dark mark does not move on a later sweep', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });
    const stoppedAt = new Date(Date.now() - 48 * 60 * 60_000);
    repo.sessionRow = { ...SESSION, lastSeenAt: stoppedAt };

    const worker = new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(false), logger: noopLogger,
    });
    await worker.runOnce();
    await worker.runOnce();

    // A sweep runs every five minutes. If the mark moved each time, two days of
    // outage would be reported as five minutes of it.
    assert.equal(repo.darkMarks.length, 1, 'marked once, not once per sweep');
    assert.equal(repo.darkMarks[0]!.since.getTime(), stoppedAt.getTime());
  });

  it('CASE 3b: a handset merely quiet, but still connected, is not marked dark', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });
    repo.sessionRow = { ...SESSION, lastSeenAt: new Date(Date.now() - 48 * 60 * 60_000) };

    const worker = new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(true), logger: noopLogger,
    });
    await worker.runOnce();

    // Asking the gateway before shouting keeps a slow week from reading as a fault.
    assert.deepEqual(repo.statusWrites, [], 'still connected, so not marked dark');
  });

  it('CASE 3d: a gateway outage does not turn silence into a confirmed disconnect', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });
    repo.sessionRow = { ...SESSION, lastSeenAt: new Date(Date.now() - 48 * 60 * 60_000) };
    const gateway = {
      session: async () => err(new InfraError({
        layer: 'http', op: 'openwa.session', cause: 'down', message: 'gateway unavailable',
      })),
      chats: async () => ok([]),
    } as any;

    await new WhatsappReconcileWorker({ receipts, repo, ingest, gateway, logger: noopLogger }).runOnce();

    assert.deepEqual(repo.statusWrites, []);
    assert.deepEqual(repo.darkMarks, []);
  });

  it('CASE 3e: unknown gateway vocabulary makes no liveness claim', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });
    repo.sessionRow = { ...SESSION, lastSeenAt: new Date(Date.now() - 48 * 60 * 60_000) };
    const gateway = {
      session: async () => ok({ id: SESSION.openwaSessionId, status: 'warming_v2' }),
      chats: async () => ok([]),
    } as any;

    await new WhatsappReconcileWorker({ receipts, repo, ingest, gateway, logger: noopLogger }).runOnce();

    assert.deepEqual(repo.statusWrites, []);
    assert.deepEqual(repo.darkMarks, []);
  });

  it('CASE 3f: a recovered disconnected session becomes linked without clearing its gap', async () => {
    const receipts = new FakeReceipts();
    const repo = new FakeWhatsappRepo();
    const ingest = new WhatsappIngestService({ receipts, repo, logger: noopLogger });
    const darkSince = new Date(Date.now() - 48 * 60 * 60_000);
    repo.sessionRow = { ...SESSION, status: 'disconnected', darkSince, lastSeenAt: darkSince };
    repo.darkMarks.push({ sessionId: SESSION.id, since: darkSince });

    await new WhatsappReconcileWorker({
      receipts, repo, ingest, gateway: gatewayStub(true), logger: noopLogger,
    }).runOnce();

    assert.deepEqual(repo.statusWrites, [{ sessionId: SESSION.id, status: 'linked' }]);
    assert.equal(repo.sessionRow?.darkSince, darkSince);
    assert.deepEqual(repo.darkCleared, []);
  });
});
