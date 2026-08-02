import { Prisma, type PrismaClient } from '../../../generated/prisma';
import type { NewMailEvent } from '../../../application/mail-ops/mail-ops.types';
import { wrapInfra, type InfraError } from '../../../shared/errors';
import { err, ok, type Result } from '../../../shared/result';
import type { MailboxSyncClaim } from './subscription.repository';

type MailEventDb = Pick<
  PrismaClient,
  'mailEvent' | '$transaction' | '$executeRaw'
>;

export interface PersistedMailEvent extends NewMailEvent {
  eventId: string;
}

export class MailEventRepository {
  constructor(private readonly db: MailEventDb) {}

  async recordEvents(
    claim: MailboxSyncClaim,
    events: NewMailEvent[],
  ): Promise<Result<PersistedMailEvent[], InfraError>> {
    try {
      const persisted = await this.db.$transaction(async tx => {
        if (events.length > 0) {
          await tx.mailEvent.createMany({
            data: events.map(event => ({
              companyId: claim.companyId,
              subscriptionId: claim.subscriptionId,
              providerMessageId: event.providerMessageId,
              ...(event.providerThreadId
                ? { providerThreadId: event.providerThreadId }
                : {}),
              historyId: event.historyId,
              metadataJson: event.metadata as Prisma.InputJsonObject,
              occurredAt: event.occurredAt,
            })),
            skipDuplicates: true,
          });
        }
        if (events.length === 0) return [];

        const rows = await tx.mailEvent.findMany({
          where: {
            subscriptionId: claim.subscriptionId,
            providerMessageId: {
              in: events.map(event => event.providerMessageId),
            },
          },
          select: {
            id: true,
            providerMessageId: true,
            providerThreadId: true,
            historyId: true,
            metadataJson: true,
            occurredAt: true,
          },
          // Oldest first. A rule's hourly ceiling counts the deliveries whose
          // mail arrived before the message being judged, so processing a
          // batch newest-first would show every message an empty window and
          // wave the whole backlog through. Postgres promises no order without
          // this, and the natural order for an `IN (...)` lookup on
          // `(subscriptionId, providerMessageId)` is by message ID — which is
          // not arrival order. The worker sorts as well; this makes the
          // ordering the query's own answer rather than a coincidence.
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        });
        return rows.map(row => ({
          eventId: row.id,
          providerMessageId: row.providerMessageId,
          ...(row.providerThreadId
            ? { providerThreadId: row.providerThreadId }
            : {}),
          historyId: row.historyId,
          metadata: row.metadataJson as Record<string, unknown>,
          occurredAt: row.occurredAt,
        }));
      });
      return ok(persisted);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.recordEvents', cause));
    }
  }

  /**
   * Drops the message body from events past the body retention age.
   *
   * The event survives, because the event is what stops a message being
   * delivered twice; only the text goes. Raw SQL because this is a key removed
   * from inside a JSON column, which Prisma's typed API cannot express — the
   * alternative is reading every row into Node to rewrite it.
   *
   * `IS NOT NULL` rather than the `?` containment operator, deliberately: `?`
   * is also a parameter placeholder in several Postgres drivers, and a query
   * that works until the day something changes underneath it is not worth the
   * brevity.
   */
  async stripEventBodies(before: Date): Promise<Result<number, InfraError>> {
    try {
      return ok(await this.db.$executeRaw`
        UPDATE "MailEvent"
        SET "metadataJson" = "metadataJson" - 'bodyText'
        WHERE "occurredAt" < ${before}
          AND "metadataJson" ->> 'bodyText' IS NOT NULL
      `);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.stripEventBodies', cause));
    }
  }

  /**
   * Deletes events past the event retention age, and their deliveries with
   * them.
   *
   * An event with a delivery still `pending` or `sending` is never taken, no
   * matter how old it is: the delivery cascades with its event, so deleting one
   * would destroy work still in flight. That case means something else is
   * wrong — a 90-day-old pending delivery is well past the retry ladder — and
   * losing the evidence would be the worst possible response to it.
   */
  async deleteEventsBefore(before: Date): Promise<Result<number, InfraError>> {
    try {
      const deleted = await this.db.mailEvent.deleteMany({
        where: {
          occurredAt: { lt: before },
          deliveries: { none: { status: { in: ['pending', 'sending'] } } },
        },
      });
      return ok(deleted.count);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.deleteEventsBefore', cause));
    }
  }
}
