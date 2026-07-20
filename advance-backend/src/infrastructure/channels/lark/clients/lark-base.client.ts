import type { LarkBaseClientPort } from '../../../../application/orchestration/tools/families/lark-base.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type RecordData = Record<string, unknown>;

const basePath = (appToken: string, tableId: string) =>
  `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;

export class LarkBaseClient implements LarkBaseClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async listRecords(appToken: string, tableId: string, limit?: number): Promise<unknown[]> {
    type ListResponse = { items?: RecordData[] };
    const data = await this.http.request<ListResponse>(
      'GET',
      basePath(appToken, tableId),
      { query: { page_size: limit ?? 20 } },
    );
    return data.items ?? [];
  }

  async getRecord(appToken: string, tableId: string, recordId: string): Promise<unknown> {
    type GetResponse = { record: RecordData };
    const data = await this.http.request<GetResponse>(
      'GET',
      `${basePath(appToken, tableId)}/${encodeURIComponent(recordId)}`,
    );
    return data.record;
  }

  async createRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<{ recordId: string }> {
    type CreateResponse = { record: RecordData };
    const data = await this.http.request<CreateResponse>(
      'POST',
      basePath(appToken, tableId),
      { body: { fields } },
    );
    return { recordId: (data.record['record_id'] ?? '') as string };
  }

  async updateRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.http.request(
      'PUT',
      `${basePath(appToken, tableId)}/${encodeURIComponent(recordId)}`,
      { body: { fields } },
    );
  }

  async deleteRecord(appToken: string, tableId: string, recordId: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `${basePath(appToken, tableId)}/${encodeURIComponent(recordId)}`,
    );
  }

  async searchRecords(
    appToken: string,
    tableId: string,
    filter: string,
    limit?: number,
    fieldName?: string,
  ): Promise<unknown[]> {
    type SearchResponse = { items?: RecordData[] };
    const resolvedFieldName = fieldName ?? await this.resolvePrimaryFieldName(appToken, tableId);
    const data = await this.http.request<SearchResponse>(
      'POST',
      `${basePath(appToken, tableId)}/search`,
      {
        query: { page_size: limit ?? 20 },
        body: {
          filter: {
            conjunction: 'and',
            conditions: [{ field_name: resolvedFieldName, operator: 'contains', value: [filter] }],
          },
        },
      },
    );
    return data.items ?? [];
  }

  private async resolvePrimaryFieldName(appToken: string, tableId: string): Promise<string> {
    type FieldsResponse = { items?: Array<Record<string, unknown>> };
    const data = await this.http.request<FieldsResponse>(
      'GET',
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { query: { page_size: 100 } },
    );
    const primary = (data.items ?? []).find(field => field['is_primary'] === true);
    const fieldName = primary?.['field_name'];
    if (typeof fieldName !== 'string' || !fieldName.trim()) {
      throw new Error('Could not determine the Base primary field; provide fieldName explicitly.');
    }
    return fieldName;
  }
}
