import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  BILL_CLAIM_PENDING,
  BILL_CLAIM_UNRESOLVED,
  type StagedBill,
  type StagedBillStore,
} from '../../application/zoho/zoho-bill-staging';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export class PrismaStagedBillStore implements StagedBillStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'zohoBillStaging'>) {}

  async put(staged: StagedBill): Promise<void> {
    await this.prisma.zohoBillStaging.create({
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

  async get(input: { stagingId: string; companyId: string; userId: string }): Promise<StagedBill | null> {
    const row = await this.prisma.zohoBillStaging.findFirst({
      where: { id: input.stagingId, companyId: input.companyId, userId: input.userId },
    });
    return row ? this.toDomain(row) : null;
  }

  async claim(input: { stagingId: string; companyId: string; marker: string }): Promise<{ claimed: boolean; heldBy?: string }> {
    const claimed = await this.prisma.zohoBillStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdBillId: null },
      data: { createdBillId: input.marker, claimedAt: new Date() },
    });
    if (claimed.count === 1) return { claimed: true };
    const row = await this.prisma.zohoBillStaging.findFirst({
      where: { id: input.stagingId, companyId: input.companyId },
      select: { createdBillId: true },
    });
    return { claimed: false, ...(row?.createdBillId ? { heldBy: row.createdBillId } : {}) };
  }

  async settle(input: { stagingId: string; companyId: string; billId: string }): Promise<void> {
    await this.prisma.zohoBillStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId },
      data: { createdBillId: input.billId },
    });
  }

  async release(input: { stagingId: string; companyId: string; marker: string }): Promise<void> {
    await this.prisma.zohoBillStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdBillId: input.marker },
      data: { createdBillId: null, claimedAt: null },
    });
  }

  async markUnresolved(input: { stagingId: string; companyId: string; marker: string; unresolved: string }): Promise<void> {
    await this.prisma.zohoBillStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdBillId: input.marker },
      data: { createdBillId: input.unresolved },
    });
  }

  async findUnresolved(input: { companyId: string; connectionId: string }): Promise<readonly StagedBill[]> {
    const rows = await this.prisma.zohoBillStaging.findMany({
      where: {
        companyId: input.companyId,
        connectionId: input.connectionId,
        OR: [
          { createdBillId: { startsWith: BILL_CLAIM_PENDING } },
          { createdBillId: { startsWith: BILL_CLAIM_UNRESOLVED } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(row => this.toDomain(row));
  }

  private toDomain(
    row: NonNullable<Awaited<ReturnType<PrismaClient['zohoBillStaging']['findFirst']>>>,
  ): StagedBill {
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
      ...(row.createdBillId ? { createdBillId: row.createdBillId } : {}),
      ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}
