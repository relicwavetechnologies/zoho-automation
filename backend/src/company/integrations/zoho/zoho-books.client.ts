import { prisma } from '../../../utils/prisma';
import { ZohoIntegrationError } from './zoho.errors';
import { zohoHttpClient, ZohoHttpClient } from './zoho-http.client';
import { zohoTokenService, ZohoTokenService } from './zoho-token.service';

export type ZohoBooksModule =
  | 'invoices'
  | 'estimates'
  | 'bills'
  | 'customerpayments'
  | 'banktransactions';

type ZohoBooksClientOptions = {
  httpClient?: ZohoHttpClient;
  tokenService?: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>;
};

type ZohoBooksResponse = Record<string, unknown>;

type ZohoBooksOrganization = {
  organizationId: string;
  name?: string;
  isDefault?: boolean;
  raw: Record<string, unknown>;
};

const BOOKS_MODULE_KEYS: Record<ZohoBooksModule, { listKey: string; singularKeys: string[]; label: string }> = {
  invoices: { listKey: 'invoices', singularKeys: ['invoice'], label: 'invoice' },
  estimates: { listKey: 'estimates', singularKeys: ['estimate'], label: 'estimate' },
  bills: { listKey: 'bills', singularKeys: ['bill'], label: 'bill' },
  customerpayments: { listKey: 'customerpayments', singularKeys: ['customerpayment', 'payment'], label: 'customer payment' },
  banktransactions: { listKey: 'banktransactions', singularKeys: ['banktransaction', 'transaction'], label: 'bank transaction' },
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asArrayOfRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

const tokenMetadataToRecord = (value: unknown): Record<string, unknown> | undefined =>
  asRecord(value);

const readOrganizationIdFromMetadata = (metadata: Record<string, unknown> | undefined): string | undefined => {
  if (!metadata) {
    return undefined;
  }
  return asString(metadata.organizationId)
    ?? asString(metadata.organization_id)
    ?? asString(metadata.booksOrganizationId)
    ?? asString(metadata.books_organization_id)
    ?? asString(metadata.defaultOrganizationId);
};

const buildModulePath = (moduleName: ZohoBooksModule, recordId?: string): string =>
  recordId ? `/books/v3/${moduleName}/${encodeURIComponent(recordId)}` : `/books/v3/${moduleName}`;

const toPrimitiveString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return undefined;
};

const extractListItems = (moduleName: ZohoBooksModule, payload: ZohoBooksResponse): Record<string, unknown>[] =>
  asArrayOfRecords(payload[BOOKS_MODULE_KEYS[moduleName].listKey]);

const extractSingleItem = (moduleName: ZohoBooksModule, payload: ZohoBooksResponse): Record<string, unknown> => {
  const config = BOOKS_MODULE_KEYS[moduleName];
  for (const key of config.singularKeys) {
    const direct = asRecord(payload[key]);
    if (direct) {
      return direct;
    }
  }
  const listMatch = extractListItems(moduleName, payload);
  if (listMatch.length > 0) {
    return listMatch[0];
  }
  return payload;
};

const itemMatchesQuery = (item: Record<string, unknown>, query?: string): boolean => {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return JSON.stringify(item).toLowerCase().includes(normalized);
};

export class ZohoBooksClient {
  private readonly httpClient: ZohoHttpClient;

  private readonly tokenService: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>;

  constructor(options: ZohoBooksClientOptions = {}) {
    this.httpClient = options.httpClient ?? zohoHttpClient;
    this.tokenService = options.tokenService ?? zohoTokenService;
  }

  async listOrganizations(input: {
    companyId: string;
    environment?: string;
  }): Promise<ZohoBooksOrganization[]> {
    const environment = input.environment ?? 'prod';
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: '/books/v3/organizations',
      method: 'GET',
    });

    return asArrayOfRecords(payload.organizations).map((organization) => ({
      organizationId:
        asString(organization.organization_id)
        ?? asString(organization.organizationId)
        ?? '',
      name: asString(organization.name),
      isDefault:
        asBoolean(organization.is_default_org)
        ?? asBoolean(organization.is_default)
        ?? asBoolean(organization.isDefault),
      raw: organization,
    })).filter((organization) => organization.organizationId.length > 0);
  }

  async listRecords(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    organizationId?: string;
    filters?: Record<string, unknown>;
    limit?: number;
    query?: string;
  }): Promise<{ organizationId: string; items: Record<string, unknown>[]; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const params = new URLSearchParams({
      organization_id: organizationId,
      page: '1',
      per_page: String(Math.max(1, Math.min(200, input.limit ?? 25))),
    });

    for (const [key, value] of Object.entries(input.filters ?? {})) {
      const primitive = toPrimitiveString(value);
      if (primitive) {
        params.set(key, primitive);
      }
    }

    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName)}?${params.toString()}`,
      method: 'GET',
    });

    const filtered = extractListItems(input.moduleName, payload)
      .filter((item) => itemMatchesQuery(item, input.query))
      .slice(0, Math.max(1, Math.min(200, input.limit ?? 25)));

    return {
      organizationId,
      items: filtered,
      payload,
    };
  }

  async getRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    recordId: string;
    organizationId?: string;
  }): Promise<{ organizationId: string; record: Record<string, unknown>; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName, input.recordId)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'GET',
    });

    return {
      organizationId,
      record: extractSingleItem(input.moduleName, payload),
      payload,
    };
  }

  async createRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    organizationId?: string;
    body: Record<string, unknown>;
  }): Promise<{ organizationId: string; record: Record<string, unknown>; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'POST',
      body: input.body,
    });

    return {
      organizationId,
      record: extractSingleItem(input.moduleName, payload),
      payload,
    };
  }

  async updateRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    recordId: string;
    organizationId?: string;
    body: Record<string, unknown>;
  }): Promise<{ organizationId: string; record: Record<string, unknown>; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName, input.recordId)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'PUT',
      body: input.body,
    });

    return {
      organizationId,
      record: extractSingleItem(input.moduleName, payload),
      payload,
    };
  }

  async deleteRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: ZohoBooksModule;
    recordId: string;
    organizationId?: string;
  }): Promise<{ organizationId: string; payload: ZohoBooksResponse }> {
    const environment = input.environment ?? 'prod';
    const organizationId = await this.resolveOrganizationId({
      companyId: input.companyId,
      environment,
      preferredOrganizationId: input.organizationId,
    });
    const payload = await this.requestWithRefresh<ZohoBooksResponse>({
      companyId: input.companyId,
      environment,
      path: `${buildModulePath(input.moduleName, input.recordId)}?organization_id=${encodeURIComponent(organizationId)}`,
      method: 'DELETE',
    });

    return {
      organizationId,
      payload,
    };
  }

  private async resolveOrganizationId(input: {
    companyId: string;
    environment: string;
    preferredOrganizationId?: string;
  }): Promise<string> {
    const preferred = asString(input.preferredOrganizationId);
    if (preferred) {
      return preferred;
    }

    const connection = await prisma.zohoConnection.findUnique({
      where: {
        companyId_environment: {
          companyId: input.companyId,
          environment: input.environment,
        },
      },
    });

    const metadata = tokenMetadataToRecord(connection?.tokenMetadata);
    const fromMetadata = readOrganizationIdFromMetadata(metadata);
    if (fromMetadata) {
      return fromMetadata;
    }

    const organizations = await this.listOrganizations({
      companyId: input.companyId,
      environment: input.environment,
    });

    const defaultOrg = organizations.find((organization) => organization.isDefault);
    const resolved = defaultOrg?.organizationId
      ?? (organizations.length === 1 ? organizations[0]?.organizationId : undefined);

    if (!resolved) {
      throw new ZohoIntegrationError({
        message: 'Zoho Books organization is not configured. Connect a default Books organization or store organizationId in the Zoho connection metadata.',
        code: 'schema_mismatch',
        retriable: false,
      });
    }

    if (connection) {
      await prisma.zohoConnection.update({
        where: { id: connection.id },
        data: {
          tokenMetadata: {
            ...(metadata ?? {}),
            organizationId: resolved,
          },
        },
      });
    }

    return resolved;
  }

  private async requestWithRefresh<T>(input: {
    companyId: string;
    environment: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown>;
  }): Promise<T> {
    const token = await this.tokenService.getValidAccessToken(input.companyId, input.environment);
    try {
      return await this.httpClient.requestJson<T>({
        base: 'api',
        path: input.path,
        method: input.method,
        body: input.body,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
      });
    } catch (error) {
      const isAuthError = error instanceof ZohoIntegrationError && error.code === 'auth_failed';
      if (!isAuthError) {
        throw error;
      }

      const refreshedToken = await this.tokenService.forceRefresh(input.companyId, input.environment);
      return this.httpClient.requestJson<T>({
        base: 'api',
        path: input.path,
        method: input.method,
        body: input.body,
        headers: {
          Authorization: `Zoho-oauthtoken ${refreshedToken}`,
        },
        retry: {
          maxAttempts: 1,
          baseDelayMs: 0,
        },
      });
    }
  }
}

export const zohoBooksClient = new ZohoBooksClient();
