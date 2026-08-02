import { Prisma, type PrismaClient } from '../../../generated/prisma';
import {
  mailRuleDedupeKey,
  type MailRuleAction,
  type MailRuleDestination,
  type MailRuleMatch,
} from '../../../application/mail-ops/mail-ops.types';
import { wrapInfra, type InfraError } from '../../../shared/errors';
import { err, ok, type Result } from '../../../shared/result';

type MailRuleDb = Pick<
  PrismaClient,
  'mailAutomationRule' | 'mailboxSubscription' | '$transaction'
>;

/**
 * What became of a replace. `duplicate` is its own answer rather than a
 * failure: the rule the member asked for exists, it is just not the row they
 * named.
 */
export type MailRuleReplacement =
  | 'replaced'
  | 'not_found'
  | 'duplicate'
  | 'duplicate_archived';

export interface CreateMailAutomationRuleInput {
  companyId: string;
  createdByUserId: string;
  departmentId?: string;
  name: string;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
  connectionId: string;
  mailboxEmail: string;
  dedupeKey: string;
}

export interface MailAutomationRuleSummary {
  ruleId: string;
  name: string;
  status: string;
  mailboxEmail: string;
  connectionId: string;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Is this stored rule clause the same one the caller is submitting?
 *
 * Neither key order nor letter case is meaning here. Both sides are small JSON
 * objects round-tripped through Postgres and Zod, and every clause is matched
 * case-insensitively (`mailRuleMatches`), so retyping `OTP` as `otp` changes
 * nothing about which mail the rule takes. Scoring that as a change would
 * restart the rule's watch and drop its backlog, which is the harm this
 * comparison exists to prevent.
 *
 * `toLowerCase`, matching the fold used by `mailRuleMatches` and by the rule's
 * stored identity. A locale-sensitive one would leave the three disagreeing:
 * under a Turkish locale a case-only edit would count as a change here, and
 * drop the backlog, while both of the others called it the same rule.
 */
function sameRuleClause(stored: unknown, submitted: unknown): boolean {
  return stableJson(stored) === stableJson(submitted);
}

/**
 * An action with its hourly ceiling removed, for deciding whether a rule
 * restarted.
 *
 * The ceiling is how fast a rule may send, not what it watches or where it
 * sends — the same reasoning that keeps it out of `mailRuleDedupeKey`. Left in
 * the comparison, changing it counted as the rule becoming a different rule:
 * `activatedAt` moved to now and every message the rule had not reached yet
 * became mail it was no longer entitled to act on. So did *omitting* it, which
 * an `update` that only renames the rule does — the member asks for a rename
 * and silently loses their backlog and their cap together.
 */
function withoutRateLimit(action: unknown): unknown {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const { rateLimitPerHour: _ignored, ...rest } = action as Record<string, unknown>;
  return rest;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (key, inner) => {
    // Except a Lark chat ID, which the rule's identity also leaves alone: two
    // chats whose IDs differ only in case are two chats, and calling that no
    // change would deliver the old destination's backlog into the new one.
    if (key === 'chatId') return inner;
    if (typeof inner === 'string') return inner.toLowerCase();
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    );
  });
}

/**
 * The rules themselves: creating them, editing them, and starting and stopping
 * them.
 *
 * It reaches the subscription table as well, because a rule coming into
 * existence is also the mailbox behind it coming alive, and the two have to
 * land in one transaction or a rule can exist against a mailbox nobody polls.
 */
export class MailAutomationRuleRepository {
  constructor(private readonly db: MailRuleDb) {}

  async createRuleForMailbox(
    input: CreateMailAutomationRuleInput,
  ): Promise<Result<{ ruleId: string; subscriptionId: string }, InfraError>> {
    try {
      // Ahead of the transaction, not inside it. Postgres aborts a transaction
      // outright on a unique violation, so a swallowed collision there would
      // leave every later statement failing on a dead transaction — the create
      // would report failure for a rule that exists and is watching. On its
      // own it is an idempotent key rename: safe to have committed even if the
      // create that follows does not.
      await this.adoptRuleKeyedBeforeCanonicalisation(input);
      const created = await this.db.$transaction(async tx => {
        const subscription = await tx.mailboxSubscription.upsert({
          where: { connectionId: input.connectionId },
          create: {
            companyId: input.companyId,
            userId: input.createdByUserId,
            connectionId: input.connectionId,
            mailboxEmail: input.mailboxEmail,
          },
          update: {
            mailboxEmail: input.mailboxEmail,
            status: 'active',
            nextPollAt: new Date(),
            nextWatchRenewalAt: new Date(),
            failureCode: null,
            lastError: null,
          },
          select: { id: true },
        });
        const rule = await tx.mailAutomationRule.upsert({
          where: { dedupeKey: input.dedupeKey },
          create: {
            companyId: input.companyId,
            createdByUserId: input.createdByUserId,
            ...(input.departmentId ? { departmentId: input.departmentId } : {}),
            subscriptionId: subscription.id,
            name: input.name,
            matchJson: input.match as Prisma.InputJsonObject,
            actionJson: input.action as Prisma.InputJsonObject,
            destinationJson: input.destination as Prisma.InputJsonObject,
            dedupeKey: input.dedupeKey,
          },
          // Reviving is the conditional write below, not this branch. The
          // dedupe key is derived from the rule's own content, so "ask for the
          // same rule again" lands here just as often as a revive does, and a
          // rule that is already running must keep watching from where it was
          // — moving its floor would silently drop whatever backlog it had not
          // reached, and the member never asked for anything to stop.
          // `actionJson` alongside the name, and only because of
          // `rateLimitPerHour`. Every other field of the action is part of the
          // dedupe key, so landing here proves they already agree — the ceiling
          // is the one thing that can differ, and writing it is what makes
          // "create the same rule but slower" mean anything. Without this the
          // tool reported the new ceiling and the rule kept the old one.
          update: {
            name: input.name,
            actionJson: input.action as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        // Coming back to life and starting a fresh watch are one statement, so
        // a rule can never be revived still carrying a floor from before it
        // stopped. Issued after the upsert on purpose: it is the last thing
        // this transaction does, so it also catches a pause that committed
        // while the transaction was in flight — which the same test placed
        // before the upsert would miss, leaving the rule paused while the tool
        // told the member their automation was on.
        await tx.mailAutomationRule.updateMany({
          where: { id: rule.id, status: { not: 'active' } },
          data: {
            status: 'active',
            pausedAt: null,
            archivedAt: null,
            activatedAt: new Date(),
          },
        });
        return { ruleId: rule.id, subscriptionId: subscription.id };
      });
      return ok(created);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.createRuleForMailbox', cause));
    }
  }

  /**
   * Every rule this member holds on this mailbox, oldest first.
   *
   * Ordered so two requests racing the same decision reach the same one rather
   * than each acting on a different row. Archived rules are included:
   * recreating one is the only way to bring it back, so an archived row that is
   * this rule must be visible here or a revive silently becomes a second rule.
   */
  private async rulesOnMailbox(
    client: Pick<MailRuleDb, 'mailAutomationRule'>,
    input: { companyId: string; connectionId: string; createdByUserId?: string; userId?: string },
  ) {
    return client.mailAutomationRule.findMany({
      where: {
        companyId: input.companyId,
        createdByUserId: input.createdByUserId ?? input.userId!,
        subscription: { connectionId: input.connectionId },
      },
      select: {
        id: true,
        status: true,
        dedupeKey: true,
        matchJson: true,
        actionJson: true,
        destinationJson: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Is this stored rule the one being asked for?
   *
   * Answered from what the row holds, never from the key it carries. Every rule
   * written before canonicalisation carries a key derived by the old formula,
   * and that key cannot be reproduced from a request — so a comparison of
   * stored keys is blind to exactly the rules the migration is about.
   */
  private isSameRule(
    rule: {
      matchJson: unknown;
      actionJson: unknown;
      destinationJson: unknown;
    },
    input: { companyId: string; connectionId: string; dedupeKey: string },
    userId: string,
  ): boolean {
    return mailRuleDedupeKey({
      companyId: input.companyId,
      userId,
      connectionId: input.connectionId,
      match: rule.matchJson as MailRuleMatch,
      action: rule.actionJson as MailRuleAction,
      destination: rule.destinationJson as MailRuleDestination,
    }) === input.dedupeKey;
  }

  /**
   * Move a rule keyed before canonicalisation onto the key its content earns.
   *
   * Without this, canonicalising the key would cause on its first use the exact
   * duplicate it exists to prevent: the upsert below would find nothing, create
   * a second rule beside the one already watching, and both would forward every
   * matching message. Migration happens here, one rule at a time, as each is
   * asked for again — a bulk rewrite of every row on deploy would have to be
   * right about all of them at once.
   *
   * The canonical key is recomputed from what each stored rule holds, rather
   * than the old key being recomputed from the request — the request is the
   * one thing that cannot reproduce the old key. The
   * fork this repairs was a difference of case, so a member asking again in the
   * other case — `otp` where the stored rule says `OTP` — would hash to a third
   * key and match nothing. Comparing what the rules *are* is what makes the
   * migration cover the case that caused the damage.
   *
   * Skipped when a canonical row already exists, because then the two rules
   * genuinely are the fork this fix is about, and renaming one onto the other's
   * key would only fail the unique constraint and take the request with it. The
   * canonical one wins; the other keeps running until someone removes it.
   */
  private async adoptRuleKeyedBeforeCanonicalisation(
    input: CreateMailAutomationRuleInput,
  ): Promise<void> {
    const candidates = await this.rulesOnMailbox(this.db, input);
    if (candidates.some(rule => rule.dedupeKey === input.dedupeKey)) return;
    const sameRule = candidates.filter(
      rule => this.isSameRule(rule, input, input.createdByUserId),
    );
    if (sameRule.length === 0) return;
    // A live rule is preferred when the member already holds the fork this
    // repairs, because the create below revives whatever it lands on: adopting
    // the archived twin would bring a second rule back to life beside the one
    // already forwarding, which is the outcome the whole exercise is against.
    // Anything not archived, not only `active`: a paused rule is one the member
    // intends to resume, and leaving it on the old key while an archived twin
    // is adopted and revived hands them two live rules on two keys, which the
    // unique constraint cannot catch and which forwards every message twice.
    const adopted = sameRule.find(rule => rule.status !== 'archived')
      ?? sameRule[0]!;
    try {
      await this.db.mailAutomationRule.update({
        where: { id: adopted.id },
        data: { dedupeKey: input.dedupeKey },
      });
    } catch (cause) {
      // Another request claimed the canonical key between the scan and here.
      // That rule is this rule, so the create below finds it and there is
      // nothing left to migrate — failing the member's request over a race
      // that already reached the right answer would be the worse outcome.
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError
        && cause.code === 'P2002'
      ) return;
      throw cause;
    }
  }

  async listRulesForUser(input: {
    companyId: string;
    userId: string;
    includeInactive?: boolean;
  }): Promise<Result<MailAutomationRuleSummary[], InfraError>> {
    try {
      const rows = await this.db.mailAutomationRule.findMany({
        where: {
          companyId: input.companyId,
          createdByUserId: input.userId,
          ...(!input.includeInactive ? { status: 'active' } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          status: true,
          matchJson: true,
          actionJson: true,
          destinationJson: true,
          createdAt: true,
          subscription: {
            select: { mailboxEmail: true, connectionId: true },
          },
        },
      });
      return ok(rows.map(row => ({
        ruleId: row.id,
        name: row.name,
        status: row.status,
        mailboxEmail: row.subscription.mailboxEmail,
        connectionId: row.subscription.connectionId,
        match: row.matchJson as Record<string, unknown>,
        action: row.actionJson as Record<string, unknown>,
        destination: row.destinationJson as Record<string, unknown>,
        createdAt: row.createdAt,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.listRulesForUser', cause));
    }
  }

  async replaceRule(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    connectionId: string;
    name: string;
    match: Record<string, unknown>;
    action: Record<string, unknown>;
    destination: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<Result<MailRuleReplacement, InfraError>> {
    try {
      const changed = await this.db.$transaction(async tx => {
        const current = await tx.mailAutomationRule.findFirst({
          where: {
            id: input.ruleId,
            companyId: input.companyId,
            createdByUserId: input.userId,
            status: { not: 'archived' },
            subscription: { connectionId: input.connectionId },
          },
          select: {
            id: true,
            subscriptionId: true,
            status: true,
            matchJson: true,
            actionJson: true,
            destinationJson: true,
          },
        });
        if (!current) return 'not_found' as const;
        // Editing a rule into one this member already holds is a real answer —
        // the rule they are asking for exists — and it is reported rather than
        // left to raise a unique violation inside the transaction and reach
        // them as an infra failure they can do nothing about.
        //
        // Recognised the same way the create path recognises it: by what each
        // stored rule holds, not by the key it carries. Every rule written
        // before the key was canonicalised carries one derived by the old
        // formula, and no request can reproduce that — so a comparison of
        // stored keys is blind to precisely the rules this window is about, and
        // the edit would quietly produce the second active rule, forwarding
        // every matching message twice, that the whole exercise is against.
        const collision = (await this.rulesOnMailbox(tx, input)).find(
          rule => rule.id !== current.id
            && (
              rule.dedupeKey === input.dedupeKey
              || this.isSameRule(rule, input, input.userId)
            ),
        );
        if (collision) {
          // An archived rule holds its key too, and telling the member to
          // archive one of two rules forwarding twice would be untrue: the
          // other forwards nothing. Their way forward is a different one.
          return collision.status === 'archived'
            ? 'duplicate_archived' as const
            : 'duplicate' as const;
        }
        // The tool's `update` takes the whole rule, so renaming one resubmits
        // its existing match and destination. That is the same rule watching
        // the same address, and moving its floor would quietly drop whatever
        // backlog it had not reached — a stalled cursor is exactly when
        // somebody tidies up a rule's name. The floor moves when the rule
        // stopped, or when what it watches or where it sends actually changed.
        const restarting = current.status !== 'active'
          || !sameRuleClause(current.matchJson, input.match)
          || !sameRuleClause(
            withoutRateLimit(current.actionJson),
            withoutRateLimit(input.action),
          )
          || !sameRuleClause(current.destinationJson, input.destination);
        await tx.mailAutomationRule.update({
          where: { id: current.id },
          data: {
            name: input.name,
            matchJson: input.match as Prisma.InputJsonObject,
            actionJson: input.action as Prisma.InputJsonObject,
            destinationJson: input.destination as Prisma.InputJsonObject,
            dedupeKey: input.dedupeKey,
            status: 'active',
            pausedAt: null,
            version: { increment: 1 },
            // A replace can move the destination or widen the match. Mail that
            // arrived under the old ones was never this version of the rule's
            // to send, so it starts watching now.
            ...(restarting ? { activatedAt: new Date() } : {}),
          },
        });
        await tx.mailboxSubscription.update({
          where: { id: current.subscriptionId },
          data: {
            status: 'active',
            nextPollAt: new Date(),
            nextWatchRenewalAt: new Date(),
          },
        });
        return 'replaced' as const;
      });
      return ok(changed);
    } catch (cause) {
      // The check above narrows the window rather than closing it: another
      // request can claim the key between the two statements. Same answer.
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError
        && cause.code === 'P2002'
      ) return ok('duplicate');
      return err(wrapInfra('prisma', 'mailOps.replaceRule', cause));
    }
  }

  async setRuleStatus(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    status: 'active' | 'paused' | 'archived';
    now?: Date;
  }): Promise<Result<boolean, InfraError>> {
    const now = input.now ?? new Date();
    try {
      const changed = await this.db.$transaction(async tx => {
        const current = await tx.mailAutomationRule.findFirst({
          where: {
            id: input.ruleId,
            companyId: input.companyId,
            createdByUserId: input.userId,
          },
          select: { id: true, subscriptionId: true, status: true },
        });
        if (!current) return false;
        if (current.status === input.status) return true;
        if (current.status === 'archived') return false;
        await tx.mailAutomationRule.update({
          where: { id: current.id },
          data: {
            status: input.status,
            pausedAt: input.status === 'paused' ? now : null,
            archivedAt: input.status === 'archived' ? now : null,
            // Resuming is not a licence to deliver the pause. "Paused" was
            // sold to the member as "stop forwarding", so the mail that
            // arrived meanwhile is not this rule's to send.
            ...(input.status === 'active' ? { activatedAt: now } : {}),
          },
        });
        const activeRules = await tx.mailAutomationRule.count({
          where: { subscriptionId: current.subscriptionId, status: 'active' },
        });
        // A paused rule is meant to be resumable, and pausing the mailbox
        // underneath it made that untrue in both directions. A paused
        // subscription is claimed neither for sync nor for watch renewal, so
        // the cursor stood still; past Gmail's history retention the resume
        // 404s into recovery, which loses the intervening days outright *and*
        // replays up to a day of already-read mail through the freshly resumed
        // rule. Keeping the mailbox live costs a poll nobody needs and keeps
        // "paused" meaning what the member was told it means.
        const livingRules = await tx.mailAutomationRule.count({
          where: {
            subscriptionId: current.subscriptionId,
            status: { not: 'archived' },
          },
        });
        await tx.mailboxSubscription.update({
          where: { id: current.subscriptionId },
          data: livingRules > 0
            ? {
                status: 'active',
                // Only chase the mailbox immediately when something can
                // actually fire; otherwise let it keep its ordinary cadence.
                ...(activeRules > 0
                  ? { nextPollAt: now, nextWatchRenewalAt: now }
                  : {}),
              }
            : { status: 'paused' },
        });
        return true;
      });
      return ok(changed);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.setRuleStatus', cause));
    }
  }

  /**
   * Is this rule still one that may send?
   *
   * Asked again at delivery time because reserving a delivery and sending it
   * are two stages that can be minutes apart — a failed attempt sits on a
   * retry ladder — and the rule's status was only ever read in the first.
   * A member who paused a rule watched it keep forwarding, which is the one
   * thing "pause" promises not to do.
   */
  async isRuleSendable(ruleId: string): Promise<Result<boolean, InfraError>> {
    try {
      const rule = await this.db.mailAutomationRule.findUnique({
        where: { id: ruleId },
        select: { status: true },
      });
      // A rule that no longer exists is not one that may send. Nothing deletes
      // rows today — archiving is a status — but reading a missing row as
      // permission would be the wrong default the day something does.
      return ok(rule?.status === 'active');
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.isRuleSendable', cause));
    }
  }

  async listActiveRules(
    subscriptionId: string,
  ): Promise<Result<Array<{
    ruleId: string;
    departmentId?: string;
    activatedAt: Date;
    match: Record<string, unknown>;
    action: Record<string, unknown>;
    destination: Record<string, unknown>;
  }>, InfraError>> {
    try {
      const rules = await this.db.mailAutomationRule.findMany({
        where: { subscriptionId, status: 'active' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          departmentId: true,
          activatedAt: true,
          matchJson: true,
          actionJson: true,
          destinationJson: true,
        },
      });
      return ok(rules.map(rule => ({
        ruleId: rule.id,
        ...(rule.departmentId ? { departmentId: rule.departmentId } : {}),
        activatedAt: rule.activatedAt,
        match: rule.matchJson as Record<string, unknown>,
        action: rule.actionJson as Record<string, unknown>,
        destination: rule.destinationJson as Record<string, unknown>,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.listActiveRules', cause));
    }
  }
}
