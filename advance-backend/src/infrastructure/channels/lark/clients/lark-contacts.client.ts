import type { LarkContactsClientPort } from '../../../../application/orchestration/tools/families/lark-contacts.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

export class LarkContactsClient implements LarkContactsClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async searchDepartments(query: string): Promise<Array<{ departmentId: string; name: string }>> {
    type SearchResponse = { department_list?: Array<Record<string, unknown>> };
    const data = await this.http.request<SearchResponse>(
      'POST',
      '/open-apis/contact/v3/departments/search',
      { body: { query, page_size: 10 } },
    );
    return (data.department_list ?? []).map(dept => ({
      departmentId: dept['open_department_id'] as string ?? '',
      name:         dept['name'] as string ?? '',
    }));
  }

  async listDepartmentMembers(
    departmentId: string,
    limit?: number,
  ): Promise<Array<{ openId: string; displayName: string; email?: string }>> {
    type ListResponse = {
      items?: Array<Record<string, unknown>>;
      page_token?: string;
      has_more?: boolean;
    };

    const all: Array<{ openId: string; displayName: string; email?: string }> = [];
    const pageSize = Math.min(limit ?? 50, 50);
    let pageToken: string | undefined;

    do {
      const data = await this.http.request<ListResponse>(
        'GET',
        '/open-apis/contact/v3/users',
        {
          query: {
            department_id:      departmentId,
            department_id_type: 'open_department_id',
            page_size:          pageSize,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );

      for (const user of data.items ?? []) {
        all.push({
          openId:      user['open_id'] as string ?? '',
          displayName: user['name'] as string ?? '',
          ...(user['email'] ? { email: user['email'] as string } : {}),
        });
      }

      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);

    return all;
  }
}
