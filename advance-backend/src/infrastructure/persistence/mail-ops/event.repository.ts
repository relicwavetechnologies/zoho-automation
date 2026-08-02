import { Prisma, type PrismaClient } from '../../../generated/prisma';
import type { NewMailEvent } from '../../../application/mail-ops/mail-ops.types';
import { wrapInfra, type InfraError } from '../../../shared/errors';
import { err, ok, type Result } from '../../../shared/result';
import type { MailboxSyncClaim } from './subscription.repository';

type MailEventDb = Pick<PrismaClient, 'mailEvent' | '$transaction'>;

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
}
