import type { PrismaClient, Prisma } from '../../generated/prisma';
import {
  INVOICE_CLAIM_ABSENT,
  INVOICE_CLAIM_PENDING,
  INVOICE_CLAIM_UNRESOLVED,
  type StagedInvoice,
  type StagedInvoiceStore,
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
          ...(staged.sourcePolicy ? { sourcePolicy: staged.sourcePolicy } : {}),
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
    return this.toStagedInvoice(row);
  }

  /**
   * Drafts this member sent to this connection whose outcome was never learned.
   *
   * Not bounded by expiry. A draft that expired an hour ago can still have put
   * a real invoice into Zoho, and that is exactly the fact a second attempt
   * needs to know about.
   *
   * Two states qualify, not one. `unknown:` is set by the code that caught the
   * failure — but a process killed mid-write never reaches that code, and leaves
   * `pending:` behind forever. Both mean the same thing: a request went out and
   * nobody learned what happened to it.
   *
   * Every `pending:` row is returned, however recently it was claimed. Whether
   * a claim is old enough to be an orphan decides what the caller *does* about
   * it, not whether the caller gets to see it.
   *
   * `absent:` rows come back too, while they are still live. A search that
   * found nothing is good evidence, not proof: Zoho's own indexes lag, so an
   * invoice written moments earlier can be genuinely invisible. Re-checking
   * one costs a single list call and is the difference between "we looked once"
   * and "we know".
   */
  async findUnresolved(input: {
    companyId: string;
    connectionId: string;
  }): Promise<readonly StagedInvoice[]> {
    const rows = await this.prisma.zohoInvoiceStaging.findMany({
      where: {
        companyId:    input.companyId,
        connectionId: input.connectionId,
        OR: [
          { createdInvoiceId: { startsWith: INVOICE_CLAIM_UNRESOLVED } },
          { createdInvoiceId: { startsWith: INVOICE_CLAIM_PENDING } },
          {
            createdInvoiceId: { startsWith: INVOICE_CLAIM_ABSENT },
            expiresAt: { gt: new Date() },
          },
        ],
      },
      // Deliberately uncapped. Truncating this set drops a twin silently, and
      // a duplicate guard that quietly stops guarding is the failure this whole
      // mechanism exists to prevent. The query is index-backed on
      // [companyId, connectionId, createdInvoiceId] and the set is naturally
      // small; how much work the caller then does with it is capped there,
      // where it can say so.
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(row => this.toStagedInvoice(row));
  }

  private toStagedInvoice(
    row: NonNullable<Awaited<ReturnType<PrismaClient['zohoInvoiceStaging']['findFirst']>>>,
  ): StagedInvoice {
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
      ...(Object.keys(asRecord(review['sourcePolicy'])).length > 0
        ? { sourcePolicy: asRecord(review['sourcePolicy']) as never }
        : {}),
      ...(row.attachFileName ? { attachFileName: row.attachFileName } : {}),
      attempt: row.attempt,
      ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
      ...(row.createdInvoiceId ? { createdInvoiceId: row.createdInvoiceId } : {}),
      ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
      createdAt: row.createdAt,
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
      data: { createdInvoiceId: input.marker, claimedAt: new Date() },
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

  /**
   * Records that a draft's create was searched for and not found.
   *
   * Conditional on the marker, so a search that concluded "absent" cannot
   * overwrite a claim some other request is still holding — which would throw
   * away that request's own outcome when it finally reported one.
   */
  async markAbsent(input: {
    stagingId: string;
    companyId: string;
    marker: string;
    absent: string;
  }): Promise<void> {
    await this.prisma.zohoInvoiceStaging.updateMany({
      where: { id: input.stagingId, companyId: input.companyId, createdInvoiceId: input.marker },
      data: { createdInvoiceId: input.absent },
    });
  }
}
