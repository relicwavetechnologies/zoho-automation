import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type { TrackedFollowUp } from '../../domain/follow-ups/follow-up';
import type {
  FollowUpCreate,
  FollowUpResolve,
  FollowUpUpdate,
} from '../../application/follow-ups/follow-up-reconcile';
import type { TranscriptMessage } from '../../application/follow-ups/follow-up-analysis';

export interface AnalysisCandidate {
  readonly chatId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly chatName: string | null;
  readonly isGroup: boolean;
  readonly lastMessageAt: Date | null;
}

export interface FollowUpRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly kind: string;
  readonly owner: string;
  readonly counterparty: string;
  readonly dueDate: Date | null;
  readonly urgency: string;
  readonly status: string;
  readonly remindAt: Date | null;
  readonly chatId: string;
  readonly chatName: string | null;
  readonly updatedAt: Date;
  /** The handset this follow-up belongs to — what the digest card's link carries. */
  readonly sessionId: string;
}

export interface FollowUpsRepoPort {
  claimChatsForAnalysis(input: {
    quietBefore: Date;
    cooldownBefore: Date;
    limit: number;
  }): Promise<Result<readonly AnalysisCandidate[], InfraError>>;
  transcriptFor(input: {
    chatId: string;
    since: Date;
    limit: number;
  }): Promise<Result<readonly TranscriptMessage[], InfraError>>;
  trackedFor(chatId: string): Promise<Result<readonly TrackedFollowUp[], InfraError>>;
  setFollowUpState(input: {
    companyId: string;
    departmentId: string;
    followUpId: string;
    status?: 'open' | 'resolved' | 'dismissed';
    resolvedReason?: string | null;
    remindAt?: Date | null;
  }): Promise<Result<boolean, InfraError>>;
  applyPlan(input: {
    chatId: string;
    companyId: string;
    departmentId: string;
    create: readonly FollowUpCreate[];
    update: readonly FollowUpUpdate[];
    resolve: readonly FollowUpResolve[];
  }): Promise<Result<void, InfraError>>;
  markAnalyzed(input: {
    chatId: string;
    analyzedThrough: Date | null;
  }): Promise<Result<void, InfraError>>;
  listOpen(scope: {
    companyId: string;
    departmentId: string;
    limit: number;
    sessionId?: string;
  }): Promise<Result<readonly FollowUpRow[], InfraError>>;
  listChats(scope: {
    companyId: string;
    departmentId: string;
    limit: number;
    /**
     * Narrow to one handset's conversations.
     *
     * What the digest card's link carries. A card names one number, and landing
     * in the whole team's list instead of that number's is how a deep link
     * stops being worth following. Still scoped by department underneath, so a
     * session id from elsewhere simply matches nothing.
     */
    sessionId?: string;
  }): Promise<Result<readonly ChatRow[], InfraError>>;
  setChatTracking(input: {
    companyId: string;
    departmentId: string;
    chatId: string;
    muted: boolean;
  }): Promise<Result<boolean, InfraError>>;
  claimDueDigests(input: {
    now: Date;
    claimToken: string;
    limit: number;
  }): Promise<Result<readonly ClaimedDigest[], InfraError>>;
  readDigestWindow(input: {
    companyId: string;
    departmentId: string;
    from: Date;
    to: Date;
  }): Promise<Result<DigestWindow, InfraError>>;
  completeDigest(input: {
    digestId: string;
    claimToken: string;
    coveredThrough: Date;
    nextRunAt: Date | null;
    ranAt: Date;
    cards: readonly { sessionId: string; itemCount: number; cardText: string }[];
  }): Promise<Result<void, InfraError>>;
  releaseDigest(input: {
    digestId: string;
    claimToken: string;
    nextRunAt: Date | null;
  }): Promise<Result<void, InfraError>>;

  listDigests(input: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<readonly DigestRow[], InfraError>>;

  upsertDigest(input: {
    digestId?: string | undefined;
    companyId: string;
    departmentId: string;
    larkChatId: string;
    times: readonly string[];
    days: readonly string[];
    timeZone: string;
    status: string;
    sendOnly: boolean;
    nextRunAt: Date | null;
  }): Promise<Result<DigestRow, InfraError>>;

  recentDigestCards(input: {
    digestId: string;
    limit: number;
  }): Promise<Result<readonly DigestCardRow[], InfraError>>;
}

/** A configured digest, as the settings screen reads it. */
export interface DigestRow {
  readonly id: string;
  readonly larkChatId: string;
  readonly times: readonly string[];
  readonly days: readonly string[];
  readonly timeZone: string;
  readonly status: string;
  /** Whether Divo posts here and does not answer here. */
  readonly sendOnly: boolean;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
}

/** One card a past run posted, for the "did it go out?" list. */
export interface DigestCardRow {
  readonly id: string;
  readonly sessionLabel: string;
  readonly itemCount: number;
  readonly sentAt: Date;
}

export interface ClaimedDigest {
  readonly digestId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly larkChatId: string;
  readonly timesJson: unknown;
  readonly daysJson: unknown;
  readonly timeZone: string;
  readonly coveredThrough: Date | null;
  readonly scheduledFor: Date;
  readonly claimToken: string;
}

/** Everything one digest run needs, read in one place. */
export interface DigestWindow {
  /** Open follow-ups, tagged with the handset that owns their chat. */
  readonly items: readonly (FollowUpRow & { readonly sessionId: string; readonly sessionLabel: string })[];
  /** Linked handsets currently believed dark, for the health card. */
  readonly dark: readonly { readonly label: string; readonly darkSince: Date | null }[];
}

export interface ChatRow {
  readonly id: string;
  readonly name: string | null;
  readonly isGroup: boolean;
  readonly muted: boolean;
  readonly lastMessageAt: Date | null;
  readonly lastAnalyzedAt: Date | null;
  readonly openFollowUps: number;
  /** The handset this chat belongs to. */
  readonly sessionId: string;
}

export class FollowUpsRepository implements FollowUpsRepoPort {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Chats worth spending a model call on.
   *
   * Three gates, and together they are the entire cost model:
   *
   *  - **moved since we read it** — `lastMessageAt > lastAnalyzedMessageAt`.
   *    An unchanged chat is free forever, however often the sweep runs.
   *  - **quiet** — nothing in the last few minutes. Reading a conversation
   *    while people are still typing produces items the next message answers.
   *  - **cooldown** — not analysed recently. This is the hard ceiling: a chat
   *    that receives a thousand messages an hour still costs at most two calls.
   *
   * `analysisEnabled` carries the direct-message policy; `muted` is the team's
   * own switch.
   */
  async claimChatsForAnalysis(input: {
    quietBefore: Date;
    cooldownBefore: Date;
    limit: number;
  }): Promise<Result<readonly AnalysisCandidate[], InfraError>> {
    try {
      const rows = await this.db.whatsappChat.findMany({
        where: {
          analysisEnabled: true,
          muted: false,
          lastMessageAt: { not: null, lte: input.quietBefore },
          OR: [
            { lastAnalyzedMessageAt: null },
            { lastAnalyzedAt: null },
          ],
        },
        // Least-recently-analysed first, never newest-first.
        //
        // Newest-first starves: once the number of active chats exceeds what one
        // sweep can carry, the busiest keep winning every round and a quiet
        // conversation nobody has read can wait indefinitely. Ordering by how
        // long a chat has gone unread is a fair queue — every eligible chat
        // reaches the front eventually, which is the property "nothing is
        // missed" actually requires.
        orderBy: [{ lastAnalyzedAt: { sort: 'asc', nulls: 'first' } }, { lastMessageAt: 'asc' }],
        take: input.limit,
        select: CANDIDATE_SELECT,
      });

      // Prisma cannot compare two columns in a `where`, so the "moved since we
      // read it" and cooldown gates are applied here. The query above still
      // narrows by the parts it can express, and the cap keeps the difference
      // bounded rather than scanning the table.
      const alreadyAnalyzed = await this.db.whatsappChat.findMany({
        where: {
          analysisEnabled: true,
          muted: false,
          lastMessageAt: { not: null, lte: input.quietBefore },
          lastAnalyzedAt: { lte: input.cooldownBefore },
        },
        orderBy: [{ lastAnalyzedAt: { sort: 'asc', nulls: 'first' } }, { lastMessageAt: 'asc' }],
        take: input.limit * 4,
        select: { ...CANDIDATE_SELECT, lastAnalyzedMessageAt: true },
      });

      const moved = alreadyAnalyzed.filter(row =>
        row.lastAnalyzedMessageAt === null
        || (row.lastMessageAt !== null && row.lastMessageAt > row.lastAnalyzedMessageAt));

      const merged = [...rows, ...moved]
        .filter((row, index, all) => all.findIndex(other => other.id === row.id) === index)
        .slice(0, input.limit);

      return ok(merged.map(toCandidate));
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.claimChatsForAnalysis', cause));
    }
  }

  async transcriptFor(input: {
    chatId: string;
    since: Date;
    limit: number;
  }): Promise<Result<readonly TranscriptMessage[], InfraError>> {
    try {
      const rows = await this.db.whatsappMessage.findMany({
        where: { chatId: input.chatId, occurredAt: { gte: input.since } },
        // Newest first to take the most recent N, then reversed: the model reads
        // a conversation forwards, and handing it the tail backwards is the kind
        // of quiet corruption that produces confidently wrong answers.
        orderBy: { occurredAt: 'desc' },
        take: input.limit,
        select: {
          senderName: true, fromMe: true, body: true,
          type: true, quotedText: true, occurredAt: true,
        },
      });
      return ok(rows.reverse());
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.transcriptFor', cause));
    }
  }

  /**
   * What this chat already has on record — open, plus what a person recently
   * closed.
   *
   * The closed ones are the half that is easy to leave out and expensive to.
   * They are invisible to the model otherwise, so it re-spots the same
   * commitment from the same transcript and files it as new: the team's
   * dismissal undone within one sweep, on an id that cannot be traced back to
   * what they cleared.
   *
   * Bounded by `CLOSED_MEMORY_MS` rather than unbounded, because a chat that has
   * been running for a year would otherwise spend most of its prompt listing
   * things nobody has thought about since — and a transcript window that no
   * longer contains the original message cannot re-raise it anyway.
   */
  async trackedFor(chatId: string): Promise<Result<readonly TrackedFollowUp[], InfraError>> {
    try {
      const rows = await this.db.followUp.findMany({
        where: {
          chatId,
          OR: [
            { status: 'open' },
            {
              status: { in: ['resolved', 'dismissed'] },
              updatedAt: { gte: new Date(Date.now() - CLOSED_MEMORY_MS) },
            },
          ],
        },
        select: {
          id: true, title: true, kind: true, owner: true,
          counterparty: true, dueDate: true, status: true,
        },
      });
      return ok(rows.map(row => ({
        id: row.id,
        title: row.title,
        kind: row.kind as TrackedFollowUp['kind'],
        owner: row.owner as TrackedFollowUp['owner'],
        counterparty: row.counterparty,
        dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
        ...(row.status === 'open' ? {} : { closedByTeam: true }),
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.trackedFor', cause));
    }
  }

  /**
   * Done, dismissed, snoozed, or reopened — the four things a person can do to a
   * follow-up.
   *
   * One method rather than four because they are one write with different
   * columns, and splitting them would put the department scoping in four places.
   * Answers `false` for an id outside the caller's department, which is the same
   * answer as one that does not exist: a member of another department must not
   * be able to tell the two apart.
   */
  async setFollowUpState(input: {
    companyId: string;
    departmentId: string;
    followUpId: string;
    status?: 'open' | 'resolved' | 'dismissed';
    resolvedReason?: string | null;
    remindAt?: Date | null;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.followUp.updateMany({
        where: {
          id: input.followUpId,
          companyId: input.companyId,
          departmentId: input.departmentId,
        },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.resolvedReason !== undefined ? { resolvedReason: input.resolvedReason } : {}),
          // Closing an item disarms its nudge. Leaving `remindAt` set on a
          // resolved row means the digest keeps counting it as due, so the item
          // vanishes from the list and still arrives in the group.
          ...(input.status === 'resolved' || input.status === 'dismissed'
            ? { remindAt: null }
            : {}),
          ...(input.remindAt !== undefined ? { remindAt: input.remindAt } : {}),
        },
      });
      return ok(updated.count > 0);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.setFollowUpState', cause));
    }
  }

  /**
   * Write one analysis, all or nothing.
   *
   * A transaction because a half-applied plan is worse than none: resolutions
   * landing without their refreshes would close items the same pass just
   * confirmed are still open.
   */
  async applyPlan(input: {
    chatId: string;
    companyId: string;
    departmentId: string;
    create: readonly FollowUpCreate[];
    update: readonly FollowUpUpdate[];
    resolve: readonly FollowUpResolve[];
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.$transaction(async tx => {
        for (const entry of input.create) {
          await tx.followUp.create({
            data: {
              companyId: input.companyId,
              departmentId: input.departmentId,
              chatId: input.chatId,
              ...itemColumns(entry.item),
              remindAt: entry.remindAt,
              status: 'open',
              source: 'analysis',
            },
          });
        }

        for (const entry of input.update) {
          const existing = await tx.followUp.findUnique({
            where: { id: entry.id },
            select: { remindAt: true, status: true },
          });
          // A resolved item the model still lists stays resolved. Reopening it
          // silently would undo somebody's explicit decision.
          if (!existing || existing.status !== 'open') continue;

          await tx.followUp.update({
            where: { id: entry.id },
            data: {
              ...itemColumns(entry.item),
              // Earlier only. A restated commitment must not postpone a nudge
              // that is already armed, or a busy chat never reminds at all.
              remindAt: existing.remindAt === null
                ? entry.pullRemindAtEarlierTo
                : new Date(Math.min(existing.remindAt.getTime(), entry.pullRemindAtEarlierTo.getTime())),
            },
          });
        }

        for (const entry of input.resolve) {
          await tx.followUp.updateMany({
            where: { id: entry.id, status: 'open' },
            data: { status: 'resolved', resolvedReason: entry.reason, remindAt: null },
          });
        }
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.applyPlan', cause));
    }
  }

  /**
   * Stamp a chat as read, whether or not it produced anything.
   *
   * Stamping even an empty pass is the important half. Without it the chat stays
   * permanently due, gets re-picked on every sweep, and crowds out chats that
   * actually have something in them — a chat with nothing to report would become
   * the most expensive one in the system.
   */
  async markAnalyzed(input: {
    chatId: string;
    analyzedThrough: Date | null;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.whatsappChat.update({
        where: { id: input.chatId },
        data: {
          lastAnalyzedAt: new Date(),
          ...(input.analyzedThrough ? { lastAnalyzedMessageAt: input.analyzedThrough } : {}),
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.markAnalyzed', cause));
    }
  }

  async listOpen(scope: {
    companyId: string;
    departmentId: string;
    limit: number;
    /**
     * Narrow to one handset's conversations.
     *
     * What the digest card's link carries. A card names one number, and landing
     * in the whole team's list instead of that number's is how a deep link
     * stops being worth following. Still scoped by department underneath, so a
     * session id from elsewhere simply matches nothing.
     */
    sessionId?: string;
  }): Promise<Result<readonly FollowUpRow[], InfraError>> {
    try {
      const rows = await this.db.followUp.findMany({
        where: {
          companyId: scope.companyId,
          departmentId: scope.departmentId,
          status: 'open',
          ...(scope.sessionId
            ? { chat: { owningSessionId: scope.sessionId } }
            : {}),
        },
        orderBy: [{ urgency: 'desc' }, { dueDate: 'asc' }, { updatedAt: 'desc' }],
        take: scope.limit,
        select: {
          id: true, title: true, detail: true, kind: true, owner: true,
          counterparty: true, dueDate: true, urgency: true, status: true,
          remindAt: true, chatId: true, updatedAt: true,
          chat: { select: { name: true, owningSessionId: true } },
        },
      });
      return ok(rows.map(row => ({
        id: row.id, title: row.title, detail: row.detail, kind: row.kind,
        owner: row.owner, counterparty: row.counterparty, dueDate: row.dueDate,
        urgency: row.urgency, status: row.status, remindAt: row.remindAt,
        chatId: row.chatId, chatName: row.chat?.name ?? null, updatedAt: row.updatedAt,
        sessionId: row.chat?.owningSessionId ?? '',
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.listOpen', cause));
    }
  }

  /**
   * The chat list the team switches conversations on and off from.
   *
   * Direct messages are analysed like everything else, which makes this list the
   * privacy control rather than a convenience: a blanket groups-only rule could
   * not tell a client thread from a personal one, and a person reading the list
   * can. Muting is per chat and takes effect on the next sweep.
   */
  async listChats(scope: {
    companyId: string;
    departmentId: string;
    limit: number;
    /**
     * Narrow to one handset's conversations.
     *
     * What the digest card's link carries. A card names one number, and landing
     * in the whole team's list instead of that number's is how a deep link
     * stops being worth following. Still scoped by department underneath, so a
     * session id from elsewhere simply matches nothing.
     */
    sessionId?: string;
  }): Promise<Result<readonly ChatRow[], InfraError>> {
    try {
      const rows = await this.db.whatsappChat.findMany({
        where: {
          companyId: scope.companyId,
          departmentId: scope.departmentId,
          ...(scope.sessionId ? { owningSessionId: scope.sessionId } : {}),
        },
        orderBy: { lastMessageAt: 'desc' },
        take: scope.limit,
        select: {
          id: true, name: true, isGroup: true, muted: true,
          lastMessageAt: true, lastAnalyzedAt: true,
          owningSessionId: true,
          _count: { select: { followUps: { where: { status: 'open' } } } },
        },
      });
      return ok(rows.map(row => ({
        id: row.id,
        name: row.name,
        isGroup: row.isGroup,
        muted: row.muted,
        lastMessageAt: row.lastMessageAt,
        lastAnalyzedAt: row.lastAnalyzedAt,
        openFollowUps: row._count.followUps,
        sessionId: row.owningSessionId,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.listChats', cause));
    }
  }

  /**
   * Mute or unmute one chat.
   *
   * Scoped in the `where` rather than checked beforehand: a chat belonging to
   * another department matches nothing, so it is indistinguishable from one that
   * does not exist. `false` here means "not yours or not found", and the route
   * answers 404 to both — which is the only answer that does not confirm the
   * existence of another department's conversation.
   */
  async setChatTracking(input: {
    companyId: string;
    departmentId: string;
    chatId: string;
    muted: boolean;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.whatsappChat.updateMany({
        where: {
          id: input.chatId,
          companyId: input.companyId,
          departmentId: input.departmentId,
        },
        data: { muted: input.muted },
      });
      return ok(updated.count > 0);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.setChatTracking', cause));
    }
  }

  /**
   * Take due digests, one worker at a time.
   *
   * A claim, not a status stamp. `updateMany` with `claimToken: null` in the
   * filter is what makes it safe across replicas: two workers racing the same
   * row means exactly one `count` of 1, and the loser sees nothing rather than
   * sending a second copy of the same digest to the same group.
   *
   * A claim left behind by a worker that died is reaped by `claimedAt` age, the
   * same way `MailBrief` does it.
   */
  async claimDueDigests(input: {
    now: Date;
    claimToken: string;
    limit: number;
  }): Promise<Result<readonly ClaimedDigest[], InfraError>> {
    const staleClaimBefore = new Date(input.now.getTime() - DIGEST_CLAIM_STALE_MS);
    try {
      const due = await this.db.followUpDigest.findMany({
        where: {
          status: 'active',
          nextRunAt: { not: null, lte: input.now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleClaimBefore } }],
        },
        orderBy: { nextRunAt: 'asc' },
        take: input.limit,
        select: { id: true, nextRunAt: true },
      });

      const claimed: ClaimedDigest[] = [];
      for (const row of due) {
        const took = await this.db.followUpDigest.updateMany({
          where: {
            id: row.id,
            status: 'active',
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleClaimBefore } }],
          },
          data: { claimToken: input.claimToken, claimedAt: input.now },
        });
        if (took.count === 0) continue;

        const full = await this.db.followUpDigest.findUnique({
          where: { id: row.id },
          select: {
            id: true, companyId: true, departmentId: true, larkChatId: true,
            timesJson: true, daysJson: true, timeZone: true,
            coveredThrough: true, nextRunAt: true,
          },
        });
        if (!full) continue;
        claimed.push({
          digestId: full.id,
          companyId: full.companyId,
          departmentId: full.departmentId,
          larkChatId: full.larkChatId,
          timesJson: full.timesJson,
          daysJson: full.daysJson,
          timeZone: full.timeZone,
          coveredThrough: full.coveredThrough,
          scheduledFor: row.nextRunAt ?? input.now,
          claimToken: input.claimToken,
        });
      }
      return ok(claimed);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.claimDueDigests', cause));
    }
  }

  /**
   * Everything one digest reports on.
   *
   * Items are read whole rather than by window: a follow-up open for a week is
   * still open today, and a digest that only showed what changed since the last
   * one would quietly stop mentioning the oldest, most-ignored obligations —
   * which are the ones most worth repeating.
   *
   * `from`/`to` still matter for the dark-number half, and for `coveredThrough`
   * to mean something when a run is missed.
   */
  async readDigestWindow(input: {
    companyId: string;
    departmentId: string;
    from: Date;
    to: Date;
  }): Promise<Result<DigestWindow, InfraError>> {
    try {
      const rows = await this.db.followUp.findMany({
        where: {
          companyId: input.companyId,
          departmentId: input.departmentId,
          status: 'open',
        },
        orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
        take: DIGEST_ITEM_CEILING,
        select: {
          id: true, title: true, detail: true, kind: true, owner: true,
          counterparty: true, dueDate: true, urgency: true, status: true,
          remindAt: true, chatId: true, updatedAt: true,
          chat: {
            select: {
              name: true,
              owningSession: { select: { id: true, label: true } },
            },
          },
        },
      });

      const dark = await this.db.whatsappSession.findMany({
        where: {
          companyId: input.companyId,
          departmentId: input.departmentId,
          darkSince: { not: null },
        },
        select: { label: true, darkSince: true },
      });

      return ok({
        items: rows.map(row => ({
          id: row.id, title: row.title, detail: row.detail, kind: row.kind,
          owner: row.owner, counterparty: row.counterparty, dueDate: row.dueDate,
          urgency: row.urgency, status: row.status, remindAt: row.remindAt,
          chatId: row.chatId, chatName: row.chat?.name ?? null, updatedAt: row.updatedAt,
          sessionId: row.chat?.owningSession?.id ?? '',
          sessionLabel: row.chat?.owningSession?.label ?? 'Unknown number',
        })),
        dark,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.readDigestWindow', cause));
    }
  }

  /**
   * Record a delivered digest and move the window forward.
   *
   * `claimToken` is in the filter, not just the data. A run whose claim went
   * stale and was taken by another worker must not overwrite the newer worker's
   * result on its way out.
   */
  async completeDigest(input: {
    digestId: string;
    claimToken: string;
    coveredThrough: Date;
    nextRunAt: Date | null;
    ranAt: Date;
    cards: readonly { sessionId: string; itemCount: number; cardText: string }[];
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.$transaction(async tx => {
        const released = await tx.followUpDigest.updateMany({
          where: { id: input.digestId, claimToken: input.claimToken },
          data: {
            coveredThrough: input.coveredThrough,
            lastRunAt: input.ranAt,
            nextRunAt: input.nextRunAt,
            claimToken: null,
            claimedAt: null,
          },
        });
        if (released.count === 0) return;

        for (const card of input.cards) {
          await tx.followUpDigestCard.create({
            data: {
              digestId: input.digestId,
              sessionId: card.sessionId,
              itemCount: card.itemCount,
              cardText: card.cardText,
            },
          });
        }
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.completeDigest', cause));
    }
  }

  /**
   * Let a failed run go, without moving the window.
   *
   * `coveredThrough` is deliberately untouched: whatever the failed run would
   * have reported folds into the next one instead of being lost, and a gap is
   * exactly when somebody most needs telling.
   */
  async releaseDigest(input: {
    digestId: string;
    claimToken: string;
    nextRunAt: Date | null;
  }): Promise<Result<void, InfraError>> {
    try {
      await this.db.followUpDigest.updateMany({
        where: { id: input.digestId, claimToken: input.claimToken },
        data: { nextRunAt: input.nextRunAt, claimToken: null, claimedAt: null },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.releaseDigest', cause));
    }
  }
  /**
   * Every digest configured for one department.
   *
   * A list rather than a single row because the unique key is
   * `[companyId, departmentId, larkChatId]` — the schema permits a department
   * to report into more than one room. Nothing creates a second one today, and
   * the settings screen models one; returning the list lets the caller say so
   * out loud instead of picking one of two and appearing to lose the other.
   */
  async listDigests(input: {
    companyId: string;
    departmentId: string;
  }): Promise<Result<readonly DigestRow[], InfraError>> {
    try {
      const rows = await this.db.followUpDigest.findMany({
        where: { companyId: input.companyId, departmentId: input.departmentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, larkChatId: true, timesJson: true, daysJson: true,
          timeZone: true, status: true, sendOnly: true, nextRunAt: true, lastRunAt: true,
        },
      });
      return ok(rows.map(row => ({
        id: row.id,
        larkChatId: row.larkChatId,
        /*
         * Read defensively. These are `Json` columns, so the database will
         * hand back whatever was written — including, for a row somebody
         * edited by hand, something that is not an array of strings at all.
         * The runner already refuses to guess at an unreadable schedule; the
         * screen should show an empty field rather than throw on the way in.
         */
        times: Array.isArray(row.timesJson) ? row.timesJson.filter((t): t is string => typeof t === 'string') : [],
        days: Array.isArray(row.daysJson) ? row.daysJson.filter((d): d is string => typeof d === 'string') : [],
        timeZone: row.timeZone,
        status: row.status,
        sendOnly: row.sendOnly,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.listDigests', cause));
    }
  }

  /**
   * Create the department's digest, or move it.
   *
   * Keyed on `digestId` when one is already configured, so changing the room
   * edits the row that exists rather than leaving the old one behind still
   * posting on its own schedule — which the composite unique key would happily
   * allow, and which nobody would notice until two digests arrived.
   *
   * `coveredThrough` is deliberately untouched on an edit. It is how far the
   * last delivered digest reported to, and a schedule change is not a reason to
   * re-report a week nobody asked for, nor to skip one.
   */
  async upsertDigest(input: {
    digestId?: string | undefined;
    companyId: string;
    departmentId: string;
    larkChatId: string;
    times: readonly string[];
    days: readonly string[];
    timeZone: string;
    status: string;
    sendOnly: boolean;
    nextRunAt: Date | null;
  }): Promise<Result<DigestRow, InfraError>> {
    const data = {
      larkChatId: input.larkChatId,
      timesJson: [...input.times] as unknown as Prisma.InputJsonValue,
      daysJson: [...input.days] as unknown as Prisma.InputJsonValue,
      timeZone: input.timeZone,
      status: input.status,
      sendOnly: input.sendOnly,
      nextRunAt: input.nextRunAt,
    };
    try {
      const row = input.digestId
        ? await this.db.followUpDigest.update({
          where: { id: input.digestId },
          data,
          select: {
            id: true, larkChatId: true, timesJson: true, daysJson: true,
            timeZone: true, status: true, sendOnly: true, nextRunAt: true, lastRunAt: true,
          },
        })
        : await this.db.followUpDigest.create({
          data: { companyId: input.companyId, departmentId: input.departmentId, ...data },
          select: {
            id: true, larkChatId: true, timesJson: true, daysJson: true,
            timeZone: true, status: true, sendOnly: true, nextRunAt: true, lastRunAt: true,
          },
        });
      return ok({
        id: row.id,
        larkChatId: row.larkChatId,
        times: Array.isArray(row.timesJson) ? row.timesJson.filter((t): t is string => typeof t === 'string') : [],
        days: Array.isArray(row.daysJson) ? row.daysJson.filter((d): d is string => typeof d === 'string') : [],
        timeZone: row.timeZone,
        status: row.status,
        sendOnly: row.sendOnly,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.upsertDigest', cause));
    }
  }

  /**
   * What the last few runs actually posted.
   *
   * The half of the screen that answers "did the nine o'clock one go out?",
   * which is the question a schedule alone cannot answer — and the one people
   * open this page for after a quiet morning.
   */
  async recentDigestCards(input: {
    digestId: string;
    limit: number;
  }): Promise<Result<readonly DigestCardRow[], InfraError>> {
    try {
      const rows = await this.db.followUpDigestCard.findMany({
        where: { digestId: input.digestId },
        orderBy: { sentAt: 'desc' },
        take: input.limit,
        select: {
          id: true, itemCount: true, sentAt: true,
          session: { select: { label: true } },
        },
      });
      return ok(rows.map(row => ({
        id: row.id,
        sessionLabel: row.session.label,
        itemCount: row.itemCount,
        sentAt: row.sentAt,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'followUps.recentDigestCards', cause));
    }
  }

}

/** A claim older than this belonged to a worker that is not coming back. */
const DIGEST_CLAIM_STALE_MS = 10 * 60_000;

/**
 * Hard ceiling on rows one digest reads.
 *
 * Far above what any card shows. It exists so a department with a thousand open
 * items cannot turn a twice-daily job into a table scan; the per-card cap and
 * its "and N more" line handle what a person actually sees.
 */
const DIGEST_ITEM_CEILING = 500;

/**
 * How far back a closed follow-up is still worth showing the model.
 *
 * Two weeks. Long enough to cover the transcript window several times over, so
 * anything still quotable in the conversation is still remembered as closed;
 * short enough that a chat running for a year does not spend most of its prompt
 * on decisions nobody has thought about since.
 */
const CLOSED_MEMORY_MS = 14 * 24 * 60 * 60_000;

const CANDIDATE_SELECT = {
  id: true,
  companyId: true,
  departmentId: true,
  name: true,
  isGroup: true,
  lastMessageAt: true,
} as const;

const toCandidate = (row: {
  id: string; companyId: string; departmentId: string;
  name: string | null; isGroup: boolean; lastMessageAt: Date | null;
}): AnalysisCandidate => ({
  chatId: row.id,
  companyId: row.companyId,
  departmentId: row.departmentId,
  chatName: row.name,
  isGroup: row.isGroup,
  lastMessageAt: row.lastMessageAt,
});

const itemColumns = (item: FollowUpCreate['item']) => ({
  title: item.title,
  detail: item.detail,
  kind: item.kind,
  owner: item.owner,
  counterparty: item.counterparty,
  dueDate: item.dueDate ? new Date(`${item.dueDate}T09:00:00Z`) : null,
  urgency: item.urgency,
  confidence: item.confidence,
  evidenceJson: item.evidence as unknown as Prisma.InputJsonValue,
  suggestedReply: item.suggestedReply,
});
