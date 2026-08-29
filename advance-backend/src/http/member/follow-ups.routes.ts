/**
 * What the follow-ups tab calls.
 *
 * Everything here is scoped to the signed-in member's company *and* department,
 * resolved server-side. There is no departmentId parameter and no way to ask
 * about another department's conversations — Urban Aura shares a company with
 * others, and a customer's WhatsApp thread should not be readable from a
 * department that has no part in it.
 *
 * Inside that scope there are no roles. Every member of the department sees
 * every follow-up and may act on any of them, which is what the team asked for:
 * one shared pool, nothing assigned to anybody.
 *
 * Note the route that is *not* here: there is no follow-up assignment endpoint,
 * because `owner` names a side rather than a person and a route would be the
 * first place that stopped being true.
 *
 * Writing to WhatsApp is not here either, but it does now exist. It lives in
 * `broadcasts.routes.ts`, apart from this file on purpose: everything below
 * reads what other people said, and a send is a different act with a different
 * blast radius. The follow-up analyser still has no way to send — a broadcast is
 * a message a person typed, reviewed and paid for out of one handset's daily
 * allowance, never something Divo composes on anybody's behalf.
 */
import { Router, type Request, type Response } from 'express';
import type { InfraError } from '../../shared/errors';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import type { AuditService } from '../../application/observability/audit.service';
import {
  isMissingSession,
  isSessionProvisionUnknown,
  type WhatsappSessionService,
} from '../../application/whatsapp/whatsapp-session.service';
import type { WhatsappHistoryRepair } from '../../application/whatsapp/whatsapp-history-repair';
import type { FollowUpsRepoPort } from '../../infrastructure/persistence/follow-ups.repository';
import { ownerLabel, type FollowUpOwner } from '../../domain/follow-ups/follow-up';
import { createMemberScope, type MemberAuthorization } from './member-scope';
import { createAsyncRoute } from '../middleware/async-route';
import type { FollowUpsOperation } from '../../application/follow-ups/follow-ups-permission';
import {
  recurringScheduleSchema,
  nextRecurringRunAt,
} from '../../application/scheduling/recurring-schedule';
import type { AuthorizeLarkChatDestination } from '../../application/mail-ops/lark-chat-destination';
import { createRequiredAudit } from './required-audit';

/** A list route does not let its caller choose how much of the table to read. */
const LIST_LIMIT = { default: 100, max: 200 } as const;

const createNumberSchema = z.object({
  label: z.string().trim().min(1).max(60),
  requestId: z.string().uuid(),
});

const muteSchema = z.object({
  muted: z.boolean(),
});

/**
 * The four things a person can do to a follow-up.
 *
 * `snooze` carries hours rather than a timestamp so the client cannot arm a
 * nudge in the past, and is capped at a month — beyond that the honest action
 * is to dismiss it, and a reminder nobody expects a year from now is worse
 * than none.
 */
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('done'), reason: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('dismiss'), reason: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('snooze'), hours: z.number().int().min(1).max(24 * 31) }),
  z.object({ action: z.literal('reopen') }),
]);

/**
 * One audit action name per verb, so the trail reads in the tense of what
 * happened rather than of what was asked for.
 *
 * Keyed by the schema's own union rather than by `string`: a fifth verb added
 * to `actionSchema` becomes a compile error here, instead of an audit row
 * quietly named `followups.item.undefined`.
 */
const FOLLOW_UP_AUDIT_ACTIONS: Record<z.infer<typeof actionSchema>['action'], string> = {
  done:    'followups.item.resolved',
  dismiss: 'followups.item.dismissed',
  snooze:  'followups.item.snoozed',
  reopen:  'followups.item.reopened',
};

const pairingCodeSchema = z.object({
  // E.164. Validated here because the gateway's error for a malformed number is
  // indistinguishable from its error for an unreachable one.
  phoneE164: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164, e.g. +919876543210'),
});

export interface FollowUpRoutesDeps {
  readonly followUps: FollowUpsRepoPort;
  readonly sessions: WhatsappSessionService;
  readonly historyRepair: WhatsappHistoryRepair;
  /**
   * The member's active department. Shared with mail automations rather than
   * re-derived: two answers to "which department is this person in" is exactly
   * the duplicate authority AGENTS.md rule 5 forbids.
   */
  readonly resolveDepartmentId: (input: {
    companyId: string;
    userId: string;
  }) => Promise<string | null>;
  /**
   * Whether this member holds `whatsappFollowUps` for the action they are
   * asking for. The same function the broadcast routes use, and the same
   * decision an agent tool will make when one exists — one copy, so Divo cannot
   * answer one person two different ways depending on where they asked.
   */
  readonly authorize: (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentId: string;
    readonly companyRole: string;
    readonly operation: FollowUpsOperation;
  }) => Promise<MemberAuthorization>;
  /**
   * Grounds a Lark room before the digest is pointed at it.
   *
   * The same guard Mail Ops uses and the runner already applies at delivery,
   * called here as well because this is where a room is really vetted: a
   * refusal at creation is one setup step, and a refusal at delivery is a
   * digest that silently never arrives.
   */
  readonly authorizeLarkChat: AuthorizeLarkChatDestination;
  readonly auditService: AuditService;
  readonly logger: Logger;
}

export function createFollowUpRoutes(deps: FollowUpRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ router: 'follow-ups' });
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
  const put = (path: string, handler: Handler) => router.put(path, route(handler));

  /** Resolve the caller's scope, or answer for them. Shared with the broadcast routes. */
  const scoped = createMemberScope<FollowUpsOperation>({
    resolveDepartmentId: deps.resolveDepartmentId,
    featureName: 'Follow-ups',
    authorize: deps.authorize,
    logger: log,
  });

  /**
   * Answer a session-scoped failure as what it actually was.
   *
   * Every route that takes a number id can fail two ways, and they need
   * different answers: an id that names no number in this department is the
   * caller's mistake, and a gateway or database that did not answer is ours.
   * Collapsing both into 404 sent people hunting for a handset that was sitting
   * in the list the whole time.
   */
  const answerSessionFailure = (
    res: Response,
    error: InfraError,
    context: { op: string; sessionId: string },
  ): void => {
    if (isMissingSession(error)) {
      res.status(404).json({ ok: false, error: 'number_not_found' });
      return;
    }
    log.error(context.op, { sessionId: context.sessionId, error: error.message });
    res.status(502).json({
      ok: false,
      error: 'gateway_unavailable',
      detail: 'The WhatsApp gateway did not answer. The number itself is fine.',
    });
  };

  // ── The list ─────────────────────────────────────────────────────────────

  get('/', async (req, res) => {
    const scope = await scoped(res, 'list');
    if (!scope) return;

    const asked = Number(req.query['limit']);
    const limit = Number.isFinite(asked)
      ? Math.min(LIST_LIMIT.max, Math.max(1, Math.trunc(asked)))
      : LIST_LIMIT.default;

    // What the digest card's link carries, so tapping one number's card lands
    // on that number rather than the whole team's list.
    const number = typeof req.query['number'] === 'string' ? req.query['number'].trim() : '';

    const rows = await deps.followUps.listOpen({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      limit,
      ...(number ? { sessionId: number } : {}),
    });
    if (!rows.ok) {
      log.error('follow_ups.list_failed', { error: rows.error.message });
      res.status(500).json({ ok: false, error: 'follow_ups_unavailable' });
      return;
    }

    res.json({
      ok: true,
      followUps: rows.value.map(row => ({
        id: row.id,
        title: row.title,
        detail: row.detail,
        kind: row.kind,
        // Rendered server-side so one rule decides how a side is worded. A
        // client that built this string itself would be the second place that
        // could turn "we owe" into "you owe".
        ownerLabel: ownerLabel(row.owner as FollowUpOwner, row.counterparty),
        owner: row.owner,
        counterparty: row.counterparty,
        dueDate: row.dueDate,
        urgency: row.urgency,
        chatId: row.chatId,
        chatName: row.chatName,
        remindAt: row.remindAt,
        updatedAt: row.updatedAt,
        sessionId: row.sessionId,
      })),
      // Never present a truncated list as the whole list.
      truncated: rows.value.length === limit,
      limit,
      // Echoed so the screen can say it is showing one number rather than
      // everything — a filtered list that looks unfiltered reads as "the team
      // has almost nothing outstanding".
      ...(number ? { number } : {}),
    });
  });

  /**
   * Done, dismissed, snoozed, or reopened.
   *
   * There is no assignee here for the same reason there is no assignment route:
   * `owner` is a side rather than a person. Anyone in the department may act on
   * anything, which is what the team asked for, so the only identity this needs
   * is the one in the audit line.
   */
  patch('/:id', async (req, res) => {
    const scope = await scoped(res, 'resolve');
    if (!scope) return;

    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false, error: 'invalid_action', detail: parsed.error.issues[0]?.message,
      });
      return;
    }

    const followUpId = String(req.params['id']);
    const auditAction = FOLLOW_UP_AUDIT_ACTIONS[parsed.data.action];
    const auditId = await requiredAudit.begin(res, {
      actorId: scope.userId,
      companyId: scope.companyId,
      action: auditAction,
      metadata: { followUpId, departmentId: scope.departmentId },
    });
    if (!auditId) return;
    const change = parsed.data.action === 'snooze'
      ? { remindAt: new Date(Date.now() + parsed.data.hours * 60 * 60_000) }
      : parsed.data.action === 'reopen'
        // Reopening clears the reason too. Leaving "sent it yesterday" attached
        // to an item somebody just reopened is a stale note that reads as fact.
        ? { status: 'open' as const, resolvedReason: null }
        : {
            status: parsed.data.action === 'done' ? ('resolved' as const) : ('dismissed' as const),
            resolvedReason: parsed.data.reason ?? 'closed by the team',
          };

    const updated = await deps.followUps.setFollowUpState({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      followUpId,
      ...change,
    });
    if (!updated.ok) {
      log.error('follow_ups.action_failed', {
        followUpId, action: parsed.data.action, error: updated.error.message,
      });
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: {
          followUpId,
          departmentId: scope.departmentId,
          error: updated.error.message,
        },
      });
      res.status(500).json({ ok: false, error: 'follow_up_not_updated' });
      return;
    }
    if (!updated.value) {
      // Another department's follow-up and a non-existent one get the same
      // answer, so membership of one cannot be probed from the other.
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: { followUpId, departmentId: scope.departmentId, error: 'not_found' },
      });
      res.status(404).json({ ok: false, error: 'follow_up_not_found' });
      return;
    }

    log.info('follow_ups.action', {
      followUpId, action: parsed.data.action, userId: scope.userId,
    });
    requiredAudit.settle(auditId, {
      outcome: 'success',
      metadata: {
        followUpId,
        departmentId: scope.departmentId,
      },
    });
    res.json({ ok: true, action: parsed.data.action });
  });

  // ── The numbers ──────────────────────────────────────────────────────────

  get('/numbers', async (_req, res) => {
    const scope = await scoped(res, 'listNumbers');
    if (!scope) return;

    const listed = await deps.sessions.list(scope);
    if (!listed.ok) {
      log.error('follow_ups.numbers_failed', { error: listed.error.message });
      res.status(500).json({ ok: false, error: 'numbers_unavailable' });
      return;
    }
    res.json({
      ok: true,
      numbers: listed.value,
      /*
       * Whether re-reading a number's past is even possible here.
       *
       * The screen offers that as the remedy for a number with a gap, and on an
       * engine without a history call it is a button that cannot succeed — one
       * team pressed it, watched it fail on all thirty chats, and reasonably
       * concluded the page was broken. Better to stop offering it.
       */
      historySupported: deps.historyRepair.historySupported,
    });
  });

  post('/numbers', async (req, res) => {
    const scope = await scoped(res, 'linkNumber');
    if (!scope) return;

    const parsed = createNumberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false, error: 'invalid_number', detail: parsed.error.issues[0]?.message,
      });
      return;
    }

    const auditId = await requiredAudit.begin(res, {
      actorId: scope.userId,
      companyId: scope.companyId,
      action: 'followups.number.linked',
      checkpointKey: `${scope.departmentId}:${parsed.data.requestId}`,
      metadata: {
        departmentId: scope.departmentId,
        label: parsed.data.label,
        requestId: parsed.data.requestId,
      },
    });
    if (!auditId) return;

    const created = await deps.sessions.create({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      label: parsed.data.label,
      requestId: parsed.data.requestId,
    });
    if (!created.ok) {
      if (isSessionProvisionUnknown(created.error)) {
        log.warn('follow_ups.number_provisioning_unknown', {
          requestId: parsed.data.requestId,
          departmentId: scope.departmentId,
          error: created.error.message,
          // The wrapper's own sentence says only that Divo is unsure, which is
          // what the member is already being told. The gateway's answer is the
          // part that identifies which call gave up, and logging just the
          // wrapper is why diagnosing this needed a shell on the server.
          cause: created.error.payload.cause instanceof Error
            ? created.error.payload.cause.message
            : String(created.error.payload.cause ?? ''),
        });
        // Keep the audit checkpoint pending. Retrying this same request id will
        // adopt the deterministic OpenWA session if it exists.
        res.status(503).json({
          ok: false,
          code: 'number_provisioning_unknown',
          message: 'Divo could not confirm whether the number finished provisioning. Try the same link again; it will not create a second session.',
        });
        return;
      }
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: {
          label: parsed.data.label,
          departmentId: scope.departmentId,
          error: created.error.message,
        },
      });
      log.error('follow_ups.number_create_failed', { error: created.error.message });
      res.status(502).json({ ok: false, error: 'gateway_unavailable' });
      return;
    }
    requiredAudit.settle(auditId, {
      outcome: 'success',
      metadata: {
        numberId: created.value.id,
        label: created.value.label,
        departmentId: scope.departmentId,
      },
    });
    res.json({ ok: true, number: { id: created.value.id, label: created.value.label } });
  });

  /**
   * The live pairing state, polled while the link dialog is open.
   *
   * Read through on every request and never cached: the QR rotates roughly every
   * twenty seconds, so a stored one is stale before it can be scanned.
   */
  get('/numbers/:id/pairing', async (req, res) => {
    const scope = await scoped(res, 'pairingStatus');
    if (!scope) return;

    const sessionId = String(req.params['id']);
    const pairing = await deps.sessions.pairing(sessionId, scope);
    if (!pairing.ok) {
      answerSessionFailure(res, pairing.error, { op: 'follow_ups.pairing_failed', sessionId });
      return;
    }
    res.json({ ok: true, pairing: pairing.value });
  });

  post('/numbers/:id/pairing-code', async (req, res) => {
    const scope = await scoped(res, 'pairingCode');
    if (!scope) return;

    const parsed = pairingCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false, error: 'invalid_phone', detail: parsed.error.issues[0]?.message,
      });
      return;
    }

    const sessionId = String(req.params['id']);
    const code = await deps.sessions.pairingCode(sessionId, parsed.data.phoneE164, scope);
    if (!code.ok) {
      answerSessionFailure(res, code.error, { op: 'follow_ups.pairing_code_failed', sessionId });
      return;
    }
    res.json({ ok: true, pairing: code.value });
  });

  /**
   * Re-read a number's recent history.
   *
   * The repair for the one gap nothing else can see: messages that were never
   * delivered leave no trace, so no sweep can find them. A person presses this
   * when the tab shows the number went dark.
   *
   * Answers synchronously because it is bounded and slow by design — thirty
   * chats paced a second and a half apart is roughly forty-five seconds, and the
   * caller wants the count.
   */
  post('/numbers/:id/reread', async (req, res) => {
    const scope = await scoped(res, 'reread');
    if (!scope) return;

    const sessionId = String(req.params['id']);
    const session = await deps.sessions.findInScope(sessionId, scope);
    if (!session.ok) {
      answerSessionFailure(res, session.error, { op: 'follow_ups.reread_lookup_failed', sessionId });
      return;
    }

    const repaired = await deps.historyRepair.repair(session.value);
    if (!repaired.ok) {
      log.error('follow_ups.reread_failed', {
        sessionId: session.value.id, error: repaired.error.message,
      });
      res.status(502).json({ ok: false, error: 'gateway_unavailable' });
      return;
    }

    log.info('follow_ups.reread', {
      sessionId: session.value.id,
      userId: scope.userId,
      recovered: repaired.value.messagesRecovered,
    });

    res.json({
      ok: true,
      chatsRead: repaired.value.chatsRead,
      messagesRecovered: repaired.value.messagesRecovered,
      // A partial repair says so. The gap marker is still set in that case, and
      // reporting success would retire the only signal that messages are
      // missing.
      complete: repaired.value.failures.length === 0,
      // Told apart from a failure so the screen can stop offering a button that
      // cannot work. Nothing was wrong with the request — the engine behind the
      // gateway has no history call at all.
      unsupported: repaired.value.unsupported,
      failures: repaired.value.failures,
    });
  });

  // ── The chats, and the privacy switch ────────────────────────────────────

  get('/chats', async (req, res) => {
    const scope = await scoped(res, 'listChats');
    if (!scope) return;

    const asked = Number(req.query['limit']);
    const limit = Number.isFinite(asked)
      ? Math.min(LIST_LIMIT.max, Math.max(1, Math.trunc(asked)))
      : LIST_LIMIT.default;

    const number = typeof req.query['number'] === 'string' ? req.query['number'].trim() : '';

    const rows = await deps.followUps.listChats({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      limit,
      ...(number ? { sessionId: number } : {}),
    });
    if (!rows.ok) {
      log.error('follow_ups.chats_failed', { error: rows.error.message });
      res.status(500).json({ ok: false, error: 'chats_unavailable' });
      return;
    }
    res.json({
      ok: true,
      chats: rows.value,
      truncated: rows.value.length === limit,
      limit,
    });
  });

  /**
   * Stop, or resume, reading one conversation.
   *
   * This is the privacy control for direct messages. Every chat is analysed by
   * default because an event business does most of its client work one-to-one,
   * so the switch has to be per conversation — a rule that could be written in
   * advance would have to be "all DMs" or "no DMs", and neither is right.
   */
  patch('/chats/:id', async (req, res) => {
    const scope = await scoped(res, 'muteChat');
    if (!scope) return;

    const parsed = muteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false, error: 'invalid_request', detail: parsed.error.issues[0]?.message,
      });
      return;
    }

    const chatId = String(req.params['id']);
    const auditId = await requiredAudit.begin(res, {
      actorId: scope.userId,
      companyId: scope.companyId,
      action: 'followups.chat.tracking_changed',
      metadata: { chatId, muted: parsed.data.muted, departmentId: scope.departmentId },
    });
    if (!auditId) return;

    const updated = await deps.followUps.setChatTracking({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      chatId,
      muted: parsed.data.muted,
    });
    if (!updated.ok) {
      log.error('follow_ups.mute_failed', { error: updated.error.message });
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: {
          chatId,
          muted: parsed.data.muted,
          departmentId: scope.departmentId,
          error: updated.error.message,
        },
      });
      res.status(500).json({ ok: false, error: 'chat_not_updated' });
      return;
    }
    if (!updated.value) {
      // Another department's chat and a non-existent one get the same answer.
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: { chatId, muted: parsed.data.muted, departmentId: scope.departmentId, error: 'not_found' },
      });
      res.status(404).json({ ok: false, error: 'chat_not_found' });
      return;
    }

    log.info('follow_ups.chat_tracking_changed', {
      chatId: req.params['id'], muted: parsed.data.muted, userId: scope.userId,
    });
    requiredAudit.settle(auditId, {
      outcome: 'success',
      metadata: {
        chatId,
        muted: parsed.data.muted,
        departmentId: scope.departmentId,
      },
    });
    res.json({ ok: true, muted: parsed.data.muted });
  });

  // ── The digest ───────────────────────────────────────────────────────────

  /*
   * Where and when this department is told what is outstanding.
   *
   * One digest per department in this API, though the schema's unique key is
   * `[companyId, departmentId, larkChatId]` and so permits several. Nothing has
   * ever created a second, and the screen models one — so more than one is
   * answered as the ambiguity it is rather than by picking the oldest and
   * appearing to have lost the other.
   */
  get('/digest', async (_req, res) => {
    const scope = await scoped(res, 'readDigest');
    if (!scope) return;

    const rows = await deps.followUps.listDigests({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
    });
    if (!rows.ok) {
      log.error('follow_ups.digest.read_failed', { error: rows.error.message });
      res.status(500).json({ ok: false, error: 'digest_unavailable' });
      return;
    }
    if (rows.value.length > 1) {
      log.error('follow_ups.digest.ambiguous', {
        departmentId: scope.departmentId, count: rows.value.length,
      });
      res.status(409).json({
        ok: false,
        error: 'multiple_digests',
        detail: 'This department reports into more than one room. Divo will not guess which one this screen edits.',
      });
      return;
    }

    const digest = rows.value[0];
    if (!digest) { res.json({ ok: true, digest: null, cards: [] }); return; }

    /*
     * History is best-effort. A schedule that cannot show what it last sent is
     * still worth showing — failing the whole screen would hide the field
     * somebody came here to fix.
     */
    const cards = await deps.followUps.recentDigestCards({ digestId: digest.id, limit: 10 });
    if (!cards.ok) {
      log.error('follow_ups.digest.cards_failed', { digestId: digest.id, error: cards.error.message });
    }

    res.json({
      ok: true,
      digest: {
        id: digest.id,
        chatId: digest.larkChatId,
        times: digest.times,
        days: digest.days,
        timeZone: digest.timeZone,
        status: digest.status,
        sendOnly: digest.sendOnly,
        nextRunAt: digest.nextRunAt?.toISOString() ?? null,
        lastRunAt: digest.lastRunAt?.toISOString() ?? null,
      },
      cards: cards.ok
        ? cards.value.map(card => ({
          id: card.id,
          number: card.sessionLabel,
          itemCount: card.itemCount,
          sentAt: card.sentAt.toISOString(),
        }))
        : [],
    });
  });

  const digestBodySchema = z.object({
    chatId: z.string().trim().min(1).max(200),
    times: z.array(z.string()).min(1).max(4),
    days: z.array(z.string()).min(1).max(7),
    timeZone: z.string().trim().min(1).max(100),
    /* Pausing is not deleting: the room, the schedule and how far the last run
       reported all survive being switched off for a week. */
    paused: z.boolean().optional(),
    /* Divo posts here and does not answer here. Defaults on for a new digest:
       a room made for a schedule's output is a feed, not a chat. */
    sendOnly: z.boolean().optional(),
  });

  put('/digest', async (req, res) => {
    const scope = await scoped(res, 'setDigest');
    if (!scope) return;

    const body = digestBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message });
      return;
    }

    /*
     * Validated by the scheduler's own schema, not by a second copy of the
     * rules here. It is the thing that will later read this back and find the
     * next slot, so it is the thing that decides what it can read — a `25:00`
     * accepted here and refused there would be a digest that saves cleanly and
     * then never fires.
     */
    const schedule = recurringScheduleSchema.safeParse({
      times: body.data.times,
      days: body.data.days,
      timeZone: body.data.timeZone,
    });
    if (!schedule.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid_schedule',
        detail: schedule.error.issues[0]?.message,
      });
      return;
    }

    const verdict = await deps.authorizeLarkChat({
      companyId: scope.companyId,
      chatId: body.data.chatId,
    });
    if (verdict.status !== 'allowed') {
      const refusedAuditId = await requiredAudit.begin(res, {
        actorId: scope.userId,
        companyId: scope.companyId,
        action: 'followups.digest.refused',
        metadata: {
          departmentId: scope.departmentId,
          chatId: body.data.chatId,
          reason: verdict.status,
        },
      });
      if (!refusedAuditId) return;
      requiredAudit.settle(refusedAuditId, {
        outcome: 'failure',
        metadata: {
          departmentId: scope.departmentId,
          chatId: body.data.chatId,
          reason: verdict.status,
        },
      });
      /*
       * `unknown_chat` is the member's to fix — add Divo to the room — and
       * `other_company` never is: that is one Lark install serving two Divo
       * companies, and the room belongs to the other one.
       */
      res.status(verdict.status === 'unavailable' ? 502 : 400).json({
        ok: false,
        error: `chat_${verdict.status}`,
        detail: verdict.status === 'unknown_chat'
          ? 'Divo has never been in that Lark room. Add Divo to it and try again.'
          : verdict.status === 'other_company'
            ? 'That room belongs to a different company on this Lark installation.'
            : 'Lark did not answer. The schedule was not changed.',
      });
      return;
    }

    const auditId = await requiredAudit.begin(res, {
      actorId: scope.userId,
      companyId: scope.companyId,
      action: 'followups.digest.set',
      metadata: { departmentId: scope.departmentId, chatId: body.data.chatId },
    });
    if (!auditId) return;

    const existing = await deps.followUps.listDigests({
      companyId: scope.companyId,
      departmentId: scope.departmentId,
    });
    if (!existing.ok) {
      log.error('follow_ups.digest.read_failed', { error: existing.error.message });
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: { departmentId: scope.departmentId, chatId: body.data.chatId, error: existing.error.message },
      });
      res.status(500).json({ ok: false, error: 'digest_unavailable' });
      return;
    }
    if (existing.value.length > 1) {
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: { departmentId: scope.departmentId, chatId: body.data.chatId, error: 'multiple_digests' },
      });
      res.status(409).json({ ok: false, error: 'multiple_digests' });
      return;
    }

    const paused = body.data.paused === true;
    /*
     * The first slot is computed from now, so a schedule saved at 08:55 for
     * 09:00 fires at 09:00 today rather than tomorrow. Null while paused: the
     * claimer looks for a due `nextRunAt`, so leaving one set would have a
     * paused digest go out anyway.
     */
    const nextRunAt = paused ? null : nextRecurringRunAt(schedule.data, new Date());

    const saved = await deps.followUps.upsertDigest({
      ...(existing.value[0] ? { digestId: existing.value[0].id } : {}),
      companyId: scope.companyId,
      departmentId: scope.departmentId,
      larkChatId: body.data.chatId,
      times: schedule.data.times,
      days: schedule.data.days,
      timeZone: schedule.data.timeZone,
      status: paused ? 'paused' : 'active',
      /* Absent means "unchanged" on an edit and "send-only" on a new digest,
         so a caller that predates the field cannot silently make an existing
         mechanical room conversational. */
      sendOnly: body.data.sendOnly ?? existing.value[0]?.sendOnly ?? true,
      nextRunAt,
    });
    if (!saved.ok) {
      log.error('follow_ups.digest.save_failed', { error: saved.error.message });
      requiredAudit.settle(auditId, {
        outcome: 'failure',
        metadata: {
          departmentId: scope.departmentId,
          chatId: body.data.chatId,
          error: saved.error.message,
        },
      });
      res.status(500).json({ ok: false, error: 'digest_unavailable' });
      return;
    }

    requiredAudit.settle(auditId, {
      outcome: 'success',
      metadata: {
        departmentId: scope.departmentId,
        digestId: saved.value.id,
        chatId: saved.value.larkChatId,
        /* The schedule itself, so the trail says what was set and not merely
           that somebody set something. */
        times: saved.value.times,
        days: saved.value.days,
        timeZone: saved.value.timeZone,
        status: saved.value.status,
        sendOnly: saved.value.sendOnly,
        created: existing.value.length === 0,
      },
    });

    res.json({
      ok: true,
      digest: {
        id: saved.value.id,
        chatId: saved.value.larkChatId,
        times: saved.value.times,
        days: saved.value.days,
        timeZone: saved.value.timeZone,
        status: saved.value.status,
        sendOnly: saved.value.sendOnly,
        nextRunAt: saved.value.nextRunAt?.toISOString() ?? null,
        lastRunAt: saved.value.lastRunAt?.toISOString() ?? null,
      },
    });
  });

  return router;
}
