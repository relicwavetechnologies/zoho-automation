import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WhatsappSessionService,
  isMissingSession,
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
