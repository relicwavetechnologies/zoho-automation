/**
 * What the Broadcast tab calls.
 *
 * The one surface in Divo that writes to WhatsApp. Kept apart from
 * `follow-ups.routes.ts` — which shares its scope resolution and sits on the
 * same page — because the two do genuinely different things: everything there
 * reads what other people said, and everything here puts a message in front of
 * up to a hundred of them.
 *
 * Scoped to the caller's company *and* department, resolved server-side, with no
 * parameter for either. Inside that scope there are no roles today: this is
 * phase one, deliberately open, and the grant that limits the tab to Urban Aura
 * and the send to its managers is a separate piece of work. Nothing here assumes
 * it is absent — the routes are written so that adding a check is one middleware
 * rather than a rewrite.
 *
 * Every refusal is answered as a refusal. A recipient list over the cap, an
 * empty message, a duplicate chat id: 400 with the reason in words, never a 500
 * and never a silent truncation to the first hundred.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import type { AuditService } from '../../application/observability/audit.service';
import type { InfraError } from '../../shared/errors';
import {
  refusalOf,
  type WhatsappBroadcastService,
} from '../../application/whatsapp/whatsapp-broadcast.service';
import { isMissingSession } from '../../application/whatsapp/whatsapp-session.service';
import { MAX_BROADCAST_BODY, MAX_BROADCAST_RECIPIENTS } from '../../domain/follow-ups/broadcast';
import { createMemberScope, type MemberAuthorization } from './member-scope';
import { createAsyncRoute } from '../middleware/async-route';
import type { FollowUpsOperation } from '../../application/follow-ups/follow-ups-permission';
import { createRequiredAudit } from './required-audit';

/** A list route does not let its caller choose how much of the table to read. */
const LIST_LIMIT = { default: 25, max: 100 } as const;
const CANDIDATE_LIMIT = { default: 200, max: 500 } as const;

/**
 * A WhatsApp chat id, as the gateway actually spells them.
 *
 * Validated rather than passed through, because this string is what the send
 * addresses and the gateway's own error for a malformed one arrives too late to
 * be useful — after the batch is built.
 *
 * Four suffixes, and the list is taken from real stored rows rather than from
 * the spec's examples. That distinction cost a live send: written from the
 * examples alone this accepted only `@c.us` and `@g.us`, and every direct
 * message in the database is `@lid` — WhatsApp's privacy-preserving account id,
 * which newer clients use in place of a phone-derived one. The gateway hands
 * `@lid` back itself, from `contacts/check`.
 *
 *   <digits>@c.us            individual, whatsapp-web.js
 *   <digits>@s.whatsapp.net  individual, Baileys
 *   <digits>@lid             individual, privacy-preserving id
 *   <digits>@g.us            group — legacy ids carry a `-`, e.g. `9198…-1612…`
 *
 * The shape is still checked. The point of the rule is to catch a typo or a
 * caller trying its luck, not to second-guess which id scheme WhatsApp is using
 * this year.
 */
const waChatId = z.string().trim().regex(
  /^\d{5,20}(-\d{5,20})?@(c\.us|g\.us|lid|s\.whatsapp\.net)$/,
  'chat id must look like 919876543210@c.us, 12592995127491@lid, or 120363000000000000@g.us',
);

const recipientSchema = z.object({
  waChatId,
  displayName: z.string().trim().min(1).max(120),
  isGroup: z.boolean(),
});

const previewSchema = z.object({
  recipients: z.array(recipientSchema).max(MAX_BROADCAST_RECIPIENTS * 2),
  body: z.string().max(MAX_BROADCAST_BODY * 2),
});

const sendSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().trim().min(1),
  label: z.string().trim().max(80).optional(),
  body: z.string().min(1).max(MAX_BROADCAST_BODY),
  // Capped in the schema *and* in the domain. The schema stops an absurd payload
  // being parsed at all; the domain refusal is what produces a sentence a person
  // can act on, and is the one the service actually trusts.
  recipients: z.array(recipientSchema).min(1).max(MAX_BROADCAST_RECIPIENTS),
});

/**
 * A Zod failure, as a sentence somebody can act on.
 *
 * `error.message` on a ZodError is a JSON dump of every issue — accurate, and
 * useless in a toast. The web app surfaces whatever this returns verbatim, so it
 * has to name the field and say what was wrong with it. The first issue only:
 * a list of five complaints about one bad recipient is not five problems.
 */
const describeZodFailure = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return 'That request was not one Divo could read.';
  // `recipients.3.waChatId` reads better as "recipient 4" than as a path.
  const path = issue.path.join('.');
  const recipient = /^recipients\.(\d+)\./.exec(path);
  const where = recipient
    ? `recipient ${Number(recipient[1]) + 1}`
    : path || 'the request';
  return `${issue.message} (${where})`;
};

export interface BroadcastRoutesDeps {
  readonly broadcasts: WhatsappBroadcastService;
  readonly resolveDepartmentId: (input: {
    companyId: string;
    userId: string;
  }) => Promise<string | null>;
  /**
   * Whether this member holds `whatsappFollowUps.send`. The same function the
   * follow-ups routes use — the broadcast tab is the `send` half of one
   * capability, not a feature with a gate of its own.
   */
  readonly authorize: (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentId: string;
    readonly companyRole: string;
    readonly operation: FollowUpsOperation;
  }) => Promise<MemberAuthorization>;
  readonly auditService: AuditService;
  readonly logger: Logger;
}

export function createBroadcastRoutes(deps: BroadcastRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ router: 'broadcasts' });
  // Wraps every handler below. Express 4 lets a rejected async handler
  // become an unhandled rejection, and Node exits on those — one timed-out
  // query used to take the whole backend down with it.
  const route = createAsyncRoute(log);
  const requiredAudit = createRequiredAudit(deps.auditService, log);
  /*
   * Registered through these rather than on `router` directly, so the backstop
   * cannot be forgotten on a route added later. Naming them for the verb keeps
   * the sixteen registrations below reading the way they did.
   */
  type Handler = (req: Request, res: Response) => Promise<void>;
  const get = (path: string, handler: Handler) => router.get(path, route(handler));
  const post = (path: string, handler: Handler) => router.post(path, route(handler));
  const patch = (path: string, handler: Handler) => router.patch(path, route(handler));

  const scoped = createMemberScope<FollowUpsOperation>({
    resolveDepartmentId: deps.resolveDepartmentId,
    featureName: 'Broadcasts',
    authorize: deps.authorize,
    logger: log,
  });

  /**
   * Answer a failure as what it actually was.
   *
   * Three outcomes that must not be collapsed: the caller asked for something
   * Divo will not do (400, with the reason), the caller named a number that is
   * not theirs (404), and the gateway or database did not answer (502). A send
   * refused for being over the cap and a gateway that fell over look identical
   * from the outside unless this is done explicitly, and the first is fixable in
   * five seconds while the second is not fixable by the person reading it.
   */
  const answerFailure = (
    res: import('express').Response,
    error: InfraError,
    context: { op: string },
  ): void => {
    const refusal = refusalOf(error);
    if (refusal) {
      // The machine-readable reason travels beside the sentence. A client that
      // wants to highlight the recipient list on `too_many` and the textarea on
      // `body_too_long` can, without matching on English.
      res.status(400).json({
        ok: false,
        error: 'refused',
        reason: refusal.reason,
        message: error.message,
      });
      return;
    }
    if (isMissingSession(error)) {
      res.status(404).json({ ok: false, error: 'number_not_found' });
      return;
    }
    log.error(context.op, { error: error.message });
    res.status(502).json({
      ok: false,
      error: 'gateway_unavailable',
      message: 'The WhatsApp gateway did not answer. Nothing was sent.',
    });
  };

  const readLimit = (raw: unknown, bounds: { default: number; max: number }): number => {
    const asked = Number(raw);
    return Number.isFinite(asked)
      ? Math.min(bounds.max, Math.max(1, Math.trunc(asked)))
      : bounds.default;
  };

  const readNumber = (raw: unknown): string | undefined => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || undefined;
  };

  // ── Who you could send to ────────────────────────────────────────────────

  get('/candidates', async (req, res) => {
    const scope = await scoped(res, 'pickRecipients');
    if (!scope) return;

    const rows = await deps.broadcasts.candidates({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      ...(readNumber(req.query['number']) ? { sessionId: readNumber(req.query['number'])! } : {}),
      limit: readLimit(req.query['limit'], CANDIDATE_LIMIT),
    });
    if (!rows.ok) {
      answerFailure(res, rows.error, { op: 'broadcasts.candidates' });
      return;
    }

    res.json({
      ok: true,
      candidates: rows.value.candidates.map(row => ({
        waChatId: row.waChatId,
        name: row.name,
        isGroup: row.isGroup,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        sessionId: row.sessionId,
        sessionLabel: row.sessionLabel,
        openFollowUps: row.openFollowUps,
        weOwe: row.weOwe,
        waitingOn: row.waitingOn,
      })),
      maxRecipients: MAX_BROADCAST_RECIPIENTS,
      // Never present a truncated list as the whole list.
      truncated: rows.value.truncated,
    });
  });

  // ── What this send would do ──────────────────────────────────────────────

  /**
   * POST rather than GET, because the recipient list is the request.
   *
   * A hundred chat ids do not belong in a query string, and putting customer
   * identifiers there would write them into every access log between here and
   * the browser.
   */
  post('/preview', async (req, res) => {
    const scope = await scoped(res, 'previewBroadcast');
    if (!scope) return;

    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid_request', message: describeZodFailure(parsed.error) });
      return;
    }

    const preview = await deps.broadcasts.preview({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      recipients: parsed.data.recipients,
      body: parsed.data.body,
    });
    if (!preview.ok) {
      answerFailure(res, preview.error, { op: 'broadcasts.preview' });
      return;
    }

    res.json({ ok: true, ...preview.value });
  });

  // ── Send ─────────────────────────────────────────────────────────────────

  post('/', async (req, res) => {
    const scope = await scoped(res, 'sendBroadcast');
    if (!scope) return;

    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid_request', message: describeZodFailure(parsed.error) });
      return;
    }

    const auditId = await requiredAudit.begin(res, {
      actorId: scope.userId,
      companyId: scope.companyId,
      action: 'followups.broadcast.sent',
      metadata: {
        sessionId: parsed.data.sessionId,
        recipients: parsed.data.recipients.length,
        departmentId: scope.departmentId,
      },
    });
    if (!auditId) return;

    const sent = await deps.broadcasts.send({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      requestId: parsed.data.requestId,
      sessionId: parsed.data.sessionId,
      label: parsed.data.label ?? '',
      body: parsed.data.body,
      requestedById: scope.userId,
      recipients: parsed.data.recipients,
    });
    if (!sent.ok) {
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: {
          sessionId: parsed.data.sessionId,
          recipients: parsed.data.recipients.length,
          departmentId: scope.departmentId,
          error: sent.error.message,
        },
      });
      answerFailure(res, sent.error, { op: 'broadcasts.send' });
      return;
    }

    log.info('broadcasts.sent', {
      broadcastId: sent.value.broadcastId,
      userId: scope.userId,
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      sessionId: parsed.data.sessionId,
      recipients: parsed.data.recipients.length,
      skipped: sent.value.skipped.length,
      unverified: sent.value.unverified.length,
    });

    requiredAudit.settle(auditId, {
      outcome: 'success',
      metadata: {
        broadcastId: sent.value.broadcastId,
        sessionId: parsed.data.sessionId,
        departmentId: scope.departmentId,
        // Counts, never the numbers themselves. `skipped` and `unverified` are
        // arrays of customer phone numbers; the audit row says how many, and the
        // response body — which nothing persists — says which.
        recipients: parsed.data.recipients.length,
        skipped: sent.value.skipped.length,
        unverified: sent.value.unverified.length,
        gatewayAcknowledged: sent.value.gatewayAcknowledged,
      },
    });

    // 202, not 201. The gateway has accepted the batch and will pace it out over
    // the next few minutes; nothing has been delivered yet, and answering 201
    // would tell the screen the work is done at the moment it starts.
    res.status(202).json({
      ok: true,
      broadcastId: sent.value.broadcastId,
      // Named, not counted. "3 numbers were skipped" leaves somebody guessing
      // which three, and the answer decides whether it was a typo or a client
      // who genuinely is not on WhatsApp.
      skipped: sent.value.skipped,
      // Sent to, but never confirmed as reachable — the gateway could not
      // complete the check. Reported rather than folded into the success count,
      // because "sent" and "sent without knowing the number exists" are
      // different claims.
      unverified: sent.value.unverified,
      gatewayAcknowledged: sent.value.gatewayAcknowledged,
    });
  });

  // ── History and progress ─────────────────────────────────────────────────

  get('/', async (req, res) => {
    const scope = await scoped(res, 'listBroadcasts');
    if (!scope) return;

    const rows = await deps.broadcasts.list({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      ...(readNumber(req.query['number']) ? { sessionId: readNumber(req.query['number'])! } : {}),
      limit: readLimit(req.query['limit'], LIST_LIMIT),
    });
    if (!rows.ok) {
      answerFailure(res, rows.error, { op: 'broadcasts.list' });
      return;
    }

    res.json({
      ok: true,
      broadcasts: rows.value.broadcasts.map(toBroadcastJson),
      truncated: rows.value.truncated,
    });
  });

  get('/:id', async (req, res) => {
    const scope = await scoped(res, 'readBroadcast');
    if (!scope) return;

    const detail = await deps.broadcasts.detail({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      broadcastId: String(req.params['id']),
    });
    if (!detail.ok) {
      answerFailure(res, detail.error, { op: 'broadcasts.detail' });
      return;
    }
    if (!detail.value) {
      res.status(404).json({ ok: false, error: 'broadcast_not_found' });
      return;
    }

    res.json({
      ok: true,
      broadcast: toBroadcastJson(detail.value.broadcast),
      recipients: detail.value.recipients.map(recipient => ({
        waChatId: recipient.waChatId,
        displayName: recipient.displayName,
        isGroup: recipient.isGroup,
        status: recipient.status,
        error: recipient.error,
        sentAt: recipient.sentAt?.toISOString() ?? null,
      })),
    });
  });

  post('/:id/cancel', async (req, res) => {
    const scope = await scoped(res, 'cancelBroadcast');
    if (!scope) return;

    const broadcastId = String(req.params['id']);
    const auditId = await requiredAudit.begin(res, {
      actorId: scope.userId,
      companyId: scope.companyId,
      action: 'followups.broadcast.cancelled',
      metadata: { broadcastId, departmentId: scope.departmentId },
    });
    if (!auditId) return;

    const cancelled = await deps.broadcasts.cancel({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      broadcastId,
    });
    if (!cancelled.ok) {
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: {
          broadcastId,
          departmentId: scope.departmentId,
          error: cancelled.error.message,
        },
      });
      answerFailure(res, cancelled.error, { op: 'broadcasts.cancel' });
      return;
    }
    if (!cancelled.value) {
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: { broadcastId, departmentId: scope.departmentId, error: 'not_found' },
      });
      res.status(404).json({ ok: false, error: 'broadcast_not_found' });
      return;
    }
    if (cancelled.value.outcome === 'unknown') {
      log.warn('broadcasts.cancel_unknown', { broadcastId, userId: scope.userId });
      // Keep the audit checkpoint pending. The gateway may already have applied
      // the cancellation, so neither success nor failure is proven yet.
      res.status(202).json({ ok: true, outcome: 'unknown' });
      return;
    }

    log.info('broadcasts.cancelled', {
      broadcastId,
      userId: scope.userId,
      stopped: cancelled.value.stopped,
    });

    requiredAudit.settle(auditId, {
      outcome: 'success',
      metadata: {
        broadcastId,
        stopped: cancelled.value.stopped,
        departmentId: scope.departmentId,
      },
    });

    // `stopped: false` means it had already finished. The caller got what it
    // asked for either way, but the screen must not claim to have stopped a send
    // that had already gone out in full.
    res.json({ ok: true, outcome: 'confirmed', stopped: cancelled.value.stopped });
  });

  return router;
}

const toBroadcastJson = (row: {
  id: string; label: string; body: string; status: string;
  total: number; sent: number; failed: number;
  sessionId: string; sessionLabel: string;
  requestedByName: string | null;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
}) => ({
  id: row.id,
  label: row.label,
  body: row.body,
  status: row.status,
  total: row.total,
  sent: row.sent,
  failed: row.failed,
  pending: Math.max(0, row.total - row.sent - row.failed),
  sessionId: row.sessionId,
  sessionLabel: row.sessionLabel,
  requestedByName: row.requestedByName,
  startedAt: row.startedAt?.toISOString() ?? null,
  completedAt: row.completedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});
