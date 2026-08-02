import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

type DataExportDestinationPreferenceDb = Pick<PrismaClient, 'dataExportDestinationPreference'>;

export class DataExportDestinationPreferenceRepository {
  constructor(private readonly db: DataExportDestinationPreferenceDb) {}

  async findConnectionId(input: {
    readonly companyId: string;
    readonly userId: string;
  }): Promise<Result<string | undefined, Error>> {
    try {
      const row = await this.db.dataExportDestinationPreference.findUnique({
        where: {
          companyId_userId: {
            companyId: input.companyId,
            userId: input.userId,
          },
        },
        select: { connectionId: true },
      });
      return ok(row?.connectionId);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportDestinationPreference.findUnique', cause));
    }
  }

  async save(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
  }): Promise<Result<void, Error>> {
    try {
      await this.db.dataExportDestinationPreference.upsert({
        where: {
          companyId_userId: {
            companyId: input.companyId,
            userId: input.userId,
          },
        },
        create: input,
        update: { connectionId: input.connectionId },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportDestinationPreference.upsert', cause));
    }
  }
}
