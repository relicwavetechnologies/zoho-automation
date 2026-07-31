import type { PrismaClient } from '../../generated/prisma';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { ConnectionGovernanceRepository, StoredConnectionGovernance } from '../../application/governance/connection-governance.repository';

export class PrismaConnectionGovernanceRepository implements ConnectionGovernanceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findConnectionGovernance(input: {
    readonly companyId: string;
    readonly connectionId: string;
  }): Promise<Result<StoredConnectionGovernance | null, InfraError>> {
    try {
      const row = await this.prisma.integrationConnectionGovernance.findFirst({
        where: { companyId: input.companyId, connectionId: input.connectionId },
        select: { managerPolicyJson: true, adminOverrideJson: true },
      });
      return ok(row ?? null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'ConnectionGovernance.find', cause));
    }
  }
}
