/**
 * Read-only surface for a member's own mail rules.
 *
 * Until now Mail Ops had no reachable state at all: its only HTTP surface was
 * the Gmail Pub/Sub webhook, so a rule could stop working and nobody — not the
 * owner, not an operator — could find out. These three endpoints exist to make
 * that answerable, and nothing here mutates.
 *
 * Every query is pinned to the signed-in member server-side. There is no
 * userId parameter and no way to ask about somebody else, which matches how
 * the rest of the personal workspace endpoints behave.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import type { MemberAuthMiddlewareDeps } from '../middleware/member-auth.middleware';
import type { MailOpsReadRepository } from '../../infrastructure/persistence/mail-ops-read.repository';
import { DEFAULT_DRY_RUN_EVENTS } from '../../infrastructure/persistence/mail-ops-read.repository';
import {
  assessMailbox,
  assessRule,
  type MailboxHealth,
} from '../../application/mail-ops/mail-ops-health';
import { dryRunMailRule } from '../../application/mail-ops/mail-rule-dry-run';
import { summariseCorrespondents } from '../../application/mail-ops/mail-correspondents';
import {
  actionForDestination,
  type MailRuleWriteRequest,
  type MailRuleWriteResult,
} from '../../application/mail-ops/mail-rule-writer';
import { mailRuleMatchSchema } from '../../application/mail-ops/mail-rule.matcher';
import type {
  MailRuleAction,
  MailRuleDestination,
} from '../../application/mail-ops/mail-ops.types';
import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

const DEFAULT_DELIVERY_LIMIT = 25;
const MAX_DELIVERY_LIMIT = 100;
const MAX_DRY_RUN_EVENTS = 200;

const dryRunBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DRY_RUN_EVENTS).optional(),
});

const listQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
});

/**
 * How many stored messages the summary reads.
 *
 * Enough that a domain's real volume shows against the noise, and small
 * enough that the query stays a bounded index read on one subscription. The
 * counts are relative to this window, not to all time, and the response says
 * so.
 */
const SUGGESTION_EVENTS = 1_000;

/*
 * The same `.strict()` match schema the agent's tool validates against, reused
 * rather than restated — a second definition of what a rule may say is a second
 * thing to keep in step, and the one that falls behind is whichever has fewer
 * eyes on it.
 */
const createRuleBodySchema = z.object({
  connectionId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  match: mailRuleMatchSchema,
  destination: z.discriminatedUnion('type', [
    z.object({ type: z.literal('email'), email: z.string().trim().email() }).strict(),
    z.object({ type: z.literal('lark_chat'), chatId: z.string().trim().min(1) }).strict(),
    z.object({
      type: z.literal('organize'),
      label: z.string().trim().min(1).max(225).optional(),
      archive: z.boolean().optional(),
      markRead: z.boolean().optional(),
    }).strict(),
  ]),
  rateLimitPerHour: z.number().int().min(1).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  // On the outer object rather than the branch: a `.refine` inside a
  // discriminated union turns the branch into a ZodEffects, which the union
  // will not accept. An organize rule with nothing switched on is a real
  // stored shape that does nothing at all, so it is refused at the door.
  if (
    value.destination.type === 'organize'
    && value.destination.label === undefined
    && value.destination.archive !== true
    && value.destination.markRead !== true
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['destination'],
      message: 'Say what to do with the message: label it, archive it, or mark it read.',
    });
  }
});

/*
 * A status code and a default sentence per refusal.
 *
 * 409 for the two that are about the account rather than the request: nothing
 * about the rule is wrong, and a 400 would send somebody rewriting it.
 */
const REFUSALS: Record<Exclude<MailRuleWriteResult['status'], 'created'>, {
  code: number;
  message: string;
}> = {
  not_configured: {
    code: 503,
    message:
      'Mail automation is not running in this environment, so a rule created now would never fire.',
  },
  choose_connection: {
    code: 409,
    message: 'Choose which of your Google accounts this rule should watch.',
  },
  connection_unavailable: {
    code: 409,
    message: 'Divo needs a Google account you own, with Gmail read, watch and send access.',
  },
  approval_required: {
    code: 403,
    message:
      'The owner of this Google connection requires approval before it runs anything in the '
      + 'background, and a mail rule runs with nobody present to approve it. Ask them to allow '
      + 'background execution on this connection first.',
  },
  destination_refused: { code: 400, message: 'Divo will not send mail to that destination.' },
  unavailable: { code: 500, message: 'That rule could not be created. Try again shortly.' },
};

const suggestionsQuerySchema = z.object({
  connectionId: z.string().uuid().optional(),
});

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DELIVERY_LIMIT).optional(),
});

export interface MailAutomationsRouteDeps {
  readRepo: MailOpsReadRepository;
  memberAuth: MemberAuthMiddlewareDeps;
  /**
   * Brings this member's mailboxes forward to be polled now.
   *
   * Optional so the router still mounts in tests and in any composition that
   * has no writer; the route reports plainly that it is unavailable rather
   * than pretending it worked.
   */
  requestReconciliation?: (input: {
    companyId: string;
    userId: string;
  }) => Promise<Result<number, InfraError>>;
  /**
   * Creates a rule, running the same checks the agent's tool runs. Optional for
   * the same reason as above: the router still mounts where nothing can write,
   * and says so plainly rather than pretending.
   */
  writeRule?: (
    request: MailRuleWriteRequest,
    action: MailRuleAction,
  ) => Promise<MailRuleWriteResult>;
  logger: Logger;
}

export function createMailAutomationsRoutes(
  deps: MailAutomationsRouteDeps,
): Router {
  const router = Router();
  const log = deps.logger.child({ route: 'mail-automations' });
  router.use(createMemberAuthMiddleware(deps.memberAuth));

  const actor = (res: Response) => ({
    companyId: res.locals['companyId'] as string,
    userId: res.locals['userId'] as string,
  });

  const fail = (res: Response, operation: string, error: unknown): void => {
    log.error('mail_automations.read_failed', {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      message: 'Could not read your mail rules.',
    });
  };

  /**
   * Rules with enough context to answer "is this working?" in one call. Rule
   * health depends on mailbox health — a rule is not really active if the
   * mailbox under it is not being watched — so both are resolved together
   * rather than leaving the client to join them.
   */
  router.get('/rules', async (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        success: false,
        message: 'includeInactive must be true or false.',
      });
      return;
    }
    const who = actor(res);
    try {
      const [rules, mailboxes] = await Promise.all([
        deps.readRepo.listRuleActivity({
          ...who,
          includeInactive: query.data.includeInactive === 'true',
        }),
        deps.readRepo.listMailboxHealth(who),
      ]);
      if (!rules.ok) throw rules.error;
      if (!mailboxes.ok) throw mailboxes.error;

      const healthByMailbox = new Map<string, MailboxHealth>(
        mailboxes.value.map(record => [
          record.connectionId,
          assessMailbox(record),
        ]),
      );

      res.json({
        success: true,
        data: {
          rules: rules.value.map(rule => {
            const mailbox = healthByMailbox.get(rule.connectionId);
            const health = assessRule(rule, mailbox);
            return {
              ruleId: rule.ruleId,
              name: rule.name,
              status: rule.status,
              state: health.state,
              summary: health.summary,
              invalidReason: health.invalidReason,
              mailboxEmail: rule.mailboxEmail,
              connectionId: rule.connectionId,
              match: rule.match,
              action: rule.action,
              destination: rule.destination,
              createdAt: rule.createdAt.toISOString(),
              lastDeliveredAt: rule.lastDeliveredAt?.toISOString() ?? null,
              deliveredCount: rule.deliveredCount,
              failingCount: rule.failingCount,
              abandonedCount: rule.abandonedCount,
              blockedCount: rule.blockedCount,
              lastError: rule.lastError,
              lastErrorAt: rule.lastErrorAt?.toISOString() ?? null,
            };
          }),
        },
      });
    } catch (error) {
      fail(res, 'rules', error);
    }
  });

  /**
   * What one rule actually did. A 404 here means "not yours or not real" — the
   * repository enforces ownership in the query, so the two are deliberately
   * indistinguishable to a caller.
   */
  router.get('/rules/:ruleId/deliveries', async (req, res) => {
    const query = deliveriesQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        success: false,
        message: `limit must be between 1 and ${MAX_DELIVERY_LIMIT}.`,
      });
      return;
    }
    const ruleId = z.string().uuid().safeParse(req.params['ruleId']);
    if (!ruleId.success) {
      res.status(400).json({ success: false, message: 'Invalid rule ID.' });
      return;
    }
    try {
      const deliveries = await deps.readRepo.listDeliveriesForRule({
        ...actor(res),
        ruleId: ruleId.data,
        limit: query.data.limit ?? DEFAULT_DELIVERY_LIMIT,
      });
      if (!deliveries.ok) throw deliveries.error;
      if (deliveries.value === null) {
        res.status(404).json({
          success: false,
          message: 'That mail rule was not found in your account.',
        });
        return;
      }

      res.json({
        success: true,
        data: {
          deliveries: deliveries.value.map(delivery => ({
            deliveryId: delivery.deliveryId,
            status: delivery.status,
            attempts: delivery.attempts,
            ambiguous: delivery.ambiguous,
            lastError: delivery.lastError,
            subject: delivery.subject,
            from: delivery.from,
            firstAttemptAt: delivery.firstAttemptAt.toISOString(),
            deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
            nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
          })),
        },
      });
    } catch (error) {
      fail(res, 'deliveries', error);
    }
  });

  /**
   * What this rule would do, without doing any of it.
   *
   * A POST because it is an action the member takes, not a resource — but it
   * writes nothing, sends nothing, and touches no Gmail API. The whole run is
   * the stored match replayed over stored events.
   */
  router.post('/rules/:ruleId/test', async (req, res) => {
    const ruleId = z.string().uuid().safeParse(req.params['ruleId']);
    if (!ruleId.success) {
      res.status(400).json({ success: false, message: 'Invalid rule ID.' });
      return;
    }
    const body = dryRunBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        success: false,
        message: `limit must be between 1 and ${MAX_DRY_RUN_EVENTS}.`,
      });
      return;
    }
    try {
      const loaded = await deps.readRepo.loadRuleForDryRun({
        ...actor(res),
        ruleId: ruleId.data,
        limit: body.data.limit ?? DEFAULT_DRY_RUN_EVENTS,
      });
      if (!loaded.ok) throw loaded.error;
      if (loaded.value === null) {
        res.status(404).json({
          success: false,
          message: 'That mail rule was not found in your account.',
        });
        return;
      }

      const outcome = dryRunMailRule({
        rule: loaded.value,
        events: loaded.value.events,
      });
      if (outcome.status === 'rule_invalid') {
        res.json({
          success: true,
          data: {
            ruleId: loaded.value.ruleId,
            name: loaded.value.name,
            valid: false,
            invalidReason: outcome.reason,
          },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          ruleId: loaded.value.ruleId,
          name: loaded.value.name,
          valid: true,
          mailboxEmail: loaded.value.mailboxEmail,
          consideredCount: outcome.consideredCount,
          matchedCount: outcome.matched.length,
          // Named apart from `matchedCount` because these are matches the
          // runtime would decline: mail older than the rule is never acted on.
          // Folding them in would read as a promise to go back for it.
          predatingCount: outcome.predatingCount,
          // Messages this rule needs a body to judge, whose body retention has
          // taken. Neither matches nor non-matches — a caller folding them into
          // either number reports a certainty nobody has.
          bodyUnavailableCount: outcome.bodyUnavailableCount,
          matched: outcome.matched.map(hit => ({
            eventId: hit.eventId,
            occurredAt: hit.occurredAt.toISOString(),
            from: hit.from,
            subject: hit.subject,
            predatesRule: hit.predatesRule,
          })),
        },
      });
    } catch (error) {
      fail(res, 'test', error);
    }
  });

  /**
   * Mailbox-level state. This is the only view that can explain a total stop:
   * when a watch never registers, every rule on that mailbox dies at once and
   * no per-rule view can say why.
   */
  /**
   * "Try again now."
   *
   * A mailbox that failed sits on its own retry schedule, and until this there
   * was no way for the owner or an operator to ask for a pass sooner — the
   * options were to wait out the interval or to edit a row by hand. It only
   * moves the schedule: it does not clear a failure, because whether the
   * failure is over is the next pass's answer, not this one's.
   */
  router.post('/reconcile', async (_req, res) => {
    try {
      if (!deps.requestReconciliation) {
        res.status(503).json({
          success: false,
          error: 'Reconciliation cannot be requested in this environment.',
        });
        return;
      }
      const requested = await deps.requestReconciliation(actor(res));
      if (!requested.ok) throw requested.error;
      log.info('mail_ops.reconciliation_requested', {
        companyId: res.locals['companyId'],
        mailboxCount: requested.value,
      });
      res.json({ success: true, data: { mailboxCount: requested.value } });
    } catch (error) {
      fail(res, 'reconcile', error);
    }
  });

  /**
   * Create a rule from the web.
   *
   * The first write on this router that makes something. Everything it does
   * before writing lives in `createMailRuleWriter`, shared with the agent's
   * tool — a route that reimplemented those checks beside the tool would be two
   * paths agreeing on the day they were written and not for long after.
   *
   * Not gated on `mailAutomations.create`, deliberately. `execute` is
   * re-checked by the worker on every single delivery, so a rule made by
   * somebody who may not run one never delivers; enforcement at the point of
   * action also survives access being removed after the rule exists, which a
   * create-time check does not.
   *
   * Every refusal below carries its own remedy. "It did not work" is the one
   * answer a member can do nothing with.
   */
  router.post('/rules', async (req, res) => {
    if (!deps.writeRule) {
      res.status(503).json({
        success: false,
        message: 'Mail rules cannot be created in this environment.',
      });
      return;
    }

    const parsed = createRuleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? 'That rule could not be read.',
      });
      return;
    }

    const body = parsed.data;
    try {
      const destination: MailRuleDestination =
        body.destination.type === 'email'
          ? { type: 'email', email: body.destination.email }
          : body.destination.type === 'lark_chat'
            ? { type: 'lark_chat', chatId: body.destination.chatId }
            : { type: 'none' };

      const action: MailRuleAction = body.destination.type === 'organize'
        ? {
            type: 'organize',
            ...(body.destination.label !== undefined ? { label: body.destination.label } : {}),
            ...(body.destination.archive !== undefined ? { archive: body.destination.archive } : {}),
            ...(body.destination.markRead !== undefined ? { markRead: body.destination.markRead } : {}),
          }
        : actionForDestination(destination, body.rateLimitPerHour);

      const outcome = await deps.writeRule({
        ...actor(res),
        ...(res.locals['runtimeDepartmentId']
          ? { departmentId: String(res.locals['runtimeDepartmentId']) }
          : {}),
        ...(body.connectionId ? { connectionId: body.connectionId } : {}),
        name: body.name,
        // The schema is the tool's own, so the value is already right; the cast
        // only bridges `exactOptionalPropertyTypes`, where zod's `string |
        // undefined` output does not satisfy an optional-but-not-undefined field.
        match: body.match as MailRuleWriteRequest['match'],
        destination,
        ...(body.rateLimitPerHour !== undefined ? { rateLimitPerHour: body.rateLimitPerHour } : {}),
      }, action);

      if (outcome.status === 'created') {
        log.info('mail_automations.rule_created', {
          companyId: res.locals['companyId'],
          ruleId: outcome.ruleId,
          destination: destination.type,
        });
        res.status(201).json({ success: true, data: outcome });
        return;
      }

      const refusal = REFUSALS[outcome.status];
      res.status(refusal.code).json({
        success: false,
        code: outcome.status,
        message: 'reason' in outcome && outcome.reason ? outcome.reason : refusal.message,
        ...(outcome.status === 'choose_connection' ? { connections: outcome.connections } : {}),
        ...(outcome.status === 'connection_unavailable' && outcome.connectionState
          ? { connectionState: outcome.connectionState }
          : {}),
      });
    } catch (error) {
      fail(res, 'create', error);
    }
  });

  /**
   * Who writes to this mailbox, for the rule builder's From and To fields.
   *
   * A mail rule written from memory fails silently: the sender is typed as the
   * brand somebody knows, the invoices arrive from a subdomain nobody has
   * heard of, and the rule waits for ever while looking perfectly healthy.
   * This is the only fix — not validation, which has nothing to object to.
   *
   * Reads events Divo has already stored, so it costs no Gmail call and no
   * quota. The trade is that a mailbox nobody has watched yet has nothing
   * stored, and answers with empty sets and `watched: false` rather than
   * pretending — a first rule is exactly the one written blind, and closing
   * that gap needs a Gmail scan this route deliberately does not do inline.
   */
  router.get('/suggestions', async (req, res) => {
    try {
      const parsed = suggestionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Invalid connectionId.' });
        return;
      }

      const found = await deps.readRepo.listRecentEventsForMailbox({
        ...actor(res),
        ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
        limit: SUGGESTION_EVENTS,
      });
      if (!found.ok) throw found.error;

      if (found.value === null) {
        res.json({
          success: true,
          data: { from: [], to: [], window: '', watched: false },
        });
        return;
      }

      const summary = summariseCorrespondents(found.value.events, found.value.mailboxEmail);
      res.json({
        success: true,
        data: {
          ...summary,
          // Stated as a count rather than a period. Events are kept for ninety
          // days but a mailbox watched since Tuesday has three days of them,
          // and "the last 90 days" would be a claim about coverage this route
          // cannot make.
          window: `from the last ${found.value.events.length} messages Divo has seen`,
          watched: true,
        },
      });
    } catch (error) {
      fail(res, 'suggestions', error);
    }
  });

  router.get('/health', async (_req, res) => {
    try {
      const mailboxes = await deps.readRepo.listMailboxHealth(actor(res));
      if (!mailboxes.ok) throw mailboxes.error;

      const assessed = mailboxes.value.map(assessMailbox);
      res.json({
        success: true,
        data: {
          mailboxes: assessed.map(health => ({
            subscriptionId: health.subscriptionId,
            mailboxEmail: health.mailboxEmail,
            state: health.state,
            rulesCanFire: health.rulesCanFire,
            summary: health.summary,
            remedy: health.remedy,
            failureCode: health.failureCode,
            activeRuleCount: health.activeRuleCount,
            lastSucceededAt: health.lastSucceededAt?.toISOString() ?? null,
            lastSignalAt: health.lastSignalAt?.toISOString() ?? null,
            watchExpirationAt: health.watchExpirationAt?.toISOString() ?? null,
          })),
          // Hoisted so a caller can render a banner without inspecting each
          // mailbox — the common case is exactly one connected mailbox.
          anyMailboxBroken: assessed.some(
            health => !health.rulesCanFire && health.state !== 'paused',
          ),
        },
      });
    } catch (error) {
      fail(res, 'health', error);
    }
  });

  return router;
}
