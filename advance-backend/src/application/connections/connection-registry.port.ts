import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import type { ConnectionProvider } from '../../domain/connections/connection-provider';

export type { ConnectionProvider } from '../../domain/connections/connection-provider';
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
  /**
   * Present only for providers that can hold a listed-but-unusable connection.
   * Every OAuth provider heals a stale credential with a refresh token, so it
   * has nothing to report here; an API-key provider cannot, and a key revoked
   * upstream has to stay visible in order to be repaired rather than silently
   * disappearing from the account list.
   */
  readonly status?: string;
}

export interface ConnectionRegistryPort {
  listAccessibleGoogleConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleZohoConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleCanvaConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleAirtableConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleAitableConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleLarkConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
  listAccessibleShopifyConnections(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<AccessibleConnection[], InfraError>>;
}
