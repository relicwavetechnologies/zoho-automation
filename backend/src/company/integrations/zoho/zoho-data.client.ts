import { logger } from '../../../utils/logger';
import { ZohoIntegrationError } from './zoho.errors';
import { zohoHttpClient, ZohoHttpClient } from './zoho-http.client';
import { zohoTokenService, ZohoTokenService } from './zoho-token.service';

export type ZohoSourceType = 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';

export type ZohoHistoricalPageResult = {
  records: Array<{
    sourceType: ZohoSourceType;
    sourceId: string;
    payload: Record<string, unknown>;
  }>;
  nextCursor?: string;
  total?: number;
};

type CursorState = {
  moduleIndex: number;
  page: number;
};

type ZohoDataClientOptions = {
  httpClient?: ZohoHttpClient;
  tokenService?: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>
    & Partial<Pick<ZohoTokenService, 'resolveCredentials'>>;
};

type ZohoListResponse = {
  data?: Array<Record<string, unknown>>;
  info?: {
    more_records?: boolean;
    count?: number;
  };
  code?: string;
  message?: string;
};

type ZohoSingleResponse = {
  data?: Array<Record<string, unknown>>;
};

const MODULES: Array<{ sourceType: ZohoSourceType; moduleName: string }> = [
  { sourceType: 'zoho_contact', moduleName: 'Contacts' },
  { sourceType: 'zoho_deal', moduleName: 'Deals' },
  { sourceType: 'zoho_ticket', moduleName: 'Cases' },
];

const parseCursor = (cursor?: string): CursorState => {
  if (!cursor) {
    return { moduleIndex: 0, page: 1 };
  }

  try {
    const parsed = JSON.parse(cursor) as CursorState;
    if (
      Number.isInteger(parsed.moduleIndex) &&
      parsed.moduleIndex >= 0 &&
      parsed.moduleIndex < MODULES.length &&
      Number.isInteger(parsed.page) &&
      parsed.page >= 1
    ) {
      return parsed;
    }
  } catch {
    return { moduleIndex: 0, page: 1 };
  }

  return { moduleIndex: 0, page: 1 };
};

const encodeCursor = (state: CursorState): string => JSON.stringify(state);

const coerceString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

const ensureModule = (sourceType: ZohoSourceType): { sourceType: ZohoSourceType; moduleName: string } => {
  const found = MODULES.find((moduleDef) => moduleDef.sourceType === sourceType);
  if (!found) {
    throw new ZohoIntegrationError({
      message: `Unsupported Zoho source type: ${sourceType}`,
      code: 'schema_mismatch',
      retriable: false,
    });
  }

  return found;
};

export class ZohoDataClient {
  private readonly httpClient: ZohoHttpClient;

  private readonly tokenService: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>
    & Partial<Pick<ZohoTokenService, 'resolveCredentials'>>;

  constructor(options: ZohoDataClientOptions = {}) {
    this.httpClient = options.httpClient ?? zohoHttpClient;
    this.tokenService = options.tokenService ?? zohoTokenService;
  }

  async fetchHistoricalPage(input: {
    companyId: string;
    environment?: string;
    cursor?: string;
    pageSize: number;
  }): Promise<ZohoHistoricalPageResult> {
    const environment = input.environment ?? 'prod';
    const cursor = parseCursor(input.cursor);
    const moduleDef = MODULES[cursor.moduleIndex] ?? MODULES[0];

    let payload: ZohoListResponse;
    try {
      payload = await this.requestZohoListWithRefresh({
        companyId: input.companyId,
        environment,
        moduleName: moduleDef.moduleName,
        page: cursor.page,
        perPage: Math.max(1, Math.min(200, input.pageSize)),
      });
    } catch (error) {
      const moduleRejected =
        error instanceof ZohoIntegrationError
        && error.statusCode === 400;
      if (!moduleRejected) {
        throw error;
      }

      const fallbackCursor = cursor.moduleIndex + 1 < MODULES.length
        ? encodeCursor({ moduleIndex: cursor.moduleIndex + 1, page: 1 })
        : undefined;
      logger.warn('zoho.historical.module.skipped', {
        companyId: input.companyId,
        environment,
        module: moduleDef.moduleName,
        sourceType: moduleDef.sourceType,
        page: cursor.page,
        reason: error.message,
        nextCursor: fallbackCursor,
      });
      return {
        records: [],
        nextCursor: fallbackCursor,
        total: 0,
      };
    }

    const records = (payload.data ?? []).map((record) => {
      const sourceId = coerceString(record.id);
      if (!sourceId) {
        throw new ZohoIntegrationError({
          message: 'Zoho module payload missing id field',
          code: 'schema_mismatch',
          retriable: false,
        });
      }

      return {
        sourceType: moduleDef.sourceType,
        sourceId,
        payload: record,
      };
    });

    const hasMore = Boolean(payload.info?.more_records);
    const nextCursor = hasMore
      ? encodeCursor({ moduleIndex: cursor.moduleIndex, page: cursor.page + 1 })
      : cursor.moduleIndex + 1 < MODULES.length
        ? encodeCursor({ moduleIndex: cursor.moduleIndex + 1, page: 1 })
        : undefined;

    logger.success('zoho.historical.page.fetched', {
      companyId: input.companyId,
      environment,
      module: moduleDef.moduleName,
      sourceType: moduleDef.sourceType,
      page: cursor.page,
      count: records.length,
      hasMore,
      nextCursor,
    });

    return {
      records,
      nextCursor,
      total: payload.info?.count,
    };
  }

  async fetchRecordBySource(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
  }): Promise<Record<string, unknown> | null> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);

    const response = await this.requestZohoSingleWithRefresh({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}`,
    });

    const record = response.data?.[0];
    return record ?? null;
  }

  private async requestZohoListWithRefresh(input: {
    companyId: string;
    environment: string;
    moduleName: string;
    page: number;
    perPage: number;
  }): Promise<ZohoListResponse> {
    const path = `/crm/v2/${input.moduleName}?page=${input.page}&per_page=${input.perPage}`;
    return this.requestWithRefresh<ZohoListResponse>(input.companyId, input.environment, path);
  }

  private async requestZohoSingleWithRefresh(input: {
    companyId: string;
    environment: string;
    path: string;
  }): Promise<ZohoSingleResponse> {
    return this.requestWithRefresh<ZohoSingleResponse>(input.companyId, input.environment, input.path);
  }

  private async requestWithRefresh<T>(companyId: string, environment: string, path: string): Promise<T> {
    const scopedClient = await this.resolveApiClient(companyId);
    const token = await this.tokenService.getValidAccessToken(companyId, environment);
    try {
      return await scopedClient.requestJson<T>({
        base: 'api',
        path,
        method: 'GET',
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
      });
    } catch (error) {
      const isAuthError = error instanceof ZohoIntegrationError && error.code === 'auth_failed';
      if (!isAuthError) {
        throw error;
      }

      logger.warn('zoho.api.retry_after_token_refresh', {
        companyId,
        environment,
        path,
      });

      const refreshedToken = await this.tokenService.forceRefresh(companyId, environment);
      return scopedClient.requestJson<T>({
        base: 'api',
        path,
        method: 'GET',
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

  private async resolveApiClient(companyId: string): Promise<ZohoHttpClient> {
    if (!this.tokenService.resolveCredentials) {
      return this.httpClient;
    }

    const credentials = await this.tokenService.resolveCredentials(companyId);
    return credentials.httpClient ?? this.httpClient;
  }
}

export const zohoDataClient = new ZohoDataClient();

export const ZOHO_HISTORICAL_MODULES = MODULES;
export const ZOHO_DEFAULT_PAGE_SIZE = 200;
