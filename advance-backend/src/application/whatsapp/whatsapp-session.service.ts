import type { Logger } from '../../shared/logger';
import { InfraError } from '../../shared/errors';
import { sha256 } from '../../shared/hash';
import { err, ok, type Result } from '../../shared/result';
import {
  normalizeGatewaySessionStatus,
  type WhatsappSessionStatus,
} from '../../domain/follow-ups/session-status';
import type { OpenWaClient } from '../../infrastructure/whatsapp/openwa.client';
import type {
  WhatsappRepoPort,
  WhatsappSessionRow,
} from '../../infrastructure/persistence/whatsapp.repository';

/**
 * Linking a handset, from the web app.
 *
 * Urban Aura's people do this themselves, and they never see the OpenWA
 * dashboard — so the QR has to be proxied out through Divo. It rotates roughly
 * every twenty seconds, which is why `pairing()` is a live read on every poll
 * and nothing here caches one. A saved QR is stale before it can be scanned;
 * the agent's own README warns about exactly that.
 */

/**
 * What the link dialog is told.
 *
 * The gateway's `OpenWaPairing` with its status normalized. The web app decides
 * "linked, close the dialog" from this, so it must not be reading the gateway's
 * raw wording — `"disconnected"` contains `"connect"`, and a client matching on
 * substrings gets that backwards.
 */
export interface PairingView {
  /** Rotates roughly every twenty seconds. Never stored. */
  readonly qr?: PairingQr;
  readonly pairingCode?: string;
  readonly status: WhatsappSessionStatus;
}

/**
 * A QR, labelled with what it actually is.
 *
 * The gateway may hand back either a rendered image or the raw payload a QR
 * encodes, and the two are not interchangeable: putting a `2@...` string into an
 * `<img src>` draws a broken image, which reads as "linking is broken" rather
 * than "this gateway returns a format this screen cannot draw". Deciding it here
 * keeps the guess in the one module that knows the gateway, and lets the web app
 * offer the pairing code instead of a picture that was never going to appear.
 */
export type PairingQr =
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'payload'; readonly value: string };

const readQr = (raw: string | undefined): PairingQr | null => {
  const value = raw?.trim();
  if (!value) return null;
  if (/^data:image\//i.test(value)) return { kind: 'image', src: value };
  return { kind: 'payload', value };
};

export interface LinkedSessionView {
  readonly id: string;
  readonly label: string;
  readonly phoneE164: string | null;
  readonly status: string;
  readonly lastSeenAt: Date | null;
  /** True once the handset has been quiet longer than the alarm allows. */
  readonly stale: boolean;
  /**
   * When delivery is believed to have stopped, while the gap is still unfilled.
   *
   * Survives the handset reconnecting on purpose. Once messages flow again every
   * other trace of the outage is gone, but the ones sent during it are still
   * missing — this is what the web app shows, and what the re-read button
   * clears.
   */
  readonly darkSince: Date | null;
}

/**
 * How long a linked number may go quiet before it is called out.
 *
 * Generous on purpose. A real handset can be quiet for a day without anything
 * being wrong, and an alarm that cries wolf is worse than none. What it catches
 * is the failure the imported agent could not see at all: a session that logged
 * out, or a webhook that was replaced, so messages simply stop arriving and the
 * silence reads as a slow week.
 */
export const SESSION_STALE_AFTER_MS = 36 * 60 * 60_000;
const PROVISION_UNKNOWN_OP = 'whatsapp.sessionProvisionUnknown';

export const isSessionProvisionUnknown = (error: InfraError): boolean =>
  error.payload.op === PROVISION_UNKNOWN_OP;

const provisionUnknown = (cause: InfraError): InfraError => new InfraError({
  layer: 'http',
  op: PROVISION_UNKNOWN_OP,
  cause,
  message: 'Divo could not confirm whether the WhatsApp session finished provisioning.',
});

export class WhatsappSessionService {
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      readonly repo: WhatsappRepoPort;
      readonly gateway: OpenWaClient;
      readonly logger: Logger;
    },
  ) {
    this.log = deps.logger.child({ service: 'whatsapp-sessions' });
  }

  async list(scope: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<readonly LinkedSessionView[], InfraError>> {
    const rows = await this.deps.repo.listSessions(scope);
    if (!rows.ok) return rows;
    const now = Date.now();
    return ok(rows.value.map(row => toView(row, now)));
  }

  /**
   * Create a session and point its webhook at Divo, before anybody scans
   * anything.
   *
   * Registering the webhook first is the ordering that matters: a handset that
   * links while no subscription exists delivers its first messages into
   * nothing, and nothing later goes back for them.
   */
  async create(input: {
    companyId: string;
    departmentId: string;
    label: string;
    requestId: string;
  }): Promise<Result<WhatsappSessionRow, InfraError>> {
    // OpenWA assigns the id, but it returns this name from `GET /sessions`.
    // Binding the reviewed request to a stable name lets a retry adopt a session
    // whose create/start response was lost instead of creating another one.
    const gatewayName = [
      'divo',
      input.departmentId.slice(0, 8),
      sha256(input.requestId).slice(0, 12),
      slug(input.label).slice(0, 24),
    ].join('-');

    const listed = await this.deps.gateway.listSessions();
    if (!listed.ok) return listed;
    let remote = listed.value.find(session => session.name === gatewayName);

    if (!remote) {
      const created = await this.deps.gateway.createSession(gatewayName);
      if (created.ok) {
        remote = created.value;
      } else {
        // The POST or its `/start` call may have succeeded before the response
        // was lost. Re-read by deterministic name before declaring uncertainty.
        const recovered = await this.deps.gateway.listSessions();
        remote = recovered.ok
          ? recovered.value.find(session => session.name === gatewayName)
          : undefined;
        if (!remote) return err(provisionUnknown(created.error));
      }
    }

    if (remote.status === 'created' || remote.status === 'failed') {
      const started = await this.deps.gateway.startSession(remote.id);
      if (!started.ok) return err(provisionUnknown(started.error));
    }

    const gatewayId = remote.id;

    const hooked = await this.deps.gateway.ensureWebhook(gatewayId);
    if (!hooked.ok) return err(provisionUnknown(hooked.error));

    const row = await this.deps.repo.createSession({
      companyId: input.companyId,
      departmentId: input.departmentId,
      label: input.label,
      openwaSessionId: gatewayId,
    });
    if (!row.ok) return err(provisionUnknown(row.error));

    this.log.info('whatsapp.session_created', {
      sessionId: row.value.id,
      openwaSessionId: gatewayId,
      gatewayName,
      webhookCreated: hooked.value.created,
    });
    return row;
  }

  /**
   * The live pairing state, polled by the web app while the dialog is open.
   *
   * The poll is also the reconcile. A handset that finishes scanning tells the
   * gateway, not Divo, so without writing the status back here the number would
   * keep reading "waiting to be linked" until the next sweep came round — the
   * person is looking straight at the screen at that exact moment, and a page
   * that still says pending is one they retry, or give up on.
   *
   * The normalized status is what leaves this method. The gateway's own wording
   * varies ("CONNECTED", "authenticated", "qr"), and `normalizeGatewaySessionStatus`
   * is the one place that decides what those mean.
   */
  async pairing(sessionId: string, scope: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<PairingView, InfraError>> {
    const session = await this.requireSession(sessionId, scope);
    if (!session.ok) return session;

    const pairing = await this.deps.gateway.pairing(session.value.openwaSessionId);
    if (!pairing.ok) return pairing;

    const status = normalizeGatewaySessionStatus(pairing.value.status);
    const persisted = await this.persistPairingStatus(session.value, status);
    if (!persisted.ok) return persisted;

    const qr = readQr(pairing.value.qrCode);
    return ok({
      ...(qr ? { qr } : {}),
      ...(pairing.value.pairingCode ? { pairingCode: pairing.value.pairingCode } : {}),
      status,
    });
  }

  /** The fallback when a QR will not take: WhatsApp shows a code to type. */
  async pairingCode(sessionId: string, phoneE164: string, scope: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<PairingView, InfraError>> {
    const session = await this.requireSession(sessionId, scope);
    if (!session.ok) return session;

    const issued = await this.deps.gateway.pairingCode(
      session.value.openwaSessionId, phoneE164,
    );
    if (!issued.ok) return issued;

    const qr = readQr(issued.value.qrCode);
    return ok({
      ...(qr ? { qr } : {}),
      ...(issued.value.pairingCode ? { pairingCode: issued.value.pairingCode } : {}),
      status: normalizeGatewaySessionStatus(issued.value.status),
    });
  }

  /**
   * Look a session up within its department, for a caller acting on a member's
   * behalf. Exposed so the re-read route can resolve the id it was given
   * without reaching past this module into the repository.
   */
  async findInScope(sessionId: string, scope: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<WhatsappSessionRow, InfraError>> {
    return this.requireSession(sessionId, scope);
  }

  /**
   * Reconcile one session's stored status against the gateway.
   *
   * Divo's row is a cache of something the gateway owns. A handset can log out
   * on the phone without telling us, so the stored status is only ever as good
   * as the last time somebody asked.
   */
  async refreshStatus(sessionId: string, scope: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<WhatsappSessionStatus, InfraError>> {
    // `sessionId` is Divo's row id here, as on every other method of this class.
    // It previously took the gateway's id instead — same name, same type,
    // different identifier space — which fails as "not found" rather than as a
    // type error, and only at runtime.
    const row = await this.requireSession(sessionId, scope);
    if (!row.ok) return row;

    const remote = await this.deps.gateway.session(row.value.openwaSessionId);
    if (!remote.ok) return remote;

    const status = normalizeGatewaySessionStatus(remote.value.status);
    const updated = await this.deps.repo.updateSessionStatus({
      sessionId: row.value.id,
      status,
      ...(remote.value.phone ? { phoneE164: remote.value.phone } : {}),
    });
    if (!updated.ok) return updated;
    return ok(status);
  }

  /**
   * Write back what the poll just learned, and only when it is news.
   *
   * Skipping the no-op write matters: the dialog polls every few seconds, and a
   * person who leaves it open on a QR that has not been scanned would otherwise
   * generate an UPDATE per poll for a value that never changed.
   */
  private async persistPairingStatus(
    session: WhatsappSessionRow,
    status: WhatsappSessionStatus,
  ): Promise<Result<void, InfraError>> {
    if (session.status === status) return ok(undefined);

    // Linking is the moment the handset's own number becomes knowable, and the
    // QR response does not carry it. One extra read, only on the transition, so
    // the row stops saying "number not known yet" the instant it is known
    // rather than waiting for the next reconcile sweep — the person who just
    // scanned is looking straight at that row.
    let phoneE164: string | undefined;
    if (status === 'linked') {
      const remote = await this.deps.gateway.session(session.openwaSessionId);
      // Not fatal. A phone we could not read is worth less than a link we
      // refuse to record, and the sweep will fill it in.
      if (remote.ok && remote.value.phone) phoneE164 = toE164(remote.value.phone);
      else if (!remote.ok) {
        this.log.warn('whatsapp.phone_read_failed', {
          sessionId: session.id, error: remote.error.message,
        });
      }
    }

    const updated = await this.deps.repo.updateSessionStatus({
      sessionId: session.id,
      status,
      ...(phoneE164 ? { phoneE164 } : {}),
    });
    if (!updated.ok) return updated;

    this.log.info('whatsapp.session_status_changed', {
      sessionId: session.id, from: session.status, to: status, via: 'pairing',
    });
    return ok(undefined);
  }

  private async requireSession(sessionId: string, scope: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<WhatsappSessionRow, InfraError>> {
    const rows = await this.deps.repo.listSessions(scope);
    if (!rows.ok) return rows;
    const found = rows.value.find(row => row.id === sessionId);
    // Scoped by department, so asking for another department's session id is
    // indistinguishable from asking for one that does not exist.
    if (!found) return err(missingSession(sessionId));
    return ok(found);
  }
}

function toView(row: WhatsappSessionRow, now: number): LinkedSessionView {
  const stale = row.status === 'linked'
    && (row.lastSeenAt === null || now - row.lastSeenAt.getTime() > SESSION_STALE_AFTER_MS);
  return {
    id: row.id,
    label: row.label,
    phoneE164: row.phoneE164,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    stale,
    darkSince: row.darkSince,
  };
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'number';

const MISSING_SESSION_OP = 'whatsapp.requireSession';

/**
 * The gateway reports a bare `919891111548`; Divo stores and displays E.164.
 *
 * Normalised in one place so the web app is not the thing deciding whether a
 * number needs a `+` in front of it.
 */
const toE164 = (raw: string): string => {
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
};

const missingSession = (sessionId: string): InfraError =>
  new InfraError({
    layer: 'prisma',
    op: MISSING_SESSION_OP,
    cause: sessionId,
    message: `WhatsApp session ${sessionId} not found`,
  });

/**
 * Whether a failure means "no such number here", rather than "the gateway or
 * the database did not answer".
 *
 * Part of this module's interface, not a detail. Every method that takes a
 * session id can fail either way, and a route that cannot tell them apart
 * reports a dead gateway as a missing number — sending somebody to hunt for a
 * handset that is sitting right there in the list.
 */
export const isMissingSession = (error: InfraError): boolean =>
  error.payload.op === MISSING_SESSION_OP;
