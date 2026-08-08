import type { PrismaClient, Prisma } from '../../generated/prisma';
import type {
  StagedInvoice,
  StagedInvoiceStore,
} from '../../application/zoho/zoho-invoice-staging';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class PrismaStagedInvoiceStore implements StagedInvoiceStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'zohoInvoiceStaging'>) {}

  async put(staged: StagedInvoice): Promise<void> {
    await this.prisma.zohoInvoiceStaging.create({
      data: {
        id: staged.stagingId,
        companyId: staged.companyId,
        userId: staged.userId,
        connectionId: staged.connectionId,
        ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
        payloadJson: staged.payload as Prisma.InputJsonValue,
        summary: staged.summary,
        reviewJson: {
          findings: staged.findings,
          review: staged.review,
        } as unknown as Prisma.InputJsonValue,
        ...(staged.attachFileName ? { attachFileName: staged.attachFileName } : {}),
        attempt: staged.attempt,
        ...(staged.supersedesId ? { supersedesId: staged.supersedesId } : {}),
        expiresAt: staged.expiresAt,
      },
    });
  }

  async get(input: {
    stagingId: string;
    companyId: string;
    userId: string;
  }): Promise<StagedInvoice | null> {
    const row = await this.prisma.zohoInvoiceStaging.findFirst({
      where: {
        id: input.stagingId,
        companyId: input.companyId,
        // Scoped to the member who staged it: one person's draft is not another
        // person's to create.
        userId: input.userId,
      },
    });
    if (!row) return null;

    const review = asRecord(row.reviewJson);
    return {
      stagingId: row.id,
      companyId: row.companyId,
      userId: row.userId,
      connectionId: row.connectionId,
      ...(row.organizationId ? { organizationId: row.organizationId } : {}),
      payload: asRecord(row.payloadJson),
      summary: row.summary,
      findings: Array.isArray(review['findings']) ? review['findings'] as never : [],
      review: asRecord(review['review']) as never,
      ...(row.attachFileName ? { attachFileName: row.attachFileName } : {}),
      attempt: row.attempt,
      ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
      ...(row.createdInvoiceId ? { createdInvoiceId: row.createdInvoiceId } : {}),
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Takes ownership of this draft before anything is posted to Zoho.
   *
   * Claimed *before* the call, not after. Zoho offers no idempotency key, so a
   * create that succeeds and then times out would otherwise be retried into a
   * second real invoice. Marking first means the retry finds the claim and can
   * say "this was already sent, go and look" instead of billing someone twice.
   */
  async claim(input: {
    stagingId: string;
    companyId: string;
    marker: string;
  }): Promise<{ claimed: boolean; heldBy?: string }> {
    const claimed = await this.prisma.zohoInvoiceStaging.updateMany({
      where: {
        id: input.stagingId,
        companyId: input.companyId,
        createdInvoiceId: null,
      },
      data: { createdInvoiceId: input.marker },
    });
    if (claimed.count === 1) return { claimed: true };

    const row = await this.prisma.zohoInvoiceStaging.findFirst({
      where: { id: input.stagingId, companyId: input.companyId },
      select: { createdInvoiceId: true },
    });
    return { claimed: false, ...(row?.createdInvoiceId ? { heldBy: row.createdInvoiceId } : {}) };
  }

  /** Replaces the claim marker with the invoice Zoho actually created. */
  async settle(input: {
    stagingId: string;
    companyId: string;
    invoiceId: string;
  }): Promise<void> {
    await this.prisma.zohoInvoiceStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId },
      data: { createdInvoiceId: input.invoiceId },
    });
  }

  /** Hands the draft back when the create provably never happened, so it can be retried. */
  async release(input: { stagingId: string; companyId: string; marker: string }): Promise<void> {
    await this.prisma.zohoInvoiceStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdInvoiceId: input.marker },
      data: { createdInvoiceId: null },
    });
  }

  /**
   * Keeps the draft held when the create's outcome is unknown.
   *
   * Deliberately not a release: the invoice may exist. Leaving the claim in a
   * state no retry clears is what stops a lost response from becoming a second
   * real invoice, and it is why the member is told to go and look instead.
   */
  async markUnresolved(input: {
    stagingId: string;
    companyId: string;
    marker: string;
    unresolved: string;
  }): Promise<void> {
    await this.prisma.zohoInvoiceStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdInvoiceId: input.marker },
      data: { createdInvoiceId: input.unresolved },
    });
  }
}
