import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra } from '../../shared/errors';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';

export interface RuntimeApprovalRow {
  id:                  string;
  /** Authoritative company from the owning RuntimeConversation, when loaded by ID. */
  companyId?:           string;
  conversationId:      string;
  runId:               string;
  toolId:              string;
  actionGroup:         string;
  kind:                string;
  summary:             string;
  payloadJson:         unknown;
  metadataJson:        unknown;
  status:              string;
  channel:             string;
  requestedBy:         string | null;
  approvedBy:          string | null;
  approvedAt:          Date | null;
  rejectedAt:          Date | null;
  expiresAt:           Date | null;
  executionResultJson: unknown;
  /** What the person said, when the request asked more than yes/no. */
  responseJson:        unknown;
  idempotencyKey:      string | null;
  decisionMessageId:   string | null;
  resolutionReason:    string | null;
  createdAt:           Date;
  updatedAt:           Date;
}

const LINKED_DECISION_KINDS = ['business_action', 'knowledge_skill_review'] as const;

export interface CreateApprovalInput {
  /** Lark chat ID (used to upsert RuntimeConversation). */
  chatId:           string;
  companyId:        string;
  toolId:           string;
  actionGroup:      ToolActionGroup;
  kind:             string;
  summary:          string;
  payloadJson:      unknown;
  metadataJson:     unknown;
  channel:          string;
  requestedBy?:     string;
  idempotencyKey:   string;
  expiresAt:        Date;
  /** Requester confirmations are already visible in Divo and need no delivery handshake. */
  initialStatus?:   'dispatching' | 'pending';
}

export interface CreateOrReuseApprovalResult {
  readonly approval: RuntimeApprovalRow;
  readonly created: boolean;
  readonly replacedExpired: boolean;
}

export interface CreateOrReuseApprovalOptions {
  /**
   * Previous idempotency namespaces accepted during a rolling upgrade.
   * Callers must provide an exact metadata validator; a key match alone is
   * never enough to reuse authority from an older approval contract.
   */
  readonly compatibleIdempotencyKeys?: readonly string[];
  readonly isCompatibleApproval?: (approval: RuntimeApprovalRow) => boolean;
}

export interface LinkedDecisionTerminalOutcome {
  readonly parentDecisionId: string;
  readonly approvalId: string;
  readonly status: 'completed' | 'rejected' | 'failed';
  readonly result: unknown;
}

export class RuntimeApprovalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Terminal authority rows whose requester-owned skill Decision still needs
   * closing. The authority row is the durable retry source; no cache or user
   * command is required to recover the linked lifecycle.
   */
  async listPendingLinkedSkillOutcomes(limit = 100): Promise<LinkedDecisionTerminalOutcome[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      parentDecisionId: string;
      approvalId: string;
      status: string;
      result: unknown;
      expired: boolean;
    }>>`
      SELECT
        authority."metadataJson"->>'parentDecisionId' AS "parentDecisionId",
        authority."id" AS "approvalId",
        authority."status" AS "status",
        authority."executionResultJson" AS "result",
        (authority."expiresAt" <= CURRENT_TIMESTAMP) AS "expired"
      FROM "RuntimeApproval" AS authority
      INNER JOIN "RuntimeApproval" AS parent
        ON parent."id" = authority."metadataJson"->>'parentDecisionId'
      WHERE (
          authority."status" IN ('consumed', 'rejected', 'failed')
          OR (
            authority."status" IN ('dispatching', 'pending')
            AND authority."expiresAt" <= CURRENT_TIMESTAMP
          )
        )
        AND parent."kind" = 'knowledge_skill_review'
        AND parent."status" IN ('executing', 'awaiting_governance')
      ORDER BY authority."updatedAt" ASC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;
    return rows.flatMap(row => {
      const status = row.status === 'consumed' ? 'completed'
        : row.status === 'rejected' ? 'rejected'
          : row.status === 'failed' || row.expired ? 'failed'
            : null;
      return status ? [{
        parentDecisionId: row.parentDecisionId,
        approvalId: row.approvalId,
        status,
        result: row.result ?? { status: row.expired ? 'approval_expired' : row.status },
      }] : [];
    });
  }

  /**
   * Create a RuntimeApproval, transparently upserting the required
   * RuntimeConversation + RuntimeRun stub records first.
   */
  async create(input: CreateApprovalInput): Promise<Result<RuntimeApprovalRow, Error>> {
    try {
      const row = await this.prisma.$transaction(tx => this.createWithinTransaction(tx, input));
      return ok(row as unknown as RuntimeApprovalRow);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.create', e));
    }
  }

  /**
   * Atomically reuse one live approval or create its replacement.
   *
   * The transaction-scoped PostgreSQL advisory lock closes the race between
   * `findActiveByIdempotencyKey` and `create` across backend processes. Hash
   * collisions can only serialize unrelated approvals; they cannot authorize
   * or merge them because the exact key is still queried after the lock.
   */
  async createOrReuseActive(
    input: CreateApprovalInput,
    options: CreateOrReuseApprovalOptions = {},
  ): Promise<Result<CreateOrReuseApprovalResult, Error>> {
    try {
      const value = await this.prisma.$transaction(async tx => {
        const compatibilityKeys = [...new Set(
          (options.compatibleIdempotencyKeys ?? [])
            .filter(key => key.length > 0 && key !== input.idempotencyKey),
        )].sort();
        const lockKeys = [input.idempotencyKey, ...compatibilityKeys].sort();
        for (const key of lockKeys) {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext('runtime-approval'),
              hashtext(${key})
            )::text AS lock_result
          `;
        }

        const now = new Date();
        let existing = await this.findActiveWithinTransaction(tx, input.idempotencyKey, now);
        if (existing && isRecoverableDeliveryFailure(existing)) {
          await this.retireRecoverableDeliveryFailure(tx, existing);
          existing = await this.findActiveWithinTransaction(tx, input.idempotencyKey, now);
        }
        if (existing) {
          return {
            approval: existing as unknown as RuntimeApprovalRow,
            created: false,
            replacedExpired: false,
          };
        }

        if (options.isCompatibleApproval) {
          for (const key of compatibilityKeys) {
            let compatible = await this.findCompatibleActiveWithinTransaction(
              tx,
              key,
              now,
              options.isCompatibleApproval,
            );
            if (compatible && isRecoverableDeliveryFailure(compatible)) {
              await this.retireRecoverableDeliveryFailure(tx, compatible);
              compatible = await this.findCompatibleActiveWithinTransaction(
                tx,
                key,
                now,
                options.isCompatibleApproval,
              );
            }
            if (compatible) {
              return {
                approval: compatible as unknown as RuntimeApprovalRow,
                created: false,
                replacedExpired: false,
              };
            }
          }
        }

        const expiredCandidates = await tx.runtimeApproval.findMany({
          where: {
            idempotencyKey: { in: [input.idempotencyKey, ...compatibilityKeys] },
            // Approval TTL governs the human decision window only. Once an
            // exact action starts, its execution/replay record must remain
            // authoritative so the same mutation cannot be approved twice.
            status: { in: ['dispatching', 'pending', 'approved', 'rejected'] },
            expiresAt: { lte: now },
          },
          orderBy: { createdAt: 'desc' },
        });
        const approval = await this.createWithinTransaction(tx, input);
        return {
          approval: approval as unknown as RuntimeApprovalRow,
          created: true,
          replacedExpired: expiredCandidates.some(expired =>
            expired.idempotencyKey === input.idempotencyKey
            || Boolean(options.isCompatibleApproval?.(expired as unknown as RuntimeApprovalRow))),
        };
      });
      return ok(value);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.createOrReuseActive', e));
    }
  }

  async findById(id: string): Promise<Result<RuntimeApprovalRow | null, Error>> {
    try {
      const row = await this.prisma.runtimeApproval.findUnique({
        where: { id },
        include: {
          conversation: {
            select: { companyId: true },
          },
        },
      });
      if (!row) return ok(null);
      const { conversation, ...approval } = row;
      return ok({
        ...approval,
        companyId: conversation.companyId,
      } as unknown as RuntimeApprovalRow);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.findById', e));
    }
  }

  /**
   * Live requests a person is on the hook for, and the ones they are waiting on.
   *
   * `dispatching` counts as live for the same reason the Lark card handler
   * accepts it: a row can be delivered before its message ID is persisted, and
   * the request is genuinely outstanding either way.
   */
  async listInboxFor(input: {
    companyId: string;
    userId: string;
    limit?: number;
  }): Promise<Result<{ awaitingMe: RuntimeApprovalRow[]; requestedByMe: RuntimeApprovalRow[] }, Error>> {
    try {
      const now = new Date();
      const live = {
        status: { in: ['dispatching', 'pending'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        conversation: { companyId: input.companyId },
      } satisfies Prisma.RuntimeApprovalWhereInput;
      const take = input.limit ?? 50;
      const include = { conversation: { select: { companyId: true } } } as const;

      const [awaiting, requested] = await this.prisma.$transaction([
        this.prisma.runtimeApproval.findMany({
          where: {
            ...live,
            metadataJson: { path: ['resolvedManagerUserId'], equals: input.userId },
          },
          orderBy: { createdAt: 'desc' },
          take,
          include,
        }),
        this.prisma.runtimeApproval.findMany({
          where: { ...live, requestedBy: input.userId },
          orderBy: { createdAt: 'desc' },
          take,
          include,
        }),
      ]);

      const shape = (rows: typeof awaiting): RuntimeApprovalRow[] => rows.map(row => {
        const { conversation, ...approval } = row;
        return { ...approval, companyId: conversation.companyId } as unknown as RuntimeApprovalRow;
      });
      return ok({ awaitingMe: shape(awaiting), requestedByMe: shape(requested) });
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.listInboxFor', e));
    }
  }

  async findActiveByIdempotencyKey(key: string): Promise<Result<RuntimeApprovalRow | null, Error>> {
    try {
      const row = await this.findActiveWithinTransaction(this.prisma, key, new Date());
      return ok(row as unknown as RuntimeApprovalRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.findActiveByIdempotencyKey', e));
    }
  }

  /**
   * Close an ask nobody needs answered any more.
   *
   * Distinct from `markFailed`, which says the request broke. A withdrawn ask
   * succeeded and was then made moot by something else: the Connect card whose
   * OAuth completed in a browser tab is the case this exists for, and calling
   * that "failed" would be a lie told to whoever reads the row later.
   *
   * `withdrawn` is outside both the inbox filter (`dispatching`/`pending`) and
   * the exactly-once durable set (`executing`/`awaiting_governance`/
   * `consumed`), so a withdrawn row disappears from the reader's screen without
   * standing in for a completed action.
   *
   * Scoped to still-open rows so this can never overwrite a real answer that
   * landed first.
   */
  async withdrawByIdempotencyKey(
    idempotencyKey: string,
    reason: string,
  ): Promise<Result<number, Error>> {
    try {
      const updated = await this.prisma.runtimeApproval.updateMany({
        where: {
          idempotencyKey,
          status: { in: ['dispatching', 'pending'] },
        },
        data: {
          status: 'withdrawn',
          resolutionReason: reason,
        },
      });
      return ok(updated.count);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.withdrawByIdempotencyKey', e));
    }
  }

  async markFailed(id: string, reason: string): Promise<Result<void, Error>> {
    try {
      await this.prisma.runtimeApproval.update({
        where: { id },
        data: {
          status: 'failed',
          resolutionReason: reason,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.markFailed', e));
    }
  }

  async claimApprovedExecution(id: string, requestedBy: string): Promise<Result<RuntimeApprovalRow | null, Error>> {
    try {
      const now = new Date();
      const [count, rows] = await this.prisma.$transaction([
        this.prisma.runtimeApproval.updateMany({
          where: {
            id,
            requestedBy,
            status: 'approved',
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          data: { status: 'executing' },
        }),
        this.prisma.runtimeApproval.findMany({
          where: { id },
          include: {
            conversation: {
              select: { companyId: true },
            },
          },
        }),
      ]);

      if (count.count === 0) {
        return ok(null);
      }
      const row = rows[0];
      if (!row) return ok(null);
      const { conversation, ...approval } = row;
      return ok({
        ...approval,
        companyId: conversation.companyId,
      } as unknown as RuntimeApprovalRow);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.claimApprovedExecution', e));
    }
  }

  /**
   * Return a claimed approval to its already-human-approved state when a
   * guaranteed-no-side-effect check fails before tool code starts.
   */
  async releaseApprovedExecution(id: string): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: 'executing' },
        data: { status: 'approved' },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.releaseApprovedExecution', e));
    }
  }

  async completeApprovedExecution(id: string, resultJson: unknown): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: { in: ['approved', 'executing'] } },
        data: {
          status: 'consumed',
          executionResultJson: resultJson as any,
        },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.completeApprovedExecution', e));
    }
  }

  /**
   * The requester has confirmed the exact action, but company policy now owns
   * the next decision. The action remains a durable replay barrier while its
   * linked governance approval is pending.
   */
  async markAwaitingGovernance(id: string, resultJson: unknown): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: 'executing', kind: { in: [...LINKED_DECISION_KINDS] } },
        data: {
          status: 'awaiting_governance',
          executionResultJson: resultJson as any,
        },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.markAwaitingGovernance', e));
    }
  }

  /** Finish a requester-owned Decision after its linked authority decision runs. */
  async completeLinkedDecision(id: string, resultJson: unknown): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: 'awaiting_governance', kind: { in: [...LINKED_DECISION_KINDS] } },
        data: {
          status: 'consumed',
          executionResultJson: resultJson as any,
        },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.completeLinkedDecision', e));
    }
  }

  /** Reject or fail a requester-owned action whose governance decision ended it. */
  async failLinkedDecision(
    id: string,
    status: 'rejected' | 'failed',
    resultJson: unknown,
  ): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: 'awaiting_governance', kind: { in: [...LINKED_DECISION_KINDS] } },
        data: {
          status,
          executionResultJson: resultJson as any,
        },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.failLinkedDecision', e));
    }
  }

  /**
   * Stores a durable checkpoint while an approved multi-call batch is running.
   * This deliberately cannot change a pending/approved record, so a progress
   * write can never manufacture an execution grant.
   */
  async persistExecutingResult(id: string, resultJson: unknown): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: 'executing' },
        data: { executionResultJson: resultJson as any },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.persistExecutingResult', e));
    }
  }

  async failApprovedExecution(id: string, resultJson: unknown): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: { in: ['approved', 'executing'] } },
        data: {
          status: 'failed',
          executionResultJson: resultJson as any,
        },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.failApprovedExecution', e));
    }
  }

  async setDecisionMessageId(id: string, decisionMessageId: string): Promise<Result<void, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: { in: ['dispatching', 'pending'] } },
        data:  { decisionMessageId, status: 'pending' },
      });
      if (changed.count !== 1) {
        return err(new Error('Approval delivery state changed before its decision message could be stored.'));
      }
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.setDecisionMessageId', e));
    }
  }

  /**
   * Atomically transition a delivered or delivery-unconfirmed request to its
   * human decision. A card contains the approval ID itself, so losing only
   * the editable message ID must not make a successfully delivered card inert.
   * Returns the updated row, or null if already resolved.
   */
  async atomicResolve(
    id:         string,
    decision:   'approved' | 'rejected',
    resolvedBy: string,
    reason?:    string,
  ): Promise<Result<RuntimeApprovalRow | null, Error>> {
    try {
      const now = new Date();
      const updateData =
        decision === 'approved'
          ? { status: 'approved', approvedBy: resolvedBy, approvedAt: now, resolutionReason: reason ?? null }
          : { status: 'rejected', approvedBy: resolvedBy, rejectedAt: now, resolutionReason: reason ?? null };

      const [count, rows] = await this.prisma.$transaction([
        this.prisma.runtimeApproval.updateMany({
          where: {
            id,
            status: { in: ['dispatching', 'pending'] },
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          data:  updateData,
        }),
        this.prisma.runtimeApproval.findMany({ where: { id } }),
      ]);

      if (count.count === 0) {
        return ok(null);
      }
      return ok((rows[0] ?? null) as unknown as RuntimeApprovalRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.atomicResolve', e));
    }
  }

  /**
   * Store what the person said, once the decision is already settled.
   *
   * Separate from `atomicResolve` because the verdict is the part that has to
   * be atomic — it is what stops a card and a browser both closing the same
   * request — and the transcript is not. Writing them together would put a
   * whole answer inside the lock that exists to serialize one status change.
   */
  async persistAnswer(id: string, responseJson: unknown): Promise<Result<void, Error>> {
    try {
      await this.prisma.runtimeApproval.update({
        where: { id },
        data:  { responseJson: responseJson as any },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.persistAnswer', e));
    }
  }

  /**
   * Store a part-finished answer, and only while the request is still open.
   *
   * The guard is the whole difference from `persistAnswer` above, which runs
   * after the verdict is already durable and must therefore write to a resolved
   * row. This one runs before any verdict exists, and two surfaces can be
   * holding the same request: a card press that loaded a moment before a
   * browser settled it would otherwise land its half-answer on top of a
   * finished decision, leaving a transcript that contradicts the verdict beside
   * it. Answers false when the row has moved on, which the caller reports as
   * "answered somewhere else".
   */
  async persistPartialAnswer(id: string, responseJson: unknown): Promise<Result<boolean, Error>> {
    try {
      const changed = await this.prisma.runtimeApproval.updateMany({
        where: { id, status: { in: ['dispatching', 'pending'] } },
        data:  { responseJson: responseJson as any },
      });
      return ok(changed.count === 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.persistPartialAnswer', e));
    }
  }

  async persistResult(id: string, resultJson: unknown): Promise<Result<void, Error>> {
    try {
      await this.prisma.runtimeApproval.update({
        where: { id },
        data:  { executionResultJson: resultJson as any },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.persistResult', e));
    }
  }

  private async findActiveWithinTransaction(
    client: Pick<Prisma.TransactionClient, 'runtimeApproval'>,
    key: string,
    now: Date,
  ) {
    // Durable execution state wins even if an older deployment already
    // created a newer pending duplicate after TTL expiry. This lets rollout
    // heal toward exactly-once behavior instead of trusting the newest row.
    const durable = await client.runtimeApproval.findFirst({
      where: {
        idempotencyKey: key,
        status: { in: ['executing', 'awaiting_governance', 'consumed'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (durable) return durable;

    // Any claimed mutation that failed may still have reached its provider.
    // Its stored execution result therefore remains a durable uncertainty
    // barrier: the identical action must be revised, not approved again.
    // Card-delivery failures have no execution result and remain retryable.
    const failedExecution = await client.runtimeApproval.findFirst({
      where: {
        idempotencyKey: key,
        status: 'failed',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (failedExecution && isFailedExecutionBarrier(failedExecution)) return failedExecution;

    return client.runtimeApproval.findFirst({
      where: {
        idempotencyKey: key,
        status: { in: ['dispatching', 'pending', 'approved', 'rejected'] },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find an active row from an older idempotency namespace without allowing a
   * newer row for another requester or authority to hide the compatible one.
   * Rolling-upgrade namespaces were historically broader than the current
   * key, so every candidate must pass the caller's exact metadata validator.
   */
  private async findCompatibleActiveWithinTransaction(
    client: Pick<Prisma.TransactionClient, 'runtimeApproval'>,
    key: string,
    now: Date,
    isCompatible: (approval: RuntimeApprovalRow) => boolean,
  ) {
    const firstCompatible = <T>(rows: T[]): T | undefined =>
      rows.find(row => isCompatible(row as unknown as RuntimeApprovalRow));

    const durable = await client.runtimeApproval.findMany({
      where: {
        idempotencyKey: key,
        status: { in: ['executing', 'awaiting_governance', 'consumed'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const compatibleDurable = firstCompatible(durable);
    if (compatibleDurable) return compatibleDurable;

    const failed = await client.runtimeApproval.findMany({
      where: {
        idempotencyKey: key,
        status: 'failed',
      },
      orderBy: { createdAt: 'desc' },
    });
    const compatibleFailed = firstCompatible(failed.filter(isFailedExecutionBarrier));
    if (compatibleFailed) return compatibleFailed;

    const live = await client.runtimeApproval.findMany({
      where: {
        idempotencyKey: key,
        status: { in: ['dispatching', 'pending', 'approved', 'rejected'] },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    return firstCompatible(live) ?? null;
  }

  private async retireRecoverableDeliveryFailure(
    tx: Prisma.TransactionClient,
    approval: { id: string; status: string },
  ): Promise<void> {
    await tx.runtimeApproval.updateMany({
      where: {
        id: approval.id,
        status: 'dispatching',
      },
      data: {
        status: 'failed',
        resolutionReason: 'card_send_failed:definite_non_delivery',
      },
    });
  }

  private async createWithinTransaction(
    tx: Prisma.TransactionClient,
    input: CreateApprovalInput,
  ) {
    const conversation = await tx.runtimeConversation.upsert({
      where: {
        companyId_channel_channelConversationKey: {
          companyId: input.companyId,
          channel: input.channel,
          channelConversationKey: input.chatId,
        },
      },
      create: {
        companyId: input.companyId,
        channel: input.channel,
        channelConversationKey: input.chatId,
        rawChannelKey: input.chatId,
        status: 'active',
      },
      update: { updatedAt: new Date() },
    });

    const run = await tx.runtimeRun.create({
      data: {
        conversationId: conversation.id,
        channel: input.channel,
        entrypoint: 'hitl_approval',
        engine: 'advance',
        engineMode: 'hitl',
        status: 'running',
      },
    });

    return tx.runtimeApproval.create({
      data: {
        conversationId: conversation.id,
        runId: run.id,
        toolId: input.toolId,
        actionGroup: input.actionGroup,
        kind: input.kind,
        summary: input.summary,
        payloadJson: input.payloadJson as Prisma.InputJsonValue,
        metadataJson: input.metadataJson as Prisma.InputJsonValue,
        channel: input.channel,
        requestedBy: input.requestedBy ?? null,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
        status: input.initialStatus ?? 'dispatching',
      },
    });
  }
}

function isRecoverableDeliveryFailure(approval: {
  status: string;
  executionResultJson: unknown;
}): boolean {
  if (approval.status !== 'dispatching') return false;
  const result = asRecord(approval.executionResultJson);
  return result?.['status'] === 'approval_delivery_failed';
}

function isFailedExecutionBarrier(approval: {
  executionResultJson: unknown;
}): boolean {
  if (approval.executionResultJson === null) return false;
  const result = asRecord(approval.executionResultJson);
  return result?.['status'] !== 'approval_delivery_failed';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
