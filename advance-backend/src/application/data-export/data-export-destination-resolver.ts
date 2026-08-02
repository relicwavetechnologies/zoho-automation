import { GOOGLE_SCOPE, hasGoogleScopeGroups } from '../../domain/google/google-workspace-scope';
import type { AccessibleConnection } from '../connections/connection-registry.port';
import type { DataExportDestinationTarget } from './data-export.types';

export interface DataExportDestinationChoice {
  readonly connectionId: string;
  readonly label: string;
  readonly accountEmail?: string;
}

export type DataExportDestinationResolution =
  | { readonly status: 'selected'; readonly target: DataExportDestinationTarget }
  | { readonly status: 'choose_connection'; readonly connections: readonly DataExportDestinationChoice[] }
  | { readonly status: 'connect_required' }
  | { readonly status: 'unavailable'; readonly message: string };

export type ResolveDataExportDestination = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId?: string;
}) => Promise<DataExportDestinationResolution>;

export function selectDataExportDestination(input: {
  readonly userId: string;
  readonly accessible: readonly AccessibleConnection[];
  readonly companyFallback?: {
    readonly connectionId: string;
  };
  readonly connectionId?: string;
}): DataExportDestinationResolution {
  const personal = input.accessible.filter(connection =>
    connection.ownerType === 'user'
    && connection.ownerUserId === input.userId
    && connection.access !== 'read_only'
    && hasGoogleScopeGroups(connection.scopes, [
      [GOOGLE_SCOPE.driveFull, GOOGLE_SCOPE.driveFile],
      [GOOGLE_SCOPE.sheetsFull],
    ]),
  );

  if (input.connectionId) {
    const selected = personal.find(connection =>
      connection.connectionId === input.connectionId,
    );
    if (selected) {
      return {
        status: 'selected',
        target: { kind: 'user_google', connectionId: selected.connectionId },
      };
    }
    if (
      personal.length === 0
      && input.companyFallback?.connectionId === input.connectionId
    ) {
      return {
        status: 'selected',
        target: {
          kind: 'company_google',
          connectionId: input.companyFallback.connectionId,
        },
      };
    }
    return {
      status: 'unavailable',
      message: 'The selected Google export account is unavailable or no longer writable.',
    };
  }

  if (personal.length === 1) {
    return {
      status: 'selected',
      target: { kind: 'user_google', connectionId: personal[0]!.connectionId },
    };
  }
  if (personal.length > 1) {
    return {
      status: 'choose_connection',
      connections: personal.map(connection => ({
        connectionId: connection.connectionId,
        label: connection.label,
        ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
      })),
    };
  }
  if (input.companyFallback) {
    return {
      status: 'selected',
      target: {
        kind: 'company_google',
        connectionId: input.companyFallback.connectionId,
      },
    };
  }
  return { status: 'connect_required' };
}
