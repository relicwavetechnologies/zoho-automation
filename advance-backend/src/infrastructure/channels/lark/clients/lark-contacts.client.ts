import type {
  LarkContactsClientPort,
  LarkDirectoryPerson,
} from '../../../../application/orchestration/tools/families/lark-contacts.tool';
import { LarkHttpClient, type LarkHttpClientDeps } from './lark-http.client';

const DIRECTORY_BATCH_SIZE = 50;

type RawDirectoryUser = Record<string, unknown>;

export class LarkContactsClient implements LarkContactsClientPort {
  private readonly http: LarkHttpClient;
  private tenantPromise: Promise<{ name?: string; tenantKey?: string }> | undefined;

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

  async getUser(openId: string): Promise<{ openId: string; displayName: string; email?: string } | null> {
    type UserResponse = { user?: Record<string, unknown> };
    const data = await this.http.request<UserResponse>(
      'GET',
      `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
      { query: { user_id_type: 'open_id' } },
    );
    const user = data.user;
    if (!user) return null;
    const resolvedOpenId = typeof user['open_id'] === 'string' ? user['open_id'] : openId;
    const displayName = typeof user['name'] === 'string' && user['name'].trim()
      ? user['name'].trim()
      : resolvedOpenId;
    const email = [user['enterprise_email'], user['email']]
      .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    return {
      openId: resolvedOpenId,
      displayName,
      ...(email ? { email: email.trim().toLowerCase() } : {}),
    };
  }

  async getTenantKey(): Promise<string | undefined> {
    return (await this.getTenant()).tenantKey;
  }

  async getUsers(openIds: string[]): Promise<LarkDirectoryPerson[]> {
    const uniqueOpenIds = uniqueStrings(openIds);
    if (uniqueOpenIds.length === 0) return [];

    const users: RawDirectoryUser[] = [];
    for (const userIds of chunks(uniqueOpenIds, DIRECTORY_BATCH_SIZE)) {
      type BatchResponse = { items?: RawDirectoryUser[] };
      const data = await this.http.request<BatchResponse>(
        'GET',
        '/open-apis/contact/v3/users/batch',
        {
          query: {
            user_ids: userIds,
            user_id_type: 'open_id',
            department_id_type: 'open_department_id',
          },
        },
      );
      users.push(...(data.items ?? []));
    }

    return this.hydrateUsers(users);
  }

  async listDepartmentMembers(
    departmentId: string,
    limit?: number,
  ): Promise<LarkDirectoryPerson[]> {
    type ListResponse = {
      items?: Array<Record<string, unknown>>;
      page_token?: string;
      has_more?: boolean;
    };

    const rawUsers: RawDirectoryUser[] = [];
    const maxMembers = Math.max(1, Math.min(limit ?? 50, 100));
    let pageToken: string | undefined;

    do {
      const pageSize = Math.min(maxMembers - rawUsers.length, 50);
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

      rawUsers.push(...(data.items ?? []));

      pageToken = data.has_more && rawUsers.length < maxMembers ? data.page_token : undefined;
    } while (pageToken && rawUsers.length < maxMembers);

    return this.hydrateUsers(rawUsers.slice(0, maxMembers));
  }

  private async hydrateUsers(users: RawDirectoryUser[]): Promise<LarkDirectoryPerson[]> {
    if (users.length === 0) return [];
    const departmentIds = uniqueStrings(users.flatMap(user => stringArray(user['department_ids'])));
    const [departmentNamesById, organization] = await Promise.all([
      this.getDepartmentNames(departmentIds, users),
      this.getOrganization(),
    ]);

    const people: LarkDirectoryPerson[] = [];
    const seen = new Set<string>();
    for (const user of users) {
      const openId = stringValue(user['open_id']);
      const displayName = stringValue(user['name']);
      if (!openId || !displayName || seen.has(openId)) continue;
      seen.add(openId);

      const email = stringValue(user['enterprise_email']) ?? stringValue(user['email']);
      const jobTitle = stringValue(user['job_title']);
      const departmentNames = uniqueStrings([
        ...stringArray(user['department_ids']).flatMap(id => departmentNamesById.get(id) ?? []),
        ...departmentPathNames(user),
      ]);
      people.push({
        openId,
        displayName,
        ...(email ? { email: email.toLowerCase() } : {}),
        ...(jobTitle ? { jobTitle } : {}),
        ...(departmentNames.length ? { departmentNames } : {}),
        ...(organization ? { organization } : {}),
      });
    }
    return people;
  }

  private async getDepartmentNames(
    departmentIds: string[],
    users: RawDirectoryUser[],
  ): Promise<Map<string, string[]>> {
    if (departmentIds.length === 0) return new Map();
    const names = new Map<string, string[]>();
    try {
      for (const ids of chunks(departmentIds, DIRECTORY_BATCH_SIZE)) {
        type BatchResponse = { items?: Array<Record<string, unknown>> };
        const data = await this.http.request<BatchResponse>(
          'GET',
          '/open-apis/contact/v3/departments/batch',
          {
            query: {
              department_ids: ids,
              department_id_type: 'open_department_id',
              user_id_type: 'open_id',
            },
          },
        );
        for (const department of data.items ?? []) {
          const id = stringValue(department['open_department_id']) ?? stringValue(department['department_id']);
          const name = stringValue(department['name']);
          if (id && name) names.set(id, [name]);
        }
      }
      return names;
    } catch {
      // Some tenants expose department_path on users without granting the
      // separate department batch API. Preserve only those truthful names.
      for (const user of users) {
        const fallbackNames = departmentPathNames(user);
        for (const id of stringArray(user['department_ids'])) {
          if (fallbackNames.length) names.set(id, fallbackNames);
        }
      }
      return names;
    }
  }

  private async getOrganization(): Promise<string | undefined> {
    return (await this.getTenant()).name;
  }

  private getTenant(): Promise<{ name?: string; tenantKey?: string }> {
    if (!this.tenantPromise) {
      this.tenantPromise = this.http.request<{ tenant?: Record<string, unknown> }>(
        'GET',
        '/open-apis/tenant/v2/tenant/query',
      ).then(data => {
        const name = stringValue(data.tenant?.['name']);
        const tenantKey = stringValue(data.tenant?.['tenant_key']);
        return {
          ...(name ? { name } : {}),
          ...(tenantKey ? { tenantKey } : {}),
        };
      }).catch(() => {
        this.tenantPromise = undefined;
        return {};
      });
    }
    return this.tenantPromise;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.filter((item): item is string => typeof item === 'string')) : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function departmentPathNames(user: RawDirectoryUser): string[] {
  if (!Array.isArray(user['department_path'])) return [];
  return uniqueStrings(user['department_path'].flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const departmentName = (item as Record<string, unknown>)['department_name'];
    if (!departmentName || typeof departmentName !== 'object') return [];
    const name = stringValue((departmentName as Record<string, unknown>)['name']);
    return name ? [name] : [];
  }));
}
