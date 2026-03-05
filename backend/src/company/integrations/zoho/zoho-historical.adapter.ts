import { ZOHO_DEFAULT_PAGE_SIZE, zohoDataClient } from './zoho-data.client';

export type ZohoHistoricalSourceType = 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';

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
};

export class ZohoHistoricalAdapter {
  async fetchHistoricalBatch(input: ZohoHistoricalFetchInput): Promise<ZohoHistoricalFetchResult> {
    const page = await zohoDataClient.fetchHistoricalPage({
      companyId: input.companyId,
      environment: input.environment,
      cursor: input.cursor,
      pageSize: input.pageSize > 0 ? input.pageSize : ZOHO_DEFAULT_PAGE_SIZE,
    });

    return {
      records: page.records,
      nextCursor: page.nextCursor,
      total: page.total ?? page.records.length,
    };
  }
}

export const zohoHistoricalAdapter = new ZohoHistoricalAdapter();
