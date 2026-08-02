import { GOOGLE_SCOPE, hasGoogleScopeGroups } from '../../domain/google/google-workspace-scope';
import type { AccessibleConnection } from '../connections/connection-registry.port';
import type { GoogleSheetReference } from './google-sheet-resource-reference';

const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

export interface ResolvedGoogleSheetResource extends GoogleSheetReference {
  readonly connectionId: string;
}

export interface GoogleDriveFileMetadata {
  readonly id?: string;
  readonly mimeType?: string;
  readonly trashed?: boolean;
  readonly capabilities?: {
    readonly canEdit?: boolean;
  };
}

export interface GoogleSheetsMetadata {
  readonly spreadsheetId?: string;
}

export interface GoogleSheetResourceProbe {
  getDriveFile(input: {
    readonly connectionId: string;
    readonly fileId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<GoogleDriveFileMetadata | null>;
  getSpreadsheet(input: {
    readonly connectionId: string;
    readonly spreadsheetId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<GoogleSheetsMetadata | null>;
}

export type GoogleSheetResourceResolution =
  | { readonly status: 'no_connection' }
  | { readonly status: 'missing_scope' }
  | { readonly status: 'inaccessible' }
  | { readonly status: 'trashed' }
  | { readonly status: 'wrong_type' }
  | { readonly status: 'read_only' }
  | { readonly status: 'resolved'; readonly resource: ResolvedGoogleSheetResource }
  | {
      readonly status: 'choose_connection';
      readonly connections: readonly {
        readonly connectionId: string;
        readonly label: string;
        readonly accountEmail?: string;
      }[];
    };

type GoogleSheetResourceProbeFailure =
  | 'inaccessible'
  | 'trashed'
  | 'wrong_type'
  | 'read_only';

export class GoogleSheetResourceResolver {
  constructor(private readonly probe: GoogleSheetResourceProbe) {}

  listEligible(input: {
    readonly userId: string;
    readonly accessible: readonly AccessibleConnection[];
  }): GoogleSheetResourceResolution {
    const eligible = this.eligibleConnections(input);
    if (eligible.status !== 'eligible') return eligible;
    return {
      status: 'choose_connection',
      connections: eligible.connections.map(connection => ({
        connectionId: connection.connectionId,
        label: connection.label,
        ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
      })),
    };
  }

  async resolve(input: {
    readonly userId: string;
    readonly accessible: readonly AccessibleConnection[];
    readonly reference: GoogleSheetReference;
    readonly abortSignal?: AbortSignal;
  }): Promise<GoogleSheetResourceResolution> {
    const eligible = this.eligibleConnections(input);
    if (eligible.status !== 'eligible') return eligible;
    const scoped = eligible.connections;

    const probes = await Promise.all(scoped.map(connection => this.probeConnection(connection, input)));
    const resolved = probes.filter((value): value is ResolvedGoogleSheetResource =>
      typeof value === 'object' && 'connectionId' in value,
    );
    if (resolved.length === 1) return { status: 'resolved', resource: resolved[0]! };
    if (resolved.length > 1) {
      return {
        status: 'choose_connection',
        connections: resolved.map((value) => {
          const connection = scoped.find(candidate => candidate.connectionId === value.connectionId)!;
          return {
            connectionId: connection.connectionId,
            label: connection.label,
            ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
          };
        }),
      };
    }
    const failure = probes.find((value): value is GoogleSheetResourceProbeFailure => typeof value === 'string');
    return { status: failure ?? 'inaccessible' };
  }

  private eligibleConnections(input: {
    readonly userId: string;
    readonly accessible: readonly AccessibleConnection[];
  }):
    | { readonly status: 'no_connection' }
    | { readonly status: 'missing_scope' }
    | { readonly status: 'eligible'; readonly connections: readonly AccessibleConnection[] } {
    const personal = input.accessible.filter(connection =>
      connection.provider === 'google_workspace'
      && (connection.status === undefined || connection.status === 'connected')
      && connection.ownerType === 'user'
      && connection.ownerUserId === input.userId
      && connection.access !== 'read_only',
    );
    if (personal.length === 0) return { status: 'no_connection' };

    const scoped = personal.filter(connection => hasGoogleScopeGroups(connection.scopes, [
      [GOOGLE_SCOPE.driveFull],
      [GOOGLE_SCOPE.sheetsFull],
    ]));
    if (scoped.length === 0) return { status: 'missing_scope' };
    return { status: 'eligible', connections: scoped };
  }

  private async probeConnection(
    connection: AccessibleConnection,
    input: {
      readonly reference: GoogleSheetReference;
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<GoogleSheetResourceProbeFailure | ResolvedGoogleSheetResource> {
    const drive = await this.probe.getDriveFile({
      connectionId: connection.connectionId,
      fileId: input.reference.resourceId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (!drive || drive.id !== input.reference.resourceId) return 'inaccessible';
    if (drive.trashed === true) return 'trashed';
    if (drive.mimeType !== GOOGLE_SHEET_MIME_TYPE) return 'wrong_type';
    if (drive.capabilities?.canEdit !== true) return 'read_only';

    const sheets = await this.probe.getSpreadsheet({
      connectionId: connection.connectionId,
      spreadsheetId: input.reference.resourceId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (
      !sheets
      || (
        sheets.spreadsheetId !== undefined
        && sheets.spreadsheetId !== input.reference.resourceId
      )
    ) {
      return 'inaccessible';
    }
    return {
      ...input.reference,
      connectionId: connection.connectionId,
    };
  }
}
