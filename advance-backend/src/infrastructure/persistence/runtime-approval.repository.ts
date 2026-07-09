import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra } from '../../shared/errors';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';

export interface RuntimeApprovalRow {
  id:                  string;
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
  idempotencyKey:      string | null;
  decisionMessageId:   string | null;
  resolutionReason:    string | null;
  createdAt:           Date;
  updatedAt:           Date;
}

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
}

export class RuntimeApprovalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create a RuntimeApproval, transparently upserting the required
   * RuntimeConversation + RuntimeRun stub records first.
   */
  async create(input: CreateApprovalInput): Promise<Result<RuntimeApprovalRow, Error>> {
    try {
      // Upsert a RuntimeConversation keyed by (companyId, channel, chatId)
      const conversation = await this.prisma.runtimeConversation.upsert({
        where: {
          companyId_channel_channelConversationKey: {
            companyId:                input.companyId,
            channel:                  input.channel,
            channelConversationKey:   input.chatId,
          },
        },
        create: {
          companyId:                input.companyId,
          channel:                  input.channel,
          channelConversationKey:   input.chatId,
          rawChannelKey:            input.chatId,
          status:                   'active',
        },
        update: { updatedAt: new Date() },
      });

      // Create a lightweight RuntimeRun linked to the conversation
      const run = await this.prisma.runtimeRun.create({
        data: {
          conversationId: conversation.id,
          channel:        input.channel,
          entrypoint:     'hitl_approval',
          engine:         'advance',
          engineMode:     'hitl',
          status:         'running',
        },
      });

      const row = await this.prisma.runtimeApproval.create({
        data: {
          conversationId:  conversation.id,
          runId:           run.id,
          toolId:          input.toolId,
          actionGroup:     input.actionGroup,
          kind:            input.kind,
          summary:         input.summary,
          payloadJson:     input.payloadJson as any,
          metadataJson:    input.metadataJson as any,
          channel:         input.channel,
          requestedBy:     input.requestedBy ?? null,
          idempotencyKey:  input.idempotencyKey,
          expiresAt:       input.expiresAt,
          status:          'pending',
        },
      });
      return ok(row as unknown as RuntimeApprovalRow);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.create', e));
    }
  }

  async findById(id: string): Promise<Result<RuntimeApprovalRow | null, Error>> {
    try {
      const row = await this.prisma.runtimeApproval.findUnique({ where: { id } });
      return ok(row as unknown as RuntimeApprovalRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.findById', e));
    }
  }

  async findActiveByIdempotencyKey(key: string): Promise<Result<RuntimeApprovalRow | null, Error>> {
    try {
      const row = await this.prisma.runtimeApproval.findFirst({
        where: {
          idempotencyKey: key,
          status: { in: ['pending', 'approved', 'rejected'] },
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      return ok(row as unknown as RuntimeApprovalRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.findActiveByIdempotencyKey', e));
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
        this.prisma.runtimeApproval.findMany({ where: { id } }),
      ]);

      if (count.count === 0) {
        return ok(null);
      }
      return ok((rows[0] ?? null) as unknown as RuntimeApprovalRow | null);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.claimApprovedExecution', e));
    }
  }

  async completeApprovedExecution(id: string, resultJson: unknown): Promise<Result<void, Error>> {
    try {
      await this.prisma.runtimeApproval.updateMany({
        where: { id, status: { in: ['approved', 'executing'] } },
        data: {
          status: 'consumed',
          executionResultJson: resultJson as any,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.completeApprovedExecution', e));
    }
  }

  async failApprovedExecution(id: string, resultJson: unknown): Promise<Result<void, Error>> {
    try {
      await this.prisma.runtimeApproval.updateMany({
        where: { id, status: { in: ['approved', 'executing'] } },
        data: {
          status: 'failed',
          executionResultJson: resultJson as any,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.failApprovedExecution', e));
    }
  }

  async setDecisionMessageId(id: string, decisionMessageId: string): Promise<Result<void, Error>> {
    try {
      await this.prisma.runtimeApproval.update({
        where: { id },
        data:  { decisionMessageId },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'runtime-approval.setDecisionMessageId', e));
    }
  }

  /**
   * Atomically transition pending → approved|rejected.
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
            status: 'pending',
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
}
