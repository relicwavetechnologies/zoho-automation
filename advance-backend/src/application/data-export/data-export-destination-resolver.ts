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
  readonly companyDestination?: {
    readonly connectionId: string;
  };
  readonly connectionId?: string;
  readonly unavailableReason?: string;
}): DataExportDestinationResolution {
  if (!input.companyDestination) {
    return {
      status: 'unavailable',
      message: input.unavailableReason
        ?? 'Company data export is not configured by an administrator.',
    };
  }
  if (input.connectionId && input.connectionId !== input.companyDestination.connectionId) {
    return {
      status: 'unavailable',
      message: 'Personal Google accounts cannot override the company export destination.',
    };
  }
  return {
    status: 'selected',
    target: {
      kind: 'company_google',
      connectionId: input.companyDestination.connectionId,
    },
  };
}
