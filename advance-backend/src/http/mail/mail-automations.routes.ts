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
