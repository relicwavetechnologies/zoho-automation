import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

export type ConnectionProvider = 'google_workspace' | 'zoho';
export type ConnectionAccess = 'read_only' | 'read_write' | 'admin';
export type ConnectionOwnerType = 'user' | 'company';

export interface AccessibleConnection {
  readonly connectionId: string;
  readonly provider: ConnectionProvider;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly ownerType: ConnectionOwnerType;
  readonly ownerUserId?: string;
  readonly access: ConnectionAccess;
  readonly scopes: string[];
  readonly connectedAt: Date;
  readonly lastUsedAt?: Date;
}

export interface ConnectionRegistryPort {
  listAccessibleGoogleConnections(input: {
    readonly companyId: string;
    readonly userId: string;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleZohoConnections(input: {
    readonly companyId: string;
    readonly userId: string;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
}
