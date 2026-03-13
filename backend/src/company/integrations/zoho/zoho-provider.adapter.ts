import type { ZohoFailureCode } from './zoho.errors';

export type ZohoProviderMode = 'rest' | 'mcp';

export type ZohoSourceType = 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';

export type ZohoProviderHistoricalRecord = {
  sourceType: ZohoSourceType;
  sourceId: string;
  payload: Record<string, unknown>;
};

export type ZohoProviderContext = {
  companyId: string;
  environment?: string;
  connectionId: string;
};

export type ZohoProviderHistoricalPageInput = {
  context: ZohoProviderContext;
  cursor?: string;
  pageSize: number;
  sourceType?: ZohoSourceType;
  sortBy?: 'id' | 'Created_Time' | 'Modified_Time';
  sortOrder?: 'asc' | 'desc';
};

export type ZohoProviderHistoricalPageResult = {
  records: ZohoProviderHistoricalRecord[];
  nextCursor?: string;
  total?: number;
  warnings?: Array<{
    code: 'module_skipped' | 'predicate_invalid';
    message: string;
    moduleName: string;
    sourceType: ZohoSourceType;
    statusCode?: number;
  }>;
};

export type ZohoProviderActionInput = {
  context: ZohoProviderContext;
  actionName: string;
  payload: Record<string, unknown>;
  hitlConfirmed: boolean;
};

export type ZohoProviderHealth = {
  ok: boolean;
  status: 'healthy' | 'degraded' | 'failed';
  providerMode: ZohoProviderMode;
  latencyMs?: number;
  reasonCode?: ZohoFailureCode;
  details?: Record<string, unknown>;
};

export interface ZohoProviderAdapter {
  readonly mode: ZohoProviderMode;

  discoverCapabilities(context: ZohoProviderContext): Promise<string[]>;

  health(context: ZohoProviderContext): Promise<ZohoProviderHealth>;

  fetchHistoricalPage(input: ZohoProviderHistoricalPageInput): Promise<ZohoProviderHistoricalPageResult>;

  fetchRecordBySource(input: {
    context: ZohoProviderContext;
    sourceType: ZohoSourceType;
    sourceId: string;
  }): Promise<Record<string, unknown> | null>;

  executeAction(input: ZohoProviderActionInput): Promise<{
    actionName: string;
    status: 'success' | 'failed';
    receipt?: Record<string, unknown>;
    failureCode?: ZohoFailureCode;
    message?: string;
  }>;
}
