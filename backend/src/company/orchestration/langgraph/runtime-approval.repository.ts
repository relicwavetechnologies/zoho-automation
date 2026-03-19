import { Prisma, type RuntimeApproval } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';
import type { RuntimeApprovalStatus, RuntimeChannel } from './runtime.types';

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

export class RuntimeApprovalRepository {
  create(input: {
    conversationId: string;
    runId: string;
    externalActionId?: string | null;
    toolId: string;
    actionGroup: string;
    kind: string;
    summary: string;
    subject?: string | null;
    payloadJson: Record<string, unknown>;
    metadataJson?: Record<string, unknown> | null;
    riskLevel?: string | null;
    channel: RuntimeChannel;
    requestedBy?: string | null;
    expiresAt?: Date | null;
    idempotencyKey?: string | null;
    decisionMessageId?: string | null;
  }): Promise<RuntimeApproval> {
    return prisma.runtimeApproval.create({
      data: {
        conversationId: input.conversationId,
        runId: input.runId,
        externalActionId: input.externalActionId ?? null,
        toolId: input.toolId,
        actionGroup: input.actionGroup,
        kind: input.kind,
        summary: input.summary,
        subject: input.subject ?? null,
        payloadJson: toJsonValue(input.payloadJson),
        metadataJson: input.metadataJson ? toJsonValue(input.metadataJson) : undefined,
        riskLevel: input.riskLevel ?? null,
        channel: input.channel,
        requestedBy: input.requestedBy ?? null,
        expiresAt: input.expiresAt ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        decisionMessageId: input.decisionMessageId ?? null,
      },
    });
  }

  getById(id: string): Promise<RuntimeApproval | null> {
    return prisma.runtimeApproval.findUnique({ where: { id } });
  }

  findByExternalActionId(actionId: string): Promise<RuntimeApproval | null> {
    return prisma.runtimeApproval.findFirst({
      where: { externalActionId: actionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findLatestPendingByConversation(conversationId: string): Promise<RuntimeApproval | null> {
    return prisma.runtimeApproval.findFirst({
      where: {
        conversationId,
        status: 'pending',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  updateStatus(input: {
    approvalId: string;
    status: RuntimeApprovalStatus;
    approvedBy?: string | null;
    approvedAt?: Date | null;
    rejectedAt?: Date | null;
    resolutionReason?: string | null;
    executionResultJson?: Record<string, unknown> | null;
  }): Promise<RuntimeApproval> {
    return prisma.runtimeApproval.update({
      where: { id: input.approvalId },
      data: {
        status: input.status,
        approvedBy: input.approvedBy ?? undefined,
        approvedAt: input.approvedAt ?? undefined,
        rejectedAt: input.rejectedAt ?? undefined,
        resolutionReason: input.resolutionReason ?? undefined,
        ...(input.executionResultJson !== undefined
          ? {
            executionResultJson: input.executionResultJson
              ? toJsonValue(input.executionResultJson)
              : Prisma.JsonNull,
          }
          : {}),
      },
    });
  }
}

export const runtimeApprovalRepository = new RuntimeApprovalRepository();
