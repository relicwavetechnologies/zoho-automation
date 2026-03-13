import { ZOHO_DEFAULT_PAGE_SIZE } from './zoho-data.client';
import { resolveZohoProvider } from './zoho-provider.resolver';

export type ZohoHistoricalSourceType = 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';

export type ZohoHistoricalRecord = {
  sourceType: ZohoHistoricalSourceType;
  sourceId: string;
  payload: Record<string, unknown>;
};

export type ZohoHistoricalFetchInput = {
  companyId: string;
  cursor?: string;
  pageSize: number;
  environment?: string;
};

export type ZohoHistoricalFetchResult = {
  records: ZohoHistoricalRecord[];
  nextCursor?: string;
  total: number;
  warnings?: Array<{
    code: 'module_skipped' | 'predicate_invalid';
    message: string;
    moduleName: string;
    sourceType: ZohoHistoricalSourceType;
    statusCode?: number;
  }>;
};

export class ZohoHistoricalAdapter {
  async fetchHistoricalBatch(input: ZohoHistoricalFetchInput): Promise<ZohoHistoricalFetchResult> {
    const resolved = await resolveZohoProvider({
      companyId: input.companyId,
      environment: input.environment,
    });
    const page = await resolved.adapter.fetchHistoricalPage({
      context: {
        companyId: input.companyId,
        environment: resolved.environment,
        connectionId: resolved.connectionId,
      },
      cursor: input.cursor,
      pageSize: input.pageSize > 0 ? input.pageSize : ZOHO_DEFAULT_PAGE_SIZE,
    });

    return {
      records: page.records,
      nextCursor: page.nextCursor,
      total: page.total ?? page.records.length,
      warnings: page.warnings,
    };
  }
}

export const zohoHistoricalAdapter = new ZohoHistoricalAdapter();
