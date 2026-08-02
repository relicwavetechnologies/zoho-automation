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
import {
  assessMailbox,
  assessRule,
  type MailboxHealth,
} from '../../application/mail-ops/mail-ops-health';

const DEFAULT_DELIVERY_LIMIT = 25;
const MAX_DELIVERY_LIMIT = 100;

const listQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
});

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DELIVERY_LIMIT).optional(),
});

export interface MailAutomationsRouteDeps {
  readRepo: MailOpsReadRepository;
  memberAuth: MemberAuthMiddlewareDeps;
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
   * Mailbox-level state. This is the only view that can explain a total stop:
   * when a watch never registers, every rule on that mailbox dies at once and
   * no per-rule view can say why.
   */
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
