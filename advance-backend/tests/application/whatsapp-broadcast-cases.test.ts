import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InfraError } from '../../src/shared/errors';
import { ok, err, type Result } from '../../src/shared/result';
import {
  WhatsappBroadcastService,
  refusalOf,
} from '../../src/application/whatsapp/whatsapp-broadcast.service';

/**
 * The awkward halves.
 *
 * Everything here is a state the happy path cannot reach and the one somebody
 * hits at the worst moment: a gateway that accepted a batch and failed to say
 * so, a number check that timed out, a batch the gateway threw away during a
 * restart. Each of these has a wrong answer that looks like working software,
 * and this is where those are pinned.
 */

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silentLogger,
} as never;

interface RepoCalls {
  created: unknown[];
  status: unknown[];
  applied: unknown[];
}

const makeRepo = (over: Record<string, unknown> = {}) => {
  const calls: RepoCalls = { created: [], status: [], applied: [] };
  const repo = {
    calls,
    listCandidates: async () => ok([]),
    resolveKnownChats: async (input: { waChatIds: readonly string[] }) =>
      ok(new Set(input.waChatIds.filter(id => id.startsWith('9198')))),
    create: async (input: unknown) => { calls.created.push(input); return ok('bc-1'); },
    markStatus: async (input: unknown) => { calls.status.push(input); return ok(undefined); },
    applyBatchStatus: async (input: unknown) => { calls.applied.push(input); return ok(undefined); },
    list: async () => ok([]),
    get: async () => ok(null),
    findForScope: async () => ok(null),
    claimPollable: async () => ok([]),
    ...over,
  };
  return repo as typeof repo & Record<string, never>;
};

const makeSessions = () => ({
  findInScope: async () => ok({ id: 'n1', openwaSessionId: 'gw-1', label: 'Priya Nair' }),
}) as never;

const makeGateway = (over: Record<string, unknown> = {}) => ({
  sendBulk: async () => ok({ batchId: 'divo_x', status: 'pending', totalMessages: 1 }),
  batchStatus: async () => ok({
    batchId: 'divo_x',
    status: 'completed',
    progress: { total: 1, sent: 1, failed: 0, pending: 0, cancelled: 0 },
    results: [{ chatId: '919845010001@c.us', status: 'sent', messageId: 'true_x' }],
  }),
  cancelBatch: async () => ok({ batchId: 'divo_x', status: 'cancelled' }),
  checkNumber: async () => ok({ exists: true }),
  ...over,
}) as never;

const service = (repo: unknown, gateway: unknown) => new WhatsappBroadcastService({
  repo: repo as never,
  sessions: makeSessions(),
  gateway: gateway as never,
  logger: silentLogger,
});

const scope = { companyId: 'co-1', departmentId: 'dep-1' };
const known = { waChatId: '919845010001@c.us', displayName: 'Ritu Malhotra', isGroup: false };

describe('send — ordering', () => {
  /**
   * The row is written before the gateway is called. Reversed, a crash or a
   * timeout between the two leaves a send nobody can trace; this way it leaves a
   * row naming exactly which recipients may already have been messaged.
   */
  it('records the broadcast before asking the gateway to send anything', async () => {
    const order: string[] = [];
    const repo = makeRepo({
      create: async () => { order.push('create'); return ok('bc-1'); },
      markStatus: async () => ok(undefined),
    });
    const gateway = makeGateway({
      sendBulk: async () => {
        order.push('sendBulk');
        return ok({ batchId: 'divo_x', status: 'pending', totalMessages: 1 });
      },
    });

    const sent = await service(repo, gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi {{name}}',
      requestedById: 'u-1', recipients: [known],
    });

    assert.equal(sent.ok, true);
    assert.deepEqual(order, ['create', 'sendBulk']);
  });

  it('stores each recipient the copy they will actually receive', async () => {
    const repo = makeRepo();
    const sent = await service(repo, makeGateway()).send({
      ...scope, sessionId: 'n1', label: '', body: 'Hi {{name}}, ready?',
      requestedById: 'u-1', recipients: [known],
    });

    assert.equal(sent.ok, true);
    const created = repo.calls.created[0] as {
      body: string;
      recipients: { renderedBody: string }[];
    };
    // The template is kept as typed — that is what was reviewed — and the
    // rendered copy is stored beside it, per recipient.
    assert.equal(created.body, 'Hi {{name}}, ready?');
    assert.equal(created.recipients[0]!.renderedBody, 'Hi Ritu, ready?');
  });

  it('falls back to the message itself when nobody named the broadcast', async () => {
    const repo = makeRepo();
    await service(repo, makeGateway()).send({
      ...scope, sessionId: 'n1', label: '   ', body: 'Venue walkthrough on Saturday',
      requestedById: 'u-1', recipients: [known],
    });
    const created = repo.calls.created[0] as { label: string };
    assert.equal(created.label, 'Venue walkthrough on Saturday');
  });
});

describe('send — the gateway refuses or falls over', () => {
  /**
   * Deleting the row would be tidier and wrong. The gateway may have accepted
   * the batch and failed only to tell us, and a broadcast that might be running
   * needs a name somebody can look up.
   */
  it('keeps the row and marks it failed when the gateway does not answer', async () => {
    const repo = makeRepo();
    const gateway = makeGateway({
      sendBulk: async (): Promise<Result<never, InfraError>> =>
        err(new InfraError({ layer: 'http', op: 'openwa.sendBulk', cause: 'boom', message: 'ECONNREFUSED' })),
    });

    const sent = await service(repo, gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [known],
    });

    assert.equal(sent.ok, false);
    assert.equal(repo.calls.created.length, 1, 'the row must survive');
    assert.deepEqual(
      (repo.calls.status[0] as { status: string }).status,
      'failed',
    );
  });

  it('marks the broadcast sending once the gateway accepts it', async () => {
    const repo = makeRepo();
    await service(repo, makeGateway()).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [known],
    });
    assert.equal((repo.calls.status[0] as { status: string }).status, 'sending');
  });

  /**
   * The refusal crosses the seam as a code, not as a sentence. A caller that
   * wants to highlight the recipient list on `too_many` must not have to match
   * on English to know that is what happened.
   */
  it('refuses an over-cap list with a typed reason, not as a gateway error', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      waChatId: `91984501${String(i).padStart(4, '0')}@c.us`,
      displayName: `Person ${i}`,
      isGroup: false,
    }));
    const sent = await service(makeRepo(), makeGateway()).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: many,
    });

    assert.equal(sent.ok, false);
    const refusal = sent.ok === false ? refusalOf(sent.error) : null;
    assert.equal(refusal?.reason, 'too_many');
    // And the sentence is still there for the person reading the toast.
    assert.match(sent.ok === false ? sent.error.message : '', /over the limit/i);
  });

  it('does not read an unrelated failure as a refusal', async () => {
    const gateway = makeGateway({
      sendBulk: async (): Promise<Result<never, InfraError>> =>
        err(new InfraError({ layer: 'http', op: 'openwa.sendBulk', cause: 'x', message: 'ECONNREFUSED' })),
    });
    const sent = await service(makeRepo(), gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [known],
    });
    assert.equal(sent.ok === false && refusalOf(sent.error), null);
  });
});

describe('send — screening cold recipients', () => {
  const cold = { waChatId: '447700900123@c.us', displayName: 'New Lead', isGroup: false };

  /**
   * The send itself cannot answer this: the gateway returns 201 and a real
   * message id for a number nobody has ever registered. Without the check, a
   * broadcast to a mistyped list reports a hundred successes and delivers
   * nothing.
   */
  it('drops a cold number that is not on WhatsApp, and names it', async () => {
    const repo = makeRepo();
    const gateway = makeGateway({ checkNumber: async () => ok({ exists: false }) });

    const sent = await service(repo, gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [known, cold],
    });

    assert.equal(sent.ok, true);
    assert.deepEqual(sent.ok && sent.value.skipped, ['447700900123@c.us']);
    const created = repo.calls.created[0] as { recipients: { waChatId: string }[] };
    assert.deepEqual(created.recipients.map(r => r.waChatId), ['919845010001@c.us']);
  });

  /**
   * The gateway answers 503 for "WhatsApp did not answer the lookup" precisely
   * so it is not read as "this number does not exist". Silently dropping a real
   * client because a lookup timed out is the worse of the two errors.
   */
  it('keeps a cold recipient whose check could not be completed', async () => {
    const repo = makeRepo();
    const gateway = makeGateway({
      checkNumber: async (): Promise<Result<never, InfraError>> =>
        err(new InfraError({ layer: 'http', op: 'openwa.checkNumber', cause: 'x', message: '-> 503: unavailable' })),
    });

    const sent = await service(repo, gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [cold],
    });

    assert.equal(sent.ok, true);
    assert.deepEqual(sent.ok && sent.value.skipped, []);
    // Kept, and *named* — a recipient sent to without a completed check is a
    // different claim from one that was verified, and the caller is told which.
    assert.deepEqual(sent.ok && sent.value.unverified, ['447700900123@c.us']);
    const created = repo.calls.created[0] as { recipients: { waChatId: string }[] };
    assert.equal(created.recipients.length, 1);
  });

  /** A tracked chat has proven it exists by having spoken to us. */
  it('spends no requests checking numbers already in conversation', async () => {
    let checks = 0;
    const gateway = makeGateway({
      checkNumber: async () => { checks += 1; return ok({ exists: true }); },
    });
    await service(makeRepo(), gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [known],
    });
    assert.equal(checks, 0);
  });

  /**
   * Coldness is decided server-side, never trusted from the request. The client
   * computes the same flag to draw its warning, and a client that got it wrong
   * would otherwise skip the screening that flag triggers.
   */
  it('decides coldness from stored history rather than from the caller', async () => {
    let checked: string[] = [];
    const gateway = makeGateway({
      checkNumber: async (_session: string, digits: string) => {
        checked.push(digits); return ok({ exists: true });
      },
    });
    await service(makeRepo(), gateway).send({
      ...scope, sessionId: 'n1', label: 'Update', body: 'Hi',
      requestedById: 'u-1', recipients: [known, { ...cold, displayName: 'Lead' }],
    });
    // Only the unknown number was checked, whatever the request claimed.
    assert.deepEqual(checked, ['447700900123']);
  });
});

describe('poll', () => {
  const live = {
    id: 'bc-1', gatewayBatchId: 'divo_x', openwaSessionId: 'gw-1', status: 'sending',
  };

  it('folds the gateway counters into the stored broadcast', async () => {
    const repo = makeRepo();
    const result = await service(repo, makeGateway()).poll(live);

    assert.equal(result.ok, true);
    const applied = repo.calls.applied[0] as {
      status: string; sent: number; failed: number;
      results: { waChatId: string; status: string }[];
    };
    assert.equal(applied.status, 'completed');
    assert.equal(applied.sent, 1);
    assert.deepEqual(applied.results, [{
      waChatId: '919845010001@c.us', status: 'sent', waMessageId: 'true_x',
    }]);
  });

  /**
   * The gateway abandons in-flight batches across its own restart, deliberately,
   * because resuming risks double-sends. Nothing tells us it did — an abandoned
   * batch looks exactly like a running one until a poll comes back 404.
   */
  it('records a batch the gateway has forgotten as failed rather than leaving it running', async () => {
    const repo = makeRepo();
    const gateway = makeGateway({
      batchStatus: async (): Promise<Result<never, InfraError>> =>
        err(new InfraError({ layer: 'http', op: 'openwa.batchStatus', cause: 'x', message: 'OpenWA GET /x -> 404: Batch not found' })),
    });

    const result = await service(repo, gateway).poll(live);

    assert.equal(result.ok, true);
    assert.equal((repo.calls.status[0] as { status: string }).status, 'failed');
  });

  /**
   * A gateway that is merely unreachable must not be read as an answer. The row
   * keeps its old reading and its stale poll time, so the next tick tries again.
   */
  it('leaves the broadcast alone when the gateway is simply unreachable', async () => {
    const repo = makeRepo();
    const gateway = makeGateway({
      batchStatus: async (): Promise<Result<never, InfraError>> =>
        err(new InfraError({ layer: 'http', op: 'openwa.batchStatus', cause: 'x', message: 'ECONNREFUSED' })),
    });

    const result = await service(repo, gateway).poll(live);

    assert.equal(result.ok, false);
    assert.equal(repo.calls.status.length, 0);
    assert.equal(repo.calls.applied.length, 0);
  });

  it('trusts the gateway counters over the results array, which lags them', async () => {
    const repo = makeRepo();
    // The gateway persists batch progress every ten messages, so `results` can
    // legitimately be shorter than the counters it reports.
    const gateway = makeGateway({
      batchStatus: async () => ok({
        batchId: 'divo_x',
        status: 'processing',
        progress: { total: 20, sent: 12, failed: 1, pending: 7, cancelled: 0 },
        results: [{ chatId: '919845010001@c.us', status: 'sent' }],
      }),
    });

    await service(repo, gateway).poll(live);
    const applied = repo.calls.applied[0] as { sent: number; failed: number };
    assert.equal(applied.sent, 12);
    assert.equal(applied.failed, 1);
  });
});

describe('cancel', () => {
  const found = {
    id: 'bc-1', gatewayBatchId: 'divo_x', openwaSessionId: 'gw-1', status: 'sending',
  };

  /**
   * The immediate re-poll is what turns recipients still marked `pending` into
   * `cancelled`. Without it somebody reads a list claiming work is queued when
   * nothing will ever run.
   */
  it('re-reads the batch straight after stopping it', async () => {
    const repo = makeRepo({ findForScope: async () => ok(found) });
    const result = await service(repo, makeGateway()).cancel({ ...scope, broadcastId: 'bc-1' });

    assert.equal(result.ok, true);
    assert.equal(repo.calls.applied.length, 1);
  });

  it('reports honestly when the batch had already finished', async () => {
    const repo = makeRepo({ findForScope: async () => ok(found) });
    const gateway = makeGateway({
      cancelBatch: async () => ok({ batchId: 'divo_x', status: 'completed', alreadyFinished: true }),
    });

    const result = await service(repo, gateway).cancel({ ...scope, broadcastId: 'bc-1' });
    assert.equal(result.ok && result.value?.stopped, false);
  });

  /**
   * Another department's broadcast is indistinguishable from one that does not
   * exist — the only pair of answers that does not confirm its existence.
   */
  it('answers not-found for a broadcast outside the caller scope', async () => {
    const repo = makeRepo({ findForScope: async () => ok(null) });
    const result = await service(repo, makeGateway()).cancel({ ...scope, broadcastId: 'bc-1' });
    assert.equal(result.ok && result.value, null);
  });
});

describe('preview', () => {
  it('reports the refusal as words rather than failing', async () => {
    const preview = await service(makeRepo(), makeGateway()).preview({
      ...scope, recipients: [], body: 'Hi',
    });
    assert.equal(preview.ok, true);
    assert.match(preview.ok ? preview.value.refusal ?? '' : '', /at least one recipient/i);
  });

  it('marks an unknown number cold without asking the gateway', async () => {
    let checks = 0;
    const gateway = makeGateway({ checkNumber: async () => { checks += 1; return ok({ exists: true }); } });
    const preview = await service(makeRepo(), gateway).preview({
      ...scope,
      recipients: [known, { waChatId: '447700900123@c.us', displayName: 'Lead', isGroup: false }],
      body: 'Hi',
    });

    assert.equal(preview.ok && preview.value.reach.cold, 1);
    assert.equal(preview.ok && preview.value.refusal, null);
    // Previewing must stay free. Checking every cold number on each keystroke
    // would spend the gateway's throttle on a screen nobody has committed from.
    assert.equal(checks, 0);
  });

  it('estimates the paced duration from the recipient count', async () => {
    const preview = await service(makeRepo(), makeGateway()).preview({
      ...scope,
      recipients: [known, { waChatId: '919845010002@c.us', displayName: 'B', isGroup: false }],
      body: 'Hi',
    });
    // One gap, 3s delay plus up to 2s jitter.
    assert.equal(preview.ok && preview.value.estimatedSeconds, 5);
  });
});
