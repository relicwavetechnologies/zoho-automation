import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WhatsappSessionService,
  isMissingSession,
  isSessionProvisionUnknown,
} from '../../src/application/whatsapp/whatsapp-session.service.ts';
import { InfraError } from '../../src/shared/errors.ts';
import { err, ok } from '../../src/shared/result.ts';
import type { WhatsappSessionRow } from '../../src/infrastructure/persistence/whatsapp.repository.ts';

/**
 * Linking a handset, through the interface the web app actually uses.
 *
 * The three things this seam has to get right, and each of them is a way the
 * link dialog silently lies if it does not:
 *  - the gateway's status wording is normalized before it leaves, so a client
 *    never substring-matches `"disconnected"` into `"connected"`. The statuses
 *    used here are the gateway's real ones, from its `openapi.json`;
 *  - a poll that sees the scan finish writes it back, so the number stops
 *    reading "waiting to be linked" while somebody is looking straight at it;
 *  - "no such number" and "the gateway is down" stay distinguishable.
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
  phoneE164: null,
  status: 'pending',
  lastSeenAt: null,
  createdAt: new Date('2026-08-29T06:00:00Z'),
  darkSince: null,
};

const SCOPE = { companyId: 'company-1', departmentId: 'dept-ua' };

/** Only the parts of the two ports pairing touches. */
function build(over: {
  sessions?: WhatsappSessionRow[];
  pairing?: unknown;
  pairingFails?: boolean;
} = {}) {
  const statusWrites: { sessionId: string; status: string; phoneE164?: string }[] = [];
  const rows = over.sessions ?? [SESSION];

  const repo = {
    async listSessions() { return ok(rows); },
    async updateSessionStatus(input: { sessionId: string; status: string; phoneE164?: string }) {
      statusWrites.push(input);
      return ok(undefined);
    },
  } as any;

  const gateway = {
    // Read only on the transition to linked: the QR response carries no phone
    // number, and the row would otherwise say "number not known yet" until the
    // next sweep.
    async session() {
      return ok({ id: 'divo-ua-bookings-x1', status: 'ready', phone: '919876543210' });
    },
    async pairing() {
      if (over.pairingFails) {
        return err(new InfraError({ layer: 'http', op: 'openwa.pairing', cause: 'ECONNREFUSED' }));
      }
      return ok(over.pairing ?? { status: 'qr_ready' });
    },
    async pairingCode() { return ok({ pairingCode: 'ABCD-1234', status: 'qr_ready' }); },
  } as any;

  const service = new WhatsappSessionService({ repo, gateway, logger: noopLogger });
  return { service, statusWrites };
}

describe('pairing', () => {
  it('normalizes the gateway wording before it leaves the service', async () => {
    // The gateway says "READY"; a client must not be the thing deciding
    // what that means, and must never see the raw word to match on.
    const { service } = build({ pairing: { status: 'READY' } });
    const result = await service.pairing('session-1', SCOPE);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.status, 'linked');
  });

  it('writes the link back the moment the poll sees it', async () => {
    const { service, statusWrites } = build({ pairing: { status: 'ready' } });
    await service.pairing('session-1', SCOPE);
    assert.deepEqual(statusWrites, [{
      sessionId: 'session-1',
      status: 'linked',
      // Captured on the same transition, and normalised to E.164 here rather
      // than by whoever renders it.
      phoneE164: '+919876543210',
    }]);
  });

  it('does not write on every poll of an unchanged status', async () => {
    // The dialog polls every few seconds. A person who leaves it open on an
    // unscanned QR must not generate an UPDATE per poll.
    const { service, statusWrites } = build({ pairing: { status: 'qr_ready' } });
    await service.pairing('session-1', SCOPE);
    await service.pairing('session-1', SCOPE);
    assert.equal(statusWrites.length, 0);
  });

  it('labels a rendered QR apart from a raw payload', async () => {
    const image = await build({
      pairing: { status: 'qr_ready', qrCode: 'data:image/png;base64,iVBORw0KGgo=' },
    }).service.pairing('session-1', SCOPE);
    assert.deepEqual(image.ok && image.value.qr, {
      kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=',
    });

    // A `2@...` string in an <img src> draws a broken image, which reads as
    // "linking is broken" rather than "this gateway returns a format the screen
    // cannot draw".
    const payload = await build({
      pairing: { status: 'qr_ready', qrCode: '2@abc123def/xyz==' },
    }).service.pairing('session-1', SCOPE);
    assert.deepEqual(payload.ok && payload.value.qr, {
      kind: 'payload', value: '2@abc123def/xyz==',
    });
  });

  it('omits the QR rather than reporting an empty one', async () => {
    const { service } = build({ pairing: { status: 'ready', qrCode: '   ' } });
    const result = await service.pairing('session-1', SCOPE);
    assert.equal(result.ok && result.value.qr, undefined);
  });
});

describe('isMissingSession', () => {
  it('is true for an id that names no number in this department', async () => {
    const { service } = build();
    const result = await service.pairing('session-other-dept', SCOPE);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && isMissingSession(result.error), true);
  });

  it('is false when the gateway itself did not answer', async () => {
    // The distinction the routes turn into 404 vs 502. Collapsing them sends
    // somebody hunting for a handset that is sitting in the list.
    const { service } = build({ pairingFails: true });
    const result = await service.pairing('session-1', SCOPE);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && isMissingSession(result.error), false);
  });
});

describe('session provisioning', () => {
  const request = {
    ...SCOPE,
    label: 'Bookings desk',
    requestId: '8dbca8a5-2d5a-4ee5-b8a4-a6fd3f706389',
  };

  it('adopts the deterministic gateway session on a retry', async () => {
    let createdName = '';
    let createCalls = 0;
    const remote: any[] = [];
    const gateway = {
      listSessions: async () => ok(remote),
      createSession: async (name: string) => {
        createCalls += 1;
        createdName = name;
        const row = { id: 'gw-1', name, status: 'ready' };
        remote.push(row);
        return ok(row);
      },
      startSession: async () => ok({}),
      ensureWebhook: async () => ok({ created: true, url: 'http://divo/webhook' }),
    } as any;
    const repo = {
      createSession: async (input: any) => ok({ ...SESSION, openwaSessionId: input.openwaSessionId }),
    } as any;
    const service = new WhatsappSessionService({ repo, gateway, logger: noopLogger });

    const first = await service.create(request);
    const second = await service.create(request);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(createCalls, 1);
    assert.match(createdName, /^divo-dept-ua-/);
  });

  it('recovers a session whose create response was lost', async () => {
    let lists = 0;
    let createdName = '';
    let startedSession = '';
    const gateway = {
      listSessions: async () => {
        lists += 1;
        return ok(lists === 1 ? [] : [{ id: 'gw-lost', name: createdName, status: 'created' }]);
      },
      createSession: async (name: string) => {
        createdName = name;
        return err(new InfraError({ layer: 'http', op: 'openwa.createSession', cause: 'timeout' }));
      },
      startSession: async (sessionId: string) => {
        startedSession = sessionId;
        return ok({});
      },
      ensureWebhook: async () => ok({ created: true, url: 'http://divo/webhook' }),
    } as any;
    const repo = {
      createSession: async (input: any) => ok({ ...SESSION, openwaSessionId: input.openwaSessionId }),
    } as any;
    const result = await new WhatsappSessionService({ repo, gateway, logger: noopLogger }).create(request);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.openwaSessionId, 'gw-lost');
    assert.equal(startedSession, 'gw-lost');
  });

  it('marks a post-create webhook failure as provisioning uncertainty', async () => {
    const gateway = {
      listSessions: async () => ok([]),
      createSession: async (name: string) => ok({ id: 'gw-1', name, status: 'ready' }),
      startSession: async () => ok({}),
      ensureWebhook: async () => err(new InfraError({
        layer: 'http', op: 'openwa.createWebhook', cause: 'timeout', message: 'timeout',
      })),
    } as any;
    const result = await new WhatsappSessionService({
      repo: { createSession: async () => ok(SESSION) } as any,
      gateway,
      logger: noopLogger,
    }).create(request);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && isSessionProvisionUnknown(result.error), true);
  });
});

/**
 * When a linked handset is worth an alarm, and when it is merely new.
 *
 * `lastSeenAt` is null until the first webhook arrives, and reading that as
 * instantly stale is what put "9261202094 is not being read — treat the counts
 * below as an undercount" on screen ninety seconds after a number was scanned.
 * Nothing was missing. Nobody had messaged it yet.
 */
describe('a number nobody has messaged yet', () => {
  const listWith = async (row: WhatsappSessionRow) => {
    const service = new WhatsappSessionService({
      repo: { listSessions: async () => ok([row]) } as any,
      gateway: {} as any,
      logger: noopLogger,
    });
    const listed = await service.list(SCOPE);
    assert.equal(listed.ok, true);
    return listed.ok ? listed.value[0]! : undefined!;
  };

  it('is not stale while it is still inside the grace every handset gets', async () => {
    const view = await listWith({
      ...SESSION, status: 'linked', lastSeenAt: null, createdAt: new Date(),
    });
    assert.equal(view.stale, false);
    assert.equal(view.awaitingFirstMessage, true);
  });

  it('becomes stale once it has been silent since it was linked', async () => {
    // The alarm still works — it is measured from the link, not from nothing.
    const view = await listWith({
      ...SESSION,
      status: 'linked',
      lastSeenAt: null,
      createdAt: new Date(Date.now() - 72 * 60 * 60_000),
    });
    assert.equal(view.stale, true);
    assert.equal(view.awaitingFirstMessage, false);
  });

  it('leaves a handset that has spoken judged by when it last spoke', async () => {
    const view = await listWith({
      ...SESSION,
      status: 'linked',
      lastSeenAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 72 * 60 * 60_000),
    });
    assert.equal(view.stale, false);
    assert.equal(view.awaitingFirstMessage, false);
  });
});
