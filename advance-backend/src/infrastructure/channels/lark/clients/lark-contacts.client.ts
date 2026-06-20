import type { LarkContactsClientPort } from '../../../../application/orchestration/tools/families/lark-contacts.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

type ContactUser = Awaited<ReturnType<LarkContactsClientPort['searchUsers']>>[number];

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boolField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeUser(user: Record<string, unknown>): ContactUser {
  const openId = stringField(user, 'open_id')
    ?? stringField(user, 'openId')
    ?? stringField(user, 'user_id')
    ?? '';
  const displayName = stringField(user, 'localized_name')
    ?? stringField(user, 'name')
    ?? stringField(user, 'displayName')
    ?? openId;
  const email = stringField(user, 'email');
  const enterpriseEmail = stringField(user, 'enterprise_email');
  const department = stringField(user, 'department');
  const p2pChatId = stringField(user, 'p2p_chat_id');
  const isActivated = boolField(user, 'is_activated');
  const isCrossTenant = boolField(user, 'is_cross_tenant');
  const hasChatted = boolField(user, 'has_chatted');
  const matchedQuery = stringField(user, 'matched_query');
  const chatRecencyHint = stringField(user, 'chat_recency_hint');
  return {
    openId,
    displayName,
    ...(email ? { email } : {}),
    ...(enterpriseEmail ? { enterpriseEmail } : {}),
    ...(department ? { department } : {}),
    ...(p2pChatId ? { p2pChatId } : {}),
    ...(isActivated !== undefined ? { isActivated } : {}),
    ...(isCrossTenant !== undefined ? { isCrossTenant } : {}),
    ...(hasChatted !== undefined ? { hasChatted } : {}),
    ...(matchedQuery ? { matchedQuery } : {}),
    ...(chatRecencyHint ? { chatRecencyHint } : {}),
  };
}

export class LarkContactsClient implements LarkContactsClientPort {
  private readonly http: LarkHttpClient;

  constructor(deps: LarkHttpClientDeps) {
    this.http = new LarkHttpClient(deps);
  }

  async searchUsers(params: {
    query?: string;
    userIds?: string[];
    limit?: number;
    hasChatted?: boolean;
    hasEnterpriseEmail?: boolean;
    excludeExternalUsers?: boolean;
  }): Promise<ContactUser[]> {
    type SearchResponse = {
      users?: Array<Record<string, unknown>>;
      items?: Array<Record<string, unknown>>;
    };

    const filter: Record<string, unknown> = {};
    if (params.userIds?.length) filter['user_ids'] = params.userIds;
    if (params.hasChatted !== undefined) filter['has_chatted'] = params.hasChatted;
    if (params.hasEnterpriseEmail !== undefined) filter['has_enterprise_email'] = params.hasEnterpriseEmail;
    if (params.excludeExternalUsers !== undefined) filter['exclude_external_users'] = params.excludeExternalUsers;

    const body: Record<string, unknown> = {
      ...(params.query ? { query: params.query } : {}),
      ...(Object.keys(filter).length ? { filter } : {}),
    };

    const data = await this.http.request<SearchResponse>(
      'POST',
      '/open-apis/contact/v3/users/search',
      {
        query: { page_size: Math.min(Math.max(params.limit ?? 20, 1), 30) },
        body,
      },
    );

    return (data.users ?? data.items ?? [])
      .map(normalizeUser)
      .filter(user => user.openId.length > 0);
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
