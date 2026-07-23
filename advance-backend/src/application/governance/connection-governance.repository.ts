import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

export interface StoredConnectionGovernance {
  readonly managerPolicyJson: unknown | null;
  readonly adminOverrideJson: unknown | null;
}

/** Read-only runtime port. Manager and admin surfaces write through their own routes. */
export interface ConnectionGovernanceRepository {
  findConnectionGovernance(input: {
    readonly companyId: string;
    readonly connectionId: string;
  }): Promise<Result<StoredConnectionGovernance | null, InfraError>>;
}
