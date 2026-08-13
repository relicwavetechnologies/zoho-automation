import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  PURCHASE_ORDER_CLAIM_PENDING,
  PURCHASE_ORDER_CLAIM_UNRESOLVED,
  type StagedPurchaseOrder,
  type StagedPurchaseOrderStore,
} from '../../application/zoho/zoho-purchase-order-staging';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export class PrismaStagedPurchaseOrderStore implements StagedPurchaseOrderStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'zohoPurchaseOrderStaging'>) {}

  async put(staged: StagedPurchaseOrder): Promise<void> {
    await this.prisma.zohoPurchaseOrderStaging.create({
      data: {
        id: staged.stagingId,
        companyId: staged.companyId,
        userId: staged.userId,
        connectionId: staged.connectionId,
        organizationId: staged.organizationId,
        payloadJson: staged.payload as Prisma.InputJsonValue,
        summary: staged.summary,
        findingsJson: staged.findings as unknown as Prisma.InputJsonValue,
        ...(staged.attachFileName ? { attachFileName: staged.attachFileName } : {}),
        expiresAt: staged.expiresAt,
      },
    });
  }

  async get(input: { stagingId: string; companyId: string; userId: string }): Promise<StagedPurchaseOrder | null> {
    const row = await this.prisma.zohoPurchaseOrderStaging.findFirst({
      where: { id: input.stagingId, companyId: input.companyId, userId: input.userId },
    });
    return row ? this.toDomain(row) : null;
  }

  async claim(input: { stagingId: string; companyId: string; marker: string }): Promise<{ claimed: boolean; heldBy?: string }> {
    const claimed = await this.prisma.zohoPurchaseOrderStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdPurchaseOrderId: null },
      data: { createdPurchaseOrderId: input.marker, claimedAt: new Date() },
    });
    if (claimed.count === 1) return { claimed: true };
    const row = await this.prisma.zohoPurchaseOrderStaging.findFirst({
      where: { id: input.stagingId, companyId: input.companyId },
      select: { createdPurchaseOrderId: true },
    });
    return { claimed: false, ...(row?.createdPurchaseOrderId ? { heldBy: row.createdPurchaseOrderId } : {}) };
  }

  async settle(input: { stagingId: string; companyId: string; purchaseOrderId: string }): Promise<void> {
    await this.prisma.zohoPurchaseOrderStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId },
      data: { createdPurchaseOrderId: input.purchaseOrderId },
    });
  }

  async release(input: { stagingId: string; companyId: string; marker: string }): Promise<void> {
    await this.prisma.zohoPurchaseOrderStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdPurchaseOrderId: input.marker },
      data: { createdPurchaseOrderId: null, claimedAt: null },
    });
  }

  async markUnresolved(input: { stagingId: string; companyId: string; marker: string; unresolved: string }): Promise<void> {
    await this.prisma.zohoPurchaseOrderStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdPurchaseOrderId: input.marker },
      data: { createdPurchaseOrderId: input.unresolved },
    });
  }

  async findUnresolved(input: { companyId: string; connectionId: string }): Promise<readonly StagedPurchaseOrder[]> {
    const rows = await this.prisma.zohoPurchaseOrderStaging.findMany({
      where: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        OR: [
          { createdPurchaseOrderId: { startsWith: PURCHASE_ORDER_CLAIM_PENDING } },
          { createdPurchaseOrderId: { startsWith: PURCHASE_ORDER_CLAIM_UNRESOLVED } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(row => this.toDomain(row));
  }

  private toDomain(
    row: NonNullable<Awaited<ReturnType<PrismaClient['zohoPurchaseOrderStaging']['findFirst']>>>,
  ): StagedPurchaseOrder {
    return {
      stagingId: row.id,
      companyId: row.companyId,
      userId: row.userId,
      connectionId: row.connectionId,
      organizationId: row.organizationId,
      payload: asRecord(row.payloadJson),
      summary: row.summary,
      findings: Array.isArray(row.findingsJson) ? row.findingsJson as never : [],
      ...(row.attachFileName ? { attachFileName: row.attachFileName } : {}),
      ...(row.createdPurchaseOrderId ? { createdPurchaseOrderId: row.createdPurchaseOrderId } : {}),
      ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}
