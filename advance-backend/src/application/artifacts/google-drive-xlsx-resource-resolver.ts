import type { AccessibleConnection } from '../connections/connection-registry.port';
import type { GoogleDriveXlsxReference } from './google-drive-xlsx-resource-reference';
import {
  eligibleWritableGoogleConnections,
  type GoogleSheetResourceProbe,
} from './google-sheet-resource-resolver';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ResolvedGoogleDriveXlsxResource extends GoogleDriveXlsxReference {
  readonly connectionId: string;
  readonly fileName?: string;
  readonly requiresConfirmation: true;
  readonly conversion: 'new_google_sheet_copy';
}

export type GoogleDriveXlsxResourceResolution =
  | { readonly status: 'no_connection' }
  | { readonly status: 'missing_scope' }
  | { readonly status: 'inaccessible' }
  | { readonly status: 'trashed' }
  | { readonly status: 'wrong_type' }
  | { readonly status: 'copy_restricted' }
  | { readonly status: 'resolved'; readonly resource: ResolvedGoogleDriveXlsxResource }
  | {
      readonly status: 'choose_connection';
      readonly connections: readonly {
        readonly connectionId: string;
        readonly label: string;
        readonly accountEmail?: string;
      }[];
    };

type ProbeFailure = 'inaccessible' | 'trashed' | 'wrong_type' | 'copy_restricted';

export class GoogleDriveXlsxResourceResolver {
  constructor(private readonly probe: GoogleSheetResourceProbe) {}

  listEligible(input: {
    readonly userId: string;
    readonly accessible: readonly AccessibleConnection[];
  }): GoogleDriveXlsxResourceResolution {
    const eligible = eligibleWritableGoogleConnections(input);
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
    readonly reference: GoogleDriveXlsxReference;
    readonly abortSignal?: AbortSignal;
  }): Promise<GoogleDriveXlsxResourceResolution> {
    const eligible = eligibleWritableGoogleConnections(input);
    if (eligible.status !== 'eligible') return eligible;
    const scoped = eligible.connections;
    const probes = await Promise.all(scoped.map(connection => this.probeConnection(connection, input)));
    const resolved = probes.filter((value): value is ResolvedGoogleDriveXlsxResource =>
      typeof value === 'object' && 'connectionId' in value,
    );
    if (resolved.length === 1) return { status: 'resolved', resource: resolved[0]! };
    if (resolved.length > 1) {
      return {
        status: 'choose_connection',
        connections: resolved.map(value => {
          const connection = scoped.find(candidate => candidate.connectionId === value.connectionId)!;
          return {
            connectionId: connection.connectionId,
            label: connection.label,
            ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
          };
        }),
      };
    }
    const failure = probes.find((value): value is ProbeFailure => typeof value === 'string');
    return { status: failure ?? 'inaccessible' };
  }

  private async probeConnection(
    connection: AccessibleConnection,
    input: { readonly reference: GoogleDriveXlsxReference; readonly abortSignal?: AbortSignal },
  ): Promise<ProbeFailure | ResolvedGoogleDriveXlsxResource> {
    const drive = await this.probe.getDriveFile({
      connectionId: connection.connectionId,
      fileId: input.reference.resourceId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (!drive || drive.id !== input.reference.resourceId) return 'inaccessible';
    if (drive.trashed === true) return 'trashed';
    if (drive.mimeType !== XLSX_MIME_TYPE) return 'wrong_type';
    if (drive.capabilities?.canCopy !== true || drive.capabilities.canDownload !== true) {
      return 'copy_restricted';
    }
    return {
      ...input.reference,
      connectionId: connection.connectionId,
      ...(drive.name ? { fileName: drive.name } : {}),
      requiresConfirmation: true,
      conversion: 'new_google_sheet_copy',
    };
  }
}
