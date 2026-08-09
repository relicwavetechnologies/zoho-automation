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
import type { MailOpsRepository } from '../../infrastructure/persistence/mail-ops.repository';
import { DEFAULT_DRY_RUN_EVENTS } from '../../infrastructure/persistence/mail-ops-read.repository';
import {
  assessMailbox,
  assessRule,
  type MailboxHealth,
} from '../../application/mail-ops/mail-ops-health';
import { dryRunMailRule } from '../../application/mail-ops/mail-rule-dry-run';
import type { MailRuleCompilation } from '../../application/mail-ops/mail-rule-compiler';
import {
  actionForDestination,
  type MailRuleStatusChange,
  type MailRuleReplaceResult,
  type MailRuleStatusResult,
  type MailRuleWriteRequest,
  type MailRuleWriteResult,
} from '../../application/mail-ops/mail-rule-writer';
import { mailRuleMatchSchema } from '../../application/mail-ops/mail-rule.matcher';
import {
  MAIL_RULE_MAX_ROUTES,
  MAIL_RULE_MIN_ROUTES,
  mailRuleJudgeSchema,
} from '../../application/mail-ops/mail-ops.types';
import type { MailRuleOperation } from '../../application/mail-ops/mail-rule-permission';
import {
  mailBriefScheduleSchema,
  nextMailBriefRunAt,
} from '../../application/mail-ops/mail-brief.schedule';
import type {
  MailRuleAction,
  MailRuleDestination,
} from '../../application/mail-ops/mail-ops.types';
import type {
  MailRuleExternalApprovalInput,
  MailRuleExternalApprovalOutcome,
} from '../../application/mail-ops/mail-rule-external-approval';
import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

const DEFAULT_DELIVERY_LIMIT = 25;
const MAX_DELIVERY_LIMIT = 100;
/**
 * Higher than one rule's, because this list spans every rule a member has. At
 * 25 a member with four busy rules sees this morning and nothing else, which
 * reads as "Divo stopped" rather than "the page is short".
 */
const DEFAULT_CAUGHT_LIMIT = 50;

/**
 * `paused` rides with the schedule rather than being its own endpoint.
 *
 * Turning a brief off and moving it to 07:00 are the same kind of change and
 * are made on the same screen; two routes would let the two disagree about
 * which won.
 */
const briefUpdateSchema = mailBriefScheduleSchema.extend({
  paused: z.boolean().optional().default(false),
});
const MAX_DRY_RUN_EVENTS = 200;

const dryRunBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DRY_RUN_EVENTS).optional(),
});

const listQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
});

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
    /*
     * No `lark_chat`.
     *
     * The agent keeps it — there, a room is named in conversation, usually from
     * inside the room itself, and `authorizeLarkChat` grounds the id against
     * chats this company has actually been in. From a browser there is no such
     * conversation: the only input is an opaque id, and an id typed one
     * character wrong is indistinguishable from a right one until the mail
     * lands in somebody else's room. Grounding stops another *company's* room,
     * not the wrong room in your own.
     *
     * So this surface offers what it can offer safely, and the schema says the
     * same thing the screens do. A picker fed by rooms Divo already knows would
     * change that answer — it needs chat names, which nothing stores yet.
     */
    /*
     * No id, deliberately.
     *
     * The DM target is the signed-in member's own open id, which the server
     * reads from the session below. Letting a browser name one would mean a
     * member could forward their mail to a colleague's DM by pasting an id —
     * which is precisely the class of thing `authorizeLarkChat` exists to stop
     * for rooms, and which is better prevented by having no input at all than
     * by validating one.
     */
    z.object({ type: z.literal('lark_dm') }).strict(),
    z.object({
      type: z.literal('organize'),
      label: z.string().trim().min(1).max(225).optional(),
      archive: z.boolean().optional(),
      markRead: z.boolean().optional(),
    }).strict(),
    /*
     * Several recipients, one of which Divo picks per message.
     *
     * Email only from a browser, for the same reason `lark_chat` is absent
     * above: there is no conversation to ground a room id against, and this
     * screen has no picker. A routing table is where a mistyped id would be
     * least visible, because five branches look right while the sixth quietly
     * posts somebody's mail into a room nobody chose.
     *
     * `otherwise` absent means hold — nothing is sent and the member sees it.
     */
    z.object({
      type: z.literal('routed'),
      routes: z.array(z.object({
        key: z.string().trim().min(1).max(40),
        when: z.string().trim().min(3).max(200),
        destination: z.object({
          type: z.literal('email'),
          email: z.string().trim().email(),
        }).strict(),
      }).strict()).min(MAIL_RULE_MIN_ROUTES).max(MAIL_RULE_MAX_ROUTES),
      otherwise: z.union([
        z.literal('hold'),
        z.object({
          type: z.literal('email'),
          email: z.string().trim().email(),
        }).strict(),
      ]).optional(),
    }).strict(),
  ]),
  rateLimitPerHour: z.number().int().min(1).max(1000).optional(),
  /**
   * The rule's AI step. Absent means the rule has none — and on an edit that
   * means *remove* it, because this body describes the whole rule rather than
   * a patch of it. Same contract as `match` and `rateLimitPerHour`.
   */
  judge: mailRuleJudgeSchema.optional(),
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
  /*
   * A routing table already is the AI step, so a second question on top of it
   * is a rule with two of them and no stated order between them.
   *
   * `parseMailRule` refuses this pair when the stored row is read back, which
   * means accepting it here produced a rule the member was told was active and
   * which then reported itself broken and matched nothing. Refused at the door
   * instead, where the sentence can say what to send.
   */
  if (value.destination.type === 'routed' && value.judge) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['judge'],
      message: 'A rule that sorts mail between people already asks its own question, '
        + 'so it cannot also carry one. Remove the question, or choose a single destination.',
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
  /*
   * Not a mistake in the request, so not a 400.
   *
   * A forward out of the company is a standing export of whatever it matches,
   * and the person who has to agree to that is somebody other than whoever is
   * filling in this form. 409 says the same thing the other two account-shaped
   * refusals say: nothing about the rule is wrong, and rewriting it will not
   * help.
   */
  external_approval_required: {
    code: 409,
    message: 'This forward leaves your organisation, so it needs approval first.',
  },
  external_approval_unavailable: {
    code: 409,
    message:
      'This forward leaves your organisation and needs a manager or company admin to approve it.',
  },
  destination_refused: { code: 400, message: 'Divo will not send mail to that destination.' },
  unavailable: { code: 500, message: 'That rule could not be created. Try again shortly.' },
};

const compileBodySchema = z.object({
  sentence: z.string().trim().min(3).max(1_000),
  connectionId: z.string().uuid().optional(),
}).strict();

/*
 * Testing conditions that are not a rule yet.
 *
 * The existing dry run replays a rule that already exists, which is no use at
 * the moment it would help most — before anybody commits to one. This takes the
 * conditions instead.
 */
const previewBodySchema = z.object({
  match: mailRuleMatchSchema,
  connectionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DRY_RUN_EVENTS).optional(),
}).strict();

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DELIVERY_LIMIT).optional(),
});

export interface MailAutomationsRouteDeps {
  readRepo: MailOpsReadRepository;
  /**
   * The member's standing summary. Its own port rather than a widening of
   * `readRepo`, because it writes — and optional so the router still mounts in
   * a composition without one, answering 503 rather than throwing.
   */
  briefRepo?: Pick<MailOpsRepository, 'readBriefForUser' | 'updateBriefForUser'>;
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
  writeRule?: {
    create: (
      request: MailRuleWriteRequest,
      action: MailRuleAction,
    ) => Promise<MailRuleWriteResult>;
    /**
     * Optional so a composition without it degrades to "editing is not
     * available here" rather than failing to build. The route says exactly
     * that, which is the honest reading — it is not the member's mistake.
     */
    replace?: (
      request: MailRuleWriteRequest & { ruleId: string },
      action: MailRuleAction,
    ) => Promise<MailRuleReplaceResult>;
    setStatus: (
      input: { companyId: string; userId: string; ruleId: string },
      change: MailRuleStatusChange,
    ) => Promise<MailRuleStatusResult>;
  };
  /**
   * Whether this member may run mail automations at all.
   *
   * Asks for **`execute`**, not `create` — because `execute` is what the worker
   * re-checks on every single delivery, and a rule its owner may not execute is
   * a rule that exists, reports Working, and silently stops on every message.
   * Checking `create` here would let exactly that through.
   *
   * Resolved on the **Lark** channel for the same reason: that is the channel
   * the worker resolves on, whatever surface the rule was made from. Asking a
   * different question here than delivery will ask is how this went wrong in
   * the first place.
   *
   * Optional — a composition without it skips the check, which is the state
   * this router was in until now.
   */
  canRunMailRules?: (input: {
    companyId: string;
    userId: string;
    companyRole: string;
    departmentId?: string;
    operation: MailRuleOperation;
  }) => Promise<{ kind: 'allowed' | 'denied' | 'unavailable'; message?: string }>;
  /**
   * Which department the signed-in member belongs to.
   *
   * `res.locals.runtimeDepartmentId` is set by the member-auth middleware for
   * Pi runtime tokens **and nothing else** — a browser session never carries
   * one. Reading only that made every web request look department-less, which
   * is how an external forward reached "nobody can approve this" in a company
   * with two department managers and two admins: Divo never asked.
   */
  resolveDepartmentId?: (input: {
    companyId: string;
    userId: string;
  }) => Promise<string | null>;
  /** Turns one sentence into a draft rule. Absent where no model is configured. */
  compileRule?: (input: {
    sentence: string;
    mailboxEmail: string;
  }) => Promise<MailRuleCompilation>;
  /**
   * Asks the manager about a forward that leaves the company.
   *
   * Optional, and its absence is not silent: the route still refuses the rule
   * and still names the approver, so nothing ungoverned is created — the member
   * is simply told to go and ask rather than being asked on their behalf.
   */
  requestExternalForwardApproval?: (
    input: MailRuleExternalApprovalInput,
  ) => Promise<MailRuleExternalApprovalOutcome>;
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

  /**
   * The permission answer, given at the point of asking.
   *
   * Refused here rather than at every delivery, silently, forever. The
   * permission is real either way — `authorizeRule` re-checks it on each
   * message and a rule its owner may not execute never fires. What was missing
   * was anybody being told: the rule was written, listed, and shown as Working,
   * and it simply did nothing. Enforcement stays at the point of action; this
   * is the answer, given when somebody asks.
   *
   * Returns `true` when it has already answered the request, so callers read as
   * `if (await refused(...)) return;`.
   */
  const refused = async (
    res: Response,
    operation: MailRuleOperation,
  ): Promise<boolean> => {
    if (!deps.canRunMailRules) return false;
    const who = actor(res);
    const departmentId = res.locals['runtimeDepartmentId']
      ? String(res.locals['runtimeDepartmentId'])
      : (await deps.resolveDepartmentId?.(who)) ?? null;
    const may = await deps.canRunMailRules({
      ...who,
      companyRole: String(res.locals['aiRole'] ?? 'MEMBER'),
      ...(departmentId ? { departmentId } : {}),
      operation,
    });
    if (may.kind === 'denied') {
      res.status(403).json({
        success: false,
        code: 'not_permitted',
        message: may.message
          ?? 'You do not have permission to change mail automations. '
            + 'Ask an administrator for access to Mail automations.',
      });
      return true;
    }
    if (may.kind === 'unavailable') {
      // A store that could not be read is not a refusal. Saying "denied" would
      // send somebody asking for access they already have.
      res.status(503).json({
        success: false,
        code: 'permission_unavailable',
        message: may.message ?? 'Divo could not check your access just now. Try again shortly.',
      });
      return true;
    }
    return false;
  };

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
              judge: rule.judge,
              createdAt: rule.createdAt.toISOString(),
              lastDeliveredAt: rule.lastDeliveredAt?.toISOString() ?? null,
              deliveredCount: rule.deliveredCount,
              failingCount: rule.failingCount,
              abandonedCount: rule.abandonedCount,
              blockedCount: rule.blockedCount,
              heldCount: rule.heldCount,
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
            // The rule page used to show no verdicts at all while the Caught
            // feed showed every one of them, about the very same deliveries.
            verdict: delivery.verdict,
            resolvedDestination: delivery.resolvedDestination,
          })),
        },
      });
    } catch (error) {
      fail(res, 'deliveries', error);
    }
  });

  /**
   * The standing summary of this member's mail, and when it arrives.
   *
   * `null` rather than a 404 when there is none: a member with no rules yet has
   * no watched mailbox and therefore no brief, and that is an ordinary state to
   * be in rather than a missing resource. The screen says "once you have a rule"
   * instead of showing an error.
   */
  router.get('/brief', async (_req, res) => {
    try {
      const brief = await deps.briefRepo?.readBriefForUser(actor(res));
      if (!brief) {
        res.json({ success: true, data: { brief: null } });
        return;
      }
      if (!brief.ok) throw brief.error;
      res.json({
        success: true,
        data: {
          brief: brief.value && {
            ...brief.value,
            nextRunAt: brief.value.nextRunAt?.toISOString() ?? null,
            lastRunAt: brief.value.lastRunAt?.toISOString() ?? null,
          },
        },
      });
    } catch (error) {
      fail(res, 'brief', error);
    }
  });

  /**
   * Change when it arrives, or switch it off.
   *
   * `nextRunAt` is recomputed here rather than left to the worker, so the answer
   * can say when the next one is due — a member who moves their brief to 07:00
   * and is told nothing has no way to know whether it took.
   */
  router.patch('/brief', async (req, res) => {
    const body = briefUpdateSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        success: false,
        message: body.error.issues[0]?.message ?? 'That schedule could not be read.',
      });
      return;
    }
    if (!deps.briefRepo) {
      res.status(503).json({
        success: false,
        message: 'Briefs are not available in this environment.',
      });
      return;
    }
    try {
      const { paused, ...schedule } = body.data;
      const nextRunAt = nextMailBriefRunAt(schedule, new Date());
      const updated = await deps.briefRepo.updateBriefForUser({
        ...actor(res),
        ...schedule,
        status: paused ? 'paused' : 'active',
        nextRunAt,
      });
      if (!updated.ok) throw updated.error;
      if (!updated.value) {
        res.status(404).json({
          success: false,
          message: 'You do not have a brief yet. Divo sets one up with your first mail rule.',
        });
        return;
      }
      res.json({
        success: true,
        data: {
          paused,
          nextRunAt: paused ? null : nextRunAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      fail(res, 'brief', error);
    }
  });

  /**
   * What every rule of this member's has been doing, in one list.
   *
   * `/rules/:ruleId/deliveries` answers "is this rule working" on a page that
   * already names the rule. This answers the question a member turns up with —
   * *what has Divo been doing with my mail* — which otherwise cost one request
   * per rule and could not be asked at all about a rule they had forgotten.
   *
   * Ownership is enforced inside the query rather than by filtering afterwards,
   * so a bug here cannot widen it to the company.
   */
  router.get('/caught', async (req, res) => {
    const query = deliveriesQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        success: false,
        message: `limit must be between 1 and ${MAX_DELIVERY_LIMIT}.`,
      });
      return;
    }
    try {
      const caught = await deps.readRepo.listCaughtForUser({
        ...actor(res),
        limit: query.data.limit ?? DEFAULT_CAUGHT_LIMIT,
      });
      if (!caught.ok) throw caught.error;

      res.json({
        success: true,
        data: {
          caught: caught.value.map(row => ({
            deliveryId: row.deliveryId,
            status: row.status,
            attempts: row.attempts,
            ambiguous: row.ambiguous,
            lastError: row.lastError,
            subject: row.subject,
            from: row.from,
            firstAttemptAt: row.firstAttemptAt.toISOString(),
            deliveredAt: row.deliveredAt?.toISOString() ?? null,
            nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
            ruleId: row.ruleId,
            ruleName: row.ruleName,
            action: row.action,
            destination: row.destination,
            verdict: row.verdict,
            // Where it actually went, on a rule that chooses per message. The
            // feed must prefer this over the rule's own destination, which on a
            // routed rule is a table and would name the wrong person.
            resolvedDestination: row.resolvedDestination,
          })),
        },
      });
    } catch (error) {
      fail(res, 'caught', error);
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
      // Read from the session, never from the request.
      const openId = typeof res.locals['larkOpenId'] === 'string'
        ? String(res.locals['larkOpenId'])
        : null;
      if (body.destination.type === 'lark_dm' && !openId) {
        res.status(409).json({
          success: false,
          code: 'lark_not_linked',
          message:
            'Divo reaches you through Lark, and your Lark account is not linked yet. '
            + 'Link it once and this rule can message you directly.',
        });
        return;
      }

      const destination: MailRuleDestination =
        body.destination.type === 'email'
          ? { type: 'email', email: body.destination.email }
          : body.destination.type === 'lark_dm'
            ? { type: 'lark_dm', openId: openId! }
            : body.destination.type === 'routed'
              ? {
                  type: 'routed',
                  routes: body.destination.routes.map(route => ({
                    key: route.key,
                    when: route.when,
                    destination: { type: 'email' as const, email: route.destination.email },
                  })),
                  // Absent means hold: nothing is sent and the member sees it.
                  // Never a silent drop, which is the one outcome a routing
                  // table must not be able to produce.
                  otherwise: body.destination.otherwise === undefined
                    || body.destination.otherwise === 'hold'
                    ? 'hold'
                    : { type: 'email', email: body.destination.otherwise.email },
                }
              : { type: 'none' };

      const action: MailRuleAction = body.destination.type === 'organize'
        ? {
            type: 'organize',
            ...(body.destination.label !== undefined ? { label: body.destination.label } : {}),
            ...(body.destination.archive !== undefined ? { archive: body.destination.archive } : {}),
            ...(body.destination.markRead !== undefined ? { markRead: body.destination.markRead } : {}),
          }
        : actionForDestination(destination, body.rateLimitPerHour);

      /*
       * Resolved once, used by both the rule row and the approval question.
       *
       * The runtime's own value wins where there is one — a Pi token states
       * which department it is acting for, and that is more specific than the
       * member's standing preference.
       */
      const who = actor(res);
      const departmentId = res.locals['runtimeDepartmentId']
        ? String(res.locals['runtimeDepartmentId'])
        : (await deps.resolveDepartmentId?.(who)) ?? null;

      if (await refused(res, 'create')) return;

      const outcome = await deps.writeRule.create({
        ...who,
        ...(departmentId ? { departmentId } : {}),
        ...(body.connectionId ? { connectionId: body.connectionId } : {}),
        name: body.name,
        // The schema is the tool's own, so the value is already right; the cast
        // only bridges `exactOptionalPropertyTypes`, where zod's `string |
        // undefined` output does not satisfy an optional-but-not-undefined field.
        match: body.match as MailRuleWriteRequest['match'],
        destination,
        ...(body.rateLimitPerHour !== undefined ? { rateLimitPerHour: body.rateLimitPerHour } : {}),
        ...(body.judge ? { judge: body.judge } : {}),
        // What "outside the company" is measured against. Absent reads as
        // external, which asks one extra person rather than none.
        ...(typeof res.locals['email'] === 'string'
          ? { requesterEmail: res.locals['email'] as string }
          : {}),
        // Who is asking, which decides whether anyone is asked about an
        // external forward at all — a company admin is not.
        companyRole: String(res.locals['aiRole'] ?? 'MEMBER'),
      }, action);

      if (outcome.status === 'created') {
        log.info('mail_automations.rule_created', {
          companyId: res.locals['companyId'],
          ruleId: outcome.ruleId,
          destination: destination.type,
          existing: outcome.existing,
        });
        /*
         * 200 when a rule was already there, 201 only for a genuinely new one.
         *
         * This is an upsert on a key derived from the rule's own content, so
         * asking for a rule that exists returns it and asking for one that was
         * archived brings it back. Both are right, and both used to answer 201
         * Created — so a member who archived a rule in March and built the same
         * one in August was handed a "new" rule already carrying five months of
         * deliveries, with nothing anywhere saying why.
         */
        res.status(outcome.existing ? 200 : 201).json({
          success: true,
          data: outcome,
          ...(outcome.existing === 'archived'
            ? { message: 'That rule already existed, archived. It has been switched back on rather than duplicated — it keeps its history.' }
            : outcome.existing === 'paused'
              ? { message: 'That rule already existed and was paused. It has been resumed rather than duplicated.' }
              : outcome.existing === 'active'
                /*
                 * "Nothing was duplicated" was true and still misleading.
                 *
                 * No row was added — but this path rewrites the rule's name,
                 * its hourly ceiling and its AI question, because none of the
                 * three is part of the dedupe key. A member who sent a new
                 * question and read "nothing was duplicated" had every reason
                 * to think their question had been ignored. It had not; the
                 * sentence simply never mentioned it.
                 */
                ? { message: 'That rule already exists and is already running, so nothing was duplicated — but its name, its hourly ceiling and its AI question now match what you just sent.' }
                : {}),
        });
        return;
      }

      /*
       * Not a dead end — the manager is asked, here, now.
       *
       * The rule is deliberately not written first and activated later. A row
       * that exists but does nothing is a rule the member can see, name and
       * believe in, and every screen would then have to explain why it is
       * inert. The request is the thing that is pending; the rule is written
       * once, when the answer is yes.
       */
      if (outcome.status === 'external_approval_required') {
        // Logged whatever happens next: this is the record that somebody tried
        // to set up a standing export, which is worth being able to find later
        // whether or not it was ever approved.
        log.info('mail_automations.external_forward_pending', {
          companyId: res.locals['companyId'],
          destination: outcome.destination,
          approverId: outcome.approver.userId,
        });

        /*
         * Email and routed both reach here. A routed rule is several external
         * forwards asked about at once, and gating this on `type === 'email'`
         * would have written no approval at all for it — which reads, from the
         * member's side, as a rule that simply never appears.
         */
        if (
          deps.requestExternalForwardApproval
          && (body.destination.type === 'email' || body.destination.type === 'routed')
        ) {
          const asked = await deps.requestExternalForwardApproval({
            ...who,
            companyRole: String(res.locals['aiRole'] ?? 'MEMBER'),
            ...(departmentId ? { departmentId } : {}),
            ...(typeof res.locals['email'] === 'string'
              ? { requesterEmail: res.locals['email'] as string }
              : {}),
            larkOpenId: (res.locals['larkOpenId'] as string | null) ?? null,
            larkTenantKey: (res.locals['larkTenantKey'] as string | null) ?? null,
            mailboxEmail: outcome.mailboxEmail,
            rule: {
              connectionId: outcome.connectionId,
              name: body.name,
              match: body.match as MailRuleWriteRequest['match'],
              // The destination as resolved above, not rebuilt from one
              // address: the rule the manager approves has to be the rule the
              // member built, branches and all.
              destination,
              ...(body.rateLimitPerHour !== undefined
                ? { rateLimitPerHour: body.rateLimitPerHour }
                : {}),
              // Carried into the approval, so the rule that gets written when
              // the manager agrees is the one the member actually built.
              ...(body.judge ? { judge: body.judge } : {}),
            },
          });

          if (asked.kind === 'requested') {
            // 202, not 201: the request was taken, and the rule does not exist.
            res.status(202).json({
              success: true,
              code: 'pending_approval',
              data: {
                status: 'pending_approval',
                approvalId: asked.approvalId,
                approverName: asked.approverName,
                destination: outcome.destination,
                reused: asked.reused,
              },
              message: asked.reused
                ? `${asked.approverName} has already been asked about this rule and has not answered yet.`
                : `Asked ${asked.approverName} to approve forwarding to ${outcome.destination}. `
                  + 'The rule turns on by itself once they agree.',
            });
            return;
          }
          if (asked.kind !== 'unavailable') {
            res.status(409).json({
              success: false,
              code: asked.kind === 'declined' ? 'external_approval_declined' : 'external_approval_granted',
              message: asked.message,
            });
            return;
          }
          // Fell through: say who has to approve rather than why Divo could not
          // ask them, which is nothing the member can act on.
          log.warn('mail_automations.external_forward_ask_failed', {
            companyId: res.locals['companyId'],
            reason: asked.message,
          });
        }
      }

      const refusal = REFUSALS[outcome.status];
      res.status(refusal.code).json({
        success: false,
        code: outcome.status,
        message: outcome.status === 'external_approval_required'
          // Names the person, because "needs approval" without a name leaves
          // somebody with nothing to do next.
          ? `Forwarding to ${outcome.destination} sends your mail outside your `
            + `organisation, so ${outcome.approver.displayName} has to approve it first.`
          : 'reason' in outcome && outcome.reason ? outcome.reason : refusal.message,
        ...(outcome.status === 'external_approval_required'
          ? { approverName: outcome.approver.displayName, destination: outcome.destination }
          : {}),
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
   * Edit a rule from the web.
   *
   * The last operation the agent's tool had and this router did not, which made
   * the Edit button on every rule a control with nothing behind it.
   *
   * It runs `writeRule.replace`, which shares its whole precondition sequence
   * with `create` — see `prepare` in the writer. That sharing is the point
   * rather than tidiness: without it, an edit is a way to reach in two steps a
   * rule the first step refused. Build an internal forward, which needs nobody's
   * approval, then edit the address to one outside the company. Same gate, both
   * paths, or the gate means nothing.
   *
   * The mailbox is not editable. A rule watching a different inbox is a
   * different rule, and moving one silently would leave its whole delivery
   * history describing mail it never saw.
   */
  router.put('/rules/:ruleId', async (req, res) => {
    if (!deps.writeRule?.replace) {
      res.status(503).json({
        success: false,
        message: 'Mail rules cannot be edited in this environment.',
      });
      return;
    }

    const ruleId = z.string().uuid().safeParse(req.params['ruleId']);
    if (!ruleId.success) {
      res.status(400).json({ success: false, message: 'Invalid rule ID.' });
      return;
    }

    const parsed = createRuleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? 'That change could not be read.',
      });
      return;
    }

    const body = parsed.data;
    try {
      // Read from the session, never from the request.
      const openId = typeof res.locals['larkOpenId'] === 'string'
        ? String(res.locals['larkOpenId'])
        : null;
      if (body.destination.type === 'lark_dm' && !openId) {
        res.status(409).json({
          success: false,
          code: 'lark_not_linked',
          message:
            'Divo reaches you through Lark, and your Lark account is not linked yet. '
            + 'Link it once and this rule can message you directly.',
        });
        return;
      }

      const destination: MailRuleDestination =
        body.destination.type === 'email'
          ? { type: 'email', email: body.destination.email }
          : body.destination.type === 'lark_dm'
            ? { type: 'lark_dm', openId: openId! }
            : body.destination.type === 'routed'
              ? {
                  type: 'routed',
                  routes: body.destination.routes.map(route => ({
                    key: route.key,
                    when: route.when,
                    destination: { type: 'email' as const, email: route.destination.email },
                  })),
                  // Absent means hold: nothing is sent and the member sees it.
                  // Never a silent drop, which is the one outcome a routing
                  // table must not be able to produce.
                  otherwise: body.destination.otherwise === undefined
                    || body.destination.otherwise === 'hold'
                    ? 'hold'
                    : { type: 'email', email: body.destination.otherwise.email },
                }
              : { type: 'none' };

      const action: MailRuleAction = body.destination.type === 'organize'
        ? {
            type: 'organize',
            ...(body.destination.label !== undefined ? { label: body.destination.label } : {}),
            ...(body.destination.archive !== undefined ? { archive: body.destination.archive } : {}),
            ...(body.destination.markRead !== undefined ? { markRead: body.destination.markRead } : {}),
          }
        : actionForDestination(destination, body.rateLimitPerHour);

      const who = actor(res);
      const departmentId = res.locals['runtimeDepartmentId']
        ? String(res.locals['runtimeDepartmentId'])
        : (await deps.resolveDepartmentId?.(who)) ?? null;

      if (await refused(res, 'update')) return;

      const outcome = await deps.writeRule.replace({
        ...who,
        ruleId: ruleId.data,
        ...(departmentId ? { departmentId } : {}),
        ...(body.connectionId ? { connectionId: body.connectionId } : {}),
        name: body.name,
        match: body.match as MailRuleWriteRequest['match'],
        destination,
        ...(body.rateLimitPerHour !== undefined ? { rateLimitPerHour: body.rateLimitPerHour } : {}),
        ...(body.judge ? { judge: body.judge } : {}),
        ...(typeof res.locals['email'] === 'string'
          ? { requesterEmail: res.locals['email'] as string }
          : {}),
        companyRole: String(res.locals['aiRole'] ?? 'MEMBER'),
      }, action);

      if (outcome.status === 'replaced') {
        log.info('mail_automations.rule_replaced', {
          companyId: res.locals['companyId'],
          ruleId: outcome.ruleId,
          destination: destination.type,
          resumed: outcome.resumed,
        });
        res.json({
          success: true,
          data: outcome,
          // Only when it happened. A rule that was already running does not
          // need to be told it is running.
          ...(outcome.resumed
            ? {
                message:
                  'Saved, and this rule is running again — editing a paused rule '
                  + 'starts it. Pause it again if that is not what you wanted.',
              }
            : {}),
        });
        return;
      }

      if (outcome.status === 'archived') {
        // Real, theirs, and archived — so "not found in your account" was a lie
        // about a rule sitting in their own list. Archiving is final, and the
        // way forward is a new rule rather than a retry of this one.
        res.status(409).json({
          success: false,
          code: 'rule_archived',
          message:
            'That rule is archived, and archiving is final — it cannot be edited '
            + 'or restarted. Create a new rule with these conditions instead.',
        });
        return;
      }

      if (outcome.status === 'not_found') {
        // Not yours and not real are deliberately indistinguishable: the
        // repository enforces ownership inside the query, so answering them
        // differently would confirm that somebody else's rule exists.
        res.status(404).json({
          success: false,
          message: 'That mail rule was not found in your account.',
        });
        return;
      }

      /*
       * Two collisions, two remedies, and they are opposites.
       *
       * A live one means two rules would act on the same message — narrow the
       * conditions. An archived one means the rule being asked for already
       * exists somewhere the member cannot see from this screen, and restoring
       * it is what they want rather than a second copy. Saying only "that
       * already exists" for the second reads as Divo being wrong.
       */
      if (outcome.status === 'duplicate' || outcome.status === 'duplicate_archived') {
        res.status(409).json({
          success: false,
          code: outcome.status,
          status: outcome.status,
          message: outcome.status === 'duplicate_archived'
            ? 'An archived rule on this mailbox already has exactly these conditions. Restore it '
              + 'rather than making a second — it keeps its place and its history.'
            : 'Another rule on this mailbox already has exactly these conditions, and two rules '
              + 'matching one message act on it twice.',
        });
        return;
      }

      if (outcome.status === 'external_approval_required') {
        log.info('mail_automations.external_forward_pending', {
          companyId: res.locals['companyId'],
          ruleId: ruleId.data,
          destination: outcome.destination,
          approverId: outcome.approver.userId,
        });

        /*
         * Email and routed both reach here. A routed rule is several external
         * forwards asked about at once, and gating this on `type === 'email'`
         * would have written no approval at all for it — which reads, from the
         * member's side, as a rule that simply never appears.
         */
        if (
          deps.requestExternalForwardApproval
          && (body.destination.type === 'email' || body.destination.type === 'routed')
        ) {
          const asked = await deps.requestExternalForwardApproval({
            ...who,
            companyRole: String(res.locals['aiRole'] ?? 'MEMBER'),
            ...(departmentId ? { departmentId } : {}),
            ...(typeof res.locals['email'] === 'string'
              ? { requesterEmail: res.locals['email'] as string }
              : {}),
            larkOpenId: (res.locals['larkOpenId'] as string | null) ?? null,
            larkTenantKey: (res.locals['larkTenantKey'] as string | null) ?? null,
            mailboxEmail: outcome.mailboxEmail,
            rule: {
              // Carried so an approved edit replays as the edit. Without it the
              // replay would `create`, which upserts on the dedupe key — the
              // member would end up with the new rule and the old one still
              // forwarding beside it.
              ruleId: ruleId.data,
              connectionId: outcome.connectionId,
              name: body.name,
              match: body.match as MailRuleWriteRequest['match'],
              // The destination as resolved above, not rebuilt from one
              // address: the rule the manager approves has to be the rule the
              // member built, branches and all.
              destination,
              ...(body.rateLimitPerHour !== undefined
                ? { rateLimitPerHour: body.rateLimitPerHour }
                : {}),
              // Carried into the approval, so the rule that gets written when
              // the manager agrees is the one the member actually built.
              ...(body.judge ? { judge: body.judge } : {}),
            },
          });

          if (asked.kind === 'requested') {
            // 202, not 200: the request was taken, and the rule is unchanged.
            res.status(202).json({
              success: true,
              code: 'pending_approval',
              data: {
                status: 'pending_approval',
                approvalId: asked.approvalId,
                approverName: asked.approverName,
                destination: outcome.destination,
                reused: asked.reused,
              },
              message: asked.reused
                ? `${asked.approverName} has already been asked about this change and has not answered yet.`
                : `Asked ${asked.approverName} to approve forwarding to ${outcome.destination}. `
                  + 'The change applies by itself once they agree.',
            });
            return;
          }
          if (asked.kind !== 'unavailable') {
            res.status(409).json({
              success: false,
              code: asked.kind === 'declined' ? 'external_approval_declined' : 'external_approval_granted',
              message: asked.message,
            });
            return;
          }
          log.warn('mail_automations.external_forward_ask_failed', {
            companyId: res.locals['companyId'],
            reason: asked.message,
          });
        }
      }

      const refusal = REFUSALS[outcome.status];
      res.status(refusal.code).json({
        success: false,
        code: outcome.status,
        message: outcome.status === 'external_approval_required'
          ? `Forwarding to ${outcome.destination} sends your mail outside your `
            + `organisation, so ${outcome.approver.displayName} has to approve it first.`
          : 'reason' in outcome && outcome.reason ? outcome.reason : refusal.message,
        ...(outcome.status === 'external_approval_required'
          ? { approverName: outcome.approver.displayName, destination: outcome.destination }
          : {}),
        ...(outcome.status === 'choose_connection' ? { connections: outcome.connections } : {}),
        ...(outcome.status === 'connection_unavailable' && outcome.connectionState
          ? { connectionState: outcome.connectionState }
          : {}),
      });
    } catch (error) {
      fail(res, 'update', error);
    }
  });

  /*
   * Off, on, and away.
   *
   * `POST` for pause and resume, `DELETE` for archive — and archive really is
   * what DELETE does here, because an archived rule keeps its identity so that
   * re-creating the same rule revives that row rather than making a second one
   * beside it. A hard delete would leave two rules forwarding every matching
   * message twice, which is the collision the dedupe key exists to prevent.
   */
  const statusRoute = (change: MailRuleStatusChange) =>
    async (req: import('express').Request, res: Response): Promise<void> => {
      if (!deps.writeRule) {
        res.status(503).json({
          success: false,
          message: 'Mail rules cannot be changed in this environment.',
        });
        return;
      }
      const ruleId = z.string().uuid().safeParse(req.params['ruleId']);
      if (!ruleId.success) {
        res.status(400).json({ success: false, message: 'Invalid rule ID.' });
        return;
      }
      /*
       * These three had no permission check at all.
       *
       * Divo in Lark has always asked: `resume` needs `update` and background
       * `execute`, `archive` needs `delete`. A browser asked nothing, so a
       * member whose access had been revoked could still resume a paused rule
       * — and it went straight back to acting on their mail. `pause` is gated
       * too, on `update` *or* `delete`, so stopping a rule is never harder than
       * deleting it.
       */
      if (await refused(res, change)) return;
      try {
        const outcome = await deps.writeRule.setStatus(
          { ...actor(res), ruleId: ruleId.data },
          change,
        );
        if (outcome.status === 'changed') {
          log.info('mail_automations.rule_status_changed', {
            companyId: res.locals['companyId'],
            ruleId: ruleId.data,
            change,
          });
          res.json({ success: true, data: { ruleId: ruleId.data, change } });
          return;
        }
        if (outcome.status === 'not_found') {
          // Not yours and not real are deliberately indistinguishable: the
          // repository enforces ownership inside the query, so answering them
          // differently would confirm that somebody else's rule exists.
          res.status(404).json({
            success: false,
            message: 'That mail rule was not found in your account.',
          });
          return;
        }
        /*
         * Same answer `PUT /rules/:id` gives, for the same reason: the member is
         * looking at this rule under Archived, so "not found in your account"
         * reads as Divo having lost it. 409 rather than 404 — nothing about the
         * request is wrong, and retrying it will not help.
         */
        if (outcome.status === 'archived') {
          res.status(409).json({
            success: false,
            code: 'rule_archived',
            message:
              'That rule is archived, and archiving is final — it cannot be paused or restarted. '
              + 'Create a new rule with these conditions instead.',
          });
          return;
        }
        if (outcome.status === 'not_configured') {
          res.status(503).json({
            success: false,
            code: 'not_configured',
            message:
              'Mail automation is not running in this environment, so resuming this rule would '
              + 'not start it firing again.',
          });
          return;
        }
        res.status(500).json({ success: false, message: outcome.reason });
      } catch (error) {
        fail(res, change, error);
      }
    };

  router.post('/rules/:ruleId/pause', statusRoute('pause'));
  router.post('/rules/:ruleId/resume', statusRoute('resume'));
  router.delete('/rules/:ruleId', statusRoute('archive'));

  /**
   * One sentence in, a draft rule out. Creates nothing.
   *
   * The draft comes back as the same editable conditions somebody would have
   * filled in by hand, so describing and building are one object rather than
   * two modes — and what they approve is what they can still change.
   */
  router.post('/compile', async (req, res) => {
    if (!deps.compileRule) {
      res.status(503).json({
        success: false,
        message: 'Divo cannot read a rule from a sentence in this environment.',
      });
      return;
    }
    const parsed = compileBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Say what the rule should do.' });
      return;
    }
    try {
      // The mailbox is named to the model so "me" and "my inbox" resolve to
      // something concrete rather than being guessed at.
      const found = await deps.readRepo.listRecentEventsForMailbox({
        ...actor(res),
        ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
        limit: 1,
      });
      if (!found.ok) throw found.error;

      const outcome = await deps.compileRule({
        sentence: parsed.data.sentence,
        mailboxEmail: found.value?.mailboxEmail ?? String(res.locals['email'] ?? 'your inbox'),
      });
      res.json({ success: true, data: outcome });
    } catch (error) {
      fail(res, 'compile', error);
    }
  });

  /**
   * "Would these conditions have caught anything?" — before a rule exists.
   *
   * Every message is judged, with nothing counted as predating, because there
   * is no rule yet for anything to predate. The honest question here is what it
   * *would* have caught had it existed, and that is what this answers.
   */
  router.post('/preview', async (req, res) => {
    const parsed = previewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? 'Those conditions could not be read.',
      });
      return;
    }
    try {
      const found = await deps.readRepo.listRecentEventsForMailbox({
        ...actor(res),
        ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
        limit: parsed.data.limit ?? DEFAULT_DRY_RUN_EVENTS,
      });
      if (!found.ok) throw found.error;
      if (found.value === null) {
        // Nothing stored, which is the ordinary state before a first rule —
        // not a failure, and not evidence the conditions are wrong.
        res.json({
          success: true,
          data: { watched: false, consideredCount: 0, matchedCount: 0, bodyUnavailableCount: 0, matched: [] },
        });
        return;
      }

      const outcome = dryRunMailRule({
        rule: {
          match: parsed.data.match,
          action: { type: 'organize', markRead: true },
          destination: { type: 'none' },
          // Epoch: with no rule, nothing can predate one. Using the
          // subscription's own date would mark old mail as missed by a rule
          // that never existed to miss it.
          activatedAt: new Date(0),
        },
        events: found.value.events,
      });

      if (outcome.status === 'rule_invalid') {
        res.status(400).json({ success: false, message: outcome.reason });
        return;
      }

      res.json({
        success: true,
        data: {
          watched: true,
          mailboxEmail: found.value.mailboxEmail,
          consideredCount: outcome.consideredCount,
          matchedCount: outcome.matched.length,
          bodyUnavailableCount: outcome.bodyUnavailableCount,
          matched: outcome.matched.slice(0, 10).map(hit => ({
            eventId: hit.eventId,
            occurredAt: hit.occurredAt.toISOString(),
            from: hit.from,
            subject: hit.subject,
          })),
        },
      });
    } catch (error) {
      fail(res, 'preview', error);
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
