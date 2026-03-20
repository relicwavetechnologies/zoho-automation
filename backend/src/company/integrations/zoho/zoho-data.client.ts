import { Buffer } from 'buffer';

import { logger } from '../../../utils/logger';
import { ZohoIntegrationError } from './zoho.errors';
import { normalizeEmail, payloadReferencesEmail } from './zoho-email-scope';
import { zohoHttpClient, ZohoHttpClient, type ZohoRawResponse } from './zoho-http.client';
import { zohoTokenService, ZohoTokenService } from './zoho-token.service';

export type ZohoSourceType = 'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket';

export type ZohoHistoricalPageResult = {
  records: Array<{
    sourceType: ZohoSourceType;
    sourceId: string;
    payload: Record<string, unknown>;
  }>;
  nextCursor?: string;
  total?: number;
  warnings?: ZohoDataWarning[];
};

export type ZohoDataWarning = {
  code: 'module_skipped' | 'predicate_invalid';
  message: string;
  moduleName: string;
  sourceType: ZohoSourceType;
  statusCode?: number;
};

type ZohoCrmSortBy = 'id' | 'Created_Time' | 'Modified_Time';
type ZohoCrmSortOrder = 'asc' | 'desc';

type CursorState = {
  moduleIndex?: number;
  page: number;
  sourceType?: ZohoSourceType;
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

type ZohoAttachmentListResponse = {
  data?: Array<Record<string, unknown>>;
  info?: {
    more_records?: boolean;
    count?: number;
  };
};

type ZohoCoqlResponse = {
  data?: Array<Record<string, unknown>>;
  info?: {
    more_records?: boolean;
    count?: number;
  };
};

type ZohoFieldMetaResponse = {
  fields?: Array<Record<string, unknown>>;
};

const MODULES: Array<{ sourceType: ZohoSourceType; moduleName: string }> = [
  { sourceType: 'zoho_lead', moduleName: 'Leads' },
  { sourceType: 'zoho_contact', moduleName: 'Contacts' },
  { sourceType: 'zoho_account', moduleName: 'Accounts' },
  { sourceType: 'zoho_deal', moduleName: 'Deals' },
  { sourceType: 'zoho_ticket', moduleName: 'Cases' },
];

const parseCursor = (cursor?: string): CursorState => {
  if (!cursor) {
    return { moduleIndex: 0, page: 1 };
  }

  try {
    const parsed = JSON.parse(cursor) as CursorState;
    const moduleIndex = parsed.moduleIndex;
    if (
      typeof moduleIndex === 'number' &&
      Number.isInteger(moduleIndex) &&
      moduleIndex >= 0 &&
      moduleIndex < MODULES.length &&
      Number.isInteger(parsed.page) &&
      parsed.page >= 1
    ) {
      return parsed;
    }
    if (
      parsed.sourceType &&
      MODULES.some((moduleDef) => moduleDef.sourceType === parsed.sourceType) &&
      Number.isInteger(parsed.page) &&
      parsed.page >= 1
    ) {
      return {
        sourceType: parsed.sourceType,
        page: parsed.page,
      };
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

const ensureModuleName = (moduleName?: string): string => {
  const trimmed = readString(moduleName);
  if (!trimmed) {
    throw new ZohoIntegrationError({
      message: 'Zoho module name is required',
      code: 'schema_mismatch',
      retriable: false,
    });
  }
  return trimmed;
};

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const escapeCoqlLiteral = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const PREDICATE_VALIDATION_EMAIL = 'scope-validation@example.invalid';

const readFieldRows = (payload: ZohoFieldMetaResponse): Array<Record<string, unknown>> =>
  Array.isArray(payload.fields) ? payload.fields : [];

const isEmailField = (field: Record<string, unknown>): boolean => {
  const dataType = readString(field.data_type)?.toLowerCase();
  const apiName = readString(field.api_name)?.toLowerCase();
  return dataType === 'email' || (typeof apiName === 'string' && apiName.includes('email'));
};

const isLookupField = (field: Record<string, unknown>): boolean => {
  const dataType = readString(field.data_type)?.toLowerCase();
  return dataType === 'lookup' || dataType === 'ownerlookup';
};

const readLookupTarget = (field: Record<string, unknown>): string | undefined => {
  const lookup = field.lookup;
  if (!lookup || typeof lookup !== 'object') {
    return undefined;
  }
  const lookupRecord = lookup as Record<string, unknown>;
  const nestedModule = lookupRecord.module;
  if (nestedModule && typeof nestedModule === 'object') {
    const nested = nestedModule as Record<string, unknown>;
    return readString(nested.api_name) ?? readString(nested.name);
  }
  return readString(lookupRecord.module) ?? readString(lookupRecord.api_name) ?? readString(lookupRecord.name);
};

const isSafeLookupTargetForEmail = (value: string): boolean =>
  /(users?|contacts?|leads?)/i.test(value);

const buildEmailPredicatesFromFields = (fields: Array<Record<string, unknown>>): string[] => {
  const predicates = new Set<string>();

  for (const field of fields) {
    const apiName = readString(field.api_name);
    if (!apiName) {
      continue;
    }

    if (isEmailField(field)) {
      predicates.add(apiName);
      continue;
    }

    if (!isLookupField(field)) {
      continue;
    }

    const target = readLookupTarget(field);
    if (!target || !isSafeLookupTargetForEmail(target)) {
      continue;
    }

    // Email field names differ by lookup target; keep conservative variants.
    predicates.add(`${apiName}.Email`);
    predicates.add(`${apiName}.email`);
  }

  return [...predicates];
};

export class ZohoDataClient {
  private readonly httpClient: ZohoHttpClient;

  private readonly tokenService: Pick<ZohoTokenService, 'getValidAccessToken' | 'forceRefresh'>
    & Partial<Pick<ZohoTokenService, 'resolveCredentials'>>;

  private readonly moduleEmailPredicateCache = new Map<string, string[]>();

  constructor(options: ZohoDataClientOptions = {}) {
    this.httpClient = options.httpClient ?? zohoHttpClient;
    this.tokenService = options.tokenService ?? zohoTokenService;
  }

  async fetchHistoricalPage(input: {
    companyId: string;
    environment?: string;
    cursor?: string;
    pageSize: number;
    sourceType?: ZohoSourceType;
    sortBy?: 'id' | 'Created_Time' | 'Modified_Time';
    sortOrder?: 'asc' | 'desc';
  }): Promise<ZohoHistoricalPageResult> {
    const environment = input.environment ?? 'prod';
    const cursor = parseCursor(input.cursor);
    const requestedModule = input.sourceType
      ? ensureModule(input.sourceType)
      : cursor.sourceType
        ? ensureModule(cursor.sourceType)
        : MODULES[cursor.moduleIndex ?? 0] ?? MODULES[0];

    let payload: ZohoListResponse;
    try {
      payload = await this.requestZohoListWithRefresh({
        companyId: input.companyId,
        environment,
        moduleName: requestedModule.moduleName,
        page: cursor.page,
        perPage: Math.max(1, Math.min(200, input.pageSize)),
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
      });
    } catch (error) {
      const moduleRejected =
        error instanceof ZohoIntegrationError
        && error.statusCode === 400;
      if (!moduleRejected) {
        throw error;
      }

      const fallbackCursor = input.sourceType || cursor.sourceType
        ? undefined
        : (cursor.moduleIndex ?? 0) + 1 < MODULES.length
          ? encodeCursor({ moduleIndex: (cursor.moduleIndex ?? 0) + 1, page: 1 })
          : undefined;
      logger.warn('zoho.historical.module.skipped', {
        companyId: input.companyId,
        environment,
        module: requestedModule.moduleName,
        sourceType: requestedModule.sourceType,
        page: cursor.page,
        reason: error.message,
        nextCursor: fallbackCursor,
      });
      return {
        records: [],
        nextCursor: fallbackCursor,
        total: 0,
        warnings: [{
          code: 'module_skipped',
          message: error.message,
          moduleName: requestedModule.moduleName,
          sourceType: requestedModule.sourceType,
          statusCode: error.statusCode,
        }],
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
        sourceType: requestedModule.sourceType,
        sourceId,
        payload: record,
      };
    });

    const hasMore = Boolean(payload.info?.more_records);
    const nextCursor = input.sourceType || cursor.sourceType
      ? hasMore
        ? encodeCursor({ sourceType: requestedModule.sourceType, page: cursor.page + 1 })
        : undefined
      : hasMore
        ? encodeCursor({ moduleIndex: cursor.moduleIndex ?? 0, page: cursor.page + 1 })
        : (cursor.moduleIndex ?? 0) + 1 < MODULES.length
          ? encodeCursor({ moduleIndex: (cursor.moduleIndex ?? 0) + 1, page: 1 })
          : undefined;

    logger.success('zoho.historical.page.fetched', {
      companyId: input.companyId,
      environment,
      module: requestedModule.moduleName,
      sourceType: requestedModule.sourceType,
      page: cursor.page,
      count: records.length,
      hasMore,
      nextCursor,
    });

    return {
      records,
      nextCursor,
      total: payload.info?.count,
      warnings: [],
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

  async fetchUserScopedRecords(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    requesterEmail: string;
    limit: number;
    maxPages: number;
    sortBy?: 'Created_Time' | 'Modified_Time';
    sortOrder?: 'asc' | 'desc';
  }): Promise<Array<{ sourceType: ZohoSourceType; sourceId: string; payload: Record<string, unknown> }>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const normalizedRequesterEmail = normalizeEmail(input.requesterEmail);
    if (!normalizedRequesterEmail) {
      throw new ZohoIntegrationError({
        message: 'Requester email is required for strict user-scoped Zoho reads',
        code: 'auth_failed',
        retriable: false,
      });
    }

    const emailPaths = await this.resolveModuleEmailPredicates({
      companyId: input.companyId,
      environment,
      moduleName: moduleDef.moduleName,
    });
    if (emailPaths.length === 0) {
      throw new ZohoIntegrationError({
        message: `Strict user scope cannot be enforced for module ${moduleDef.moduleName}: no safe email fields found`,
        code: 'schema_mismatch',
        retriable: false,
      });
    }

    const records: Array<{ sourceType: ZohoSourceType; sourceId: string; payload: Record<string, unknown> }> = [];
    const seenSourceIds = new Set<string>();
    const perPage = Math.max(1, Math.min(50, Math.max(10, input.limit * 2)));
    const sortBy = input.sortBy ?? 'Modified_Time';
    const sortOrder = input.sortOrder ?? 'desc';
    let lastPredicateError: ZohoIntegrationError | null = null;
    let anyPredicateSucceeded = false;

    for (const emailPath of emailPaths) {
      for (let page = 1; page <= Math.max(1, input.maxPages) && records.length < input.limit; page += 1) {
        const offset = (page - 1) * perPage;
        const selectQuery =
          `select id from ${moduleDef.moduleName} where ` +
          `${emailPath} = '${escapeCoqlLiteral(normalizedRequesterEmail)}' ` +
          `order by ${sortBy} ${sortOrder} limit ${offset}, ${perPage}`;

        let coql: ZohoCoqlResponse;
        try {
          coql = await this.requestWithRefresh<ZohoCoqlResponse>({
            companyId: input.companyId,
            environment,
            path: '/crm/v8/coql',
            method: 'POST',
            body: { select_query: selectQuery },
          });
          anyPredicateSucceeded = true;
        } catch (error) {
          if (error instanceof ZohoIntegrationError) {
            lastPredicateError = error;
            logger.warn('zoho.user_scope.predicate_failed', {
              companyId: input.companyId,
              environment,
              moduleName: moduleDef.moduleName,
              sourceType: input.sourceType,
              emailPath,
              code: error.code,
              statusCode: error.statusCode,
              reason: error.message,
            });
            break;
          }
          throw error;
        }

        const ids = (coql.data ?? [])
          .map((row) => coerceString(row.id))
          .filter((id): id is string => Boolean(id));

        if (ids.length === 0) {
          break;
        }

        for (const sourceId of ids) {
          if (records.length >= input.limit || seenSourceIds.has(sourceId)) {
            continue;
          }

          const payload = await this.fetchRecordBySource({
            companyId: input.companyId,
            environment,
            sourceType: input.sourceType,
            sourceId,
          });
          if (!payload) {
            continue;
          }
          if (!payloadReferencesEmail(payload, normalizedRequesterEmail)) {
            continue;
          }

          seenSourceIds.add(sourceId);
          records.push({
            sourceType: input.sourceType,
            sourceId,
            payload,
          });
        }

        if (ids.length < perPage) {
          break;
        }
      }
    }

    if (!anyPredicateSucceeded && lastPredicateError) {
      throw new ZohoIntegrationError({
        message: `Strict user scope could not query module ${moduleDef.moduleName}: ${lastPredicateError.message}`,
        code: lastPredicateError.code,
        retriable: lastPredicateError.retriable,
        statusCode: lastPredicateError.statusCode,
      });
    }

    return records;
  }

  async createRecord(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    fields: Record<string, unknown>;
    trigger?: string[];
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${moduleDef.moduleName}`,
      method: 'POST',
      body: {
        data: [input.fields],
        ...(input.trigger && input.trigger.length > 0 ? { trigger: input.trigger } : {}),
      },
    });
    return response.data?.[0] ?? {};
  }

  async listModuleRecords(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    page?: number;
    perPage?: number;
    sortBy?: ZohoCrmSortBy;
    sortOrder?: ZohoCrmSortOrder;
    filters?: Record<string, unknown>;
  }): Promise<Array<Record<string, unknown>>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const params = new URLSearchParams({
      page: String(Math.max(1, input.page ?? 1)),
      per_page: String(Math.max(1, Math.min(200, input.perPage ?? 50))),
    });
    if (input.sortBy) {
      params.set('sort_by', input.sortBy);
    }
    if (input.sortOrder) {
      params.set('sort_order', input.sortOrder);
    }
    for (const [key, value] of Object.entries(input.filters ?? {})) {
      const primitive = coerceString(value);
      if (primitive) {
        params.set(key, primitive);
      }
    }
    const response = await this.requestWithRefresh<ZohoListResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${encodeURIComponent(moduleName)}?${params.toString()}`,
      method: 'GET',
    });
    return response.data ?? [];
  }

  async getModuleRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
  }): Promise<Record<string, unknown> | null> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}`,
      method: 'GET',
    });
    return response.data?.[0] ?? null;
  }

  async createModuleRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    fields: Record<string, unknown>;
    trigger?: string[];
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${encodeURIComponent(moduleName)}`,
      method: 'POST',
      body: {
        data: [input.fields],
        ...(input.trigger && input.trigger.length > 0 ? { trigger: input.trigger } : {}),
      },
    });
    return response.data?.[0] ?? {};
  }

  async updateModuleRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    fields: Record<string, unknown>;
    trigger?: string[];
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}`,
      method: 'PATCH',
      body: {
        data: [input.fields],
        ...(input.trigger && input.trigger.length > 0 ? { trigger: input.trigger } : {}),
      },
    });
    return response.data?.[0] ?? {};
  }

  async deleteModuleRecord(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
  }): Promise<void> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    await this.requestWithRefresh<Record<string, unknown>>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}`,
      method: 'DELETE',
    });
  }

  async updateRecord(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    fields: Record<string, unknown>;
    trigger?: string[];
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}`,
      method: 'PATCH',
      body: {
        data: [input.fields],
        ...(input.trigger && input.trigger.length > 0 ? { trigger: input.trigger } : {}),
      },
    });
    return response.data?.[0] ?? {};
  }

  async deleteRecord(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
  }): Promise<void> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    await this.requestWithRefresh<Record<string, unknown>>({
      companyId: input.companyId,
      environment,
      path: `/crm/v2/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}`,
      method: 'DELETE',
    });
  }

  async listNotes(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    page?: number;
    perPage?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const params = new URLSearchParams({
      page: String(Math.max(1, input.page ?? 1)),
      per_page: String(Math.max(1, Math.min(200, input.perPage ?? 50))),
    });
    const response = await this.requestWithRefresh<ZohoListResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}/Notes?${params.toString()}`,
      method: 'GET',
    });
    return response.data ?? [];
  }

  async listModuleNotes(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    page?: number;
    perPage?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const params = new URLSearchParams({
      page: String(Math.max(1, input.page ?? 1)),
      per_page: String(Math.max(1, Math.min(200, input.perPage ?? 50))),
    });
    const response = await this.requestWithRefresh<ZohoListResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}/Notes?${params.toString()}`,
      method: 'GET',
    });
    return response.data ?? [];
  }

  async getNote(input: {
    companyId: string;
    environment?: string;
    noteId: string;
  }): Promise<Record<string, unknown> | null> {
    const environment = input.environment ?? 'prod';
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/Notes/${encodeURIComponent(input.noteId)}`,
      method: 'GET',
    });
    return response.data?.[0] ?? null;
  }

  async createNote(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    fields: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}/Notes`,
      method: 'POST',
      body: {
        data: [input.fields],
      },
    });
    return response.data?.[0] ?? {};
  }

  async createModuleNote(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    fields: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}/Notes`,
      method: 'POST',
      body: {
        data: [input.fields],
      },
    });
    return response.data?.[0] ?? {};
  }

  async updateNote(input: {
    companyId: string;
    environment?: string;
    noteId: string;
    fields: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/Notes/${encodeURIComponent(input.noteId)}`,
      method: 'PATCH',
      body: {
        data: [input.fields],
      },
    });
    return response.data?.[0] ?? {};
  }

  async deleteNote(input: {
    companyId: string;
    environment?: string;
    noteId: string;
  }): Promise<void> {
    const environment = input.environment ?? 'prod';
    await this.requestWithRefresh<Record<string, unknown>>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/Notes/${encodeURIComponent(input.noteId)}`,
      method: 'DELETE',
    });
  }

  async listAttachments(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    page?: number;
    perPage?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const params = new URLSearchParams({
      page: String(Math.max(1, input.page ?? 1)),
      per_page: String(Math.max(1, Math.min(200, input.perPage ?? 50))),
    });
    const response = await this.requestWithRefresh<ZohoAttachmentListResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}/Attachments?${params.toString()}`,
      method: 'GET',
    });
    return response.data ?? [];
  }

  async listModuleAttachments(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    page?: number;
    perPage?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const params = new URLSearchParams({
      page: String(Math.max(1, input.page ?? 1)),
      per_page: String(Math.max(1, Math.min(200, input.perPage ?? 50))),
    });
    const response = await this.requestWithRefresh<ZohoAttachmentListResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}/Attachments?${params.toString()}`,
      method: 'GET',
    });
    return response.data ?? [];
  }

  async getAttachmentContent(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    attachmentId: string;
  }): Promise<ZohoRawResponse> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    return this.requestRawWithRefresh({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}/Attachments/${encodeURIComponent(input.attachmentId)}`,
      method: 'GET',
    });
  }

  async getModuleAttachmentContent(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    attachmentId: string;
  }): Promise<ZohoRawResponse> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    return this.requestRawWithRefresh({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}/Attachments/${encodeURIComponent(input.attachmentId)}`,
      method: 'GET',
    });
  }

  async listModuleFields(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
  }): Promise<Array<Record<string, unknown>>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const payload = await this.requestWithRefresh<ZohoFieldMetaResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/settings/fields?module=${encodeURIComponent(moduleName)}`,
      method: 'GET',
    });
    return readFieldRows(payload);
  }

  async uploadAttachment(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    fileName?: string;
    contentType?: string;
    contentBase64?: string;
    attachmentUrl?: string;
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    const formData = new FormData();

    if (readString(input.attachmentUrl)) {
      formData.append('attachmentUrl', input.attachmentUrl as string);
    } else {
      const contentBase64 = readString(input.contentBase64);
      const fileName = readString(input.fileName);
      if (!contentBase64 || !fileName) {
        throw new ZohoIntegrationError({
          message: 'uploadAttachment requires either attachmentUrl or both fileName and contentBase64.',
          code: 'schema_mismatch',
          retriable: false,
        });
      }
      const mimeType = readString(input.contentType) ?? 'application/octet-stream';
      const fileBytes = Uint8Array.from(Buffer.from(contentBase64, 'base64'));
      formData.append('file', new Blob([fileBytes], { type: mimeType }), fileName);
    }

    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}/Attachments`,
      method: 'POST',
      body: formData,
    });
    return response.data?.[0] ?? {};
  }

  async uploadModuleAttachment(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    fileName?: string;
    contentType?: string;
    contentBase64?: string;
    attachmentUrl?: string;
  }): Promise<Record<string, unknown>> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    const formData = new FormData();

    if (readString(input.attachmentUrl)) {
      formData.append('attachmentUrl', input.attachmentUrl as string);
    } else {
      const contentBase64 = readString(input.contentBase64);
      const fileName = readString(input.fileName);
      if (!contentBase64 || !fileName) {
        throw new ZohoIntegrationError({
          message: 'uploadAttachment requires either attachmentUrl or both fileName and contentBase64.',
          code: 'schema_mismatch',
          retriable: false,
        });
      }
      const mimeType = readString(input.contentType) ?? 'application/octet-stream';
      const fileBytes = Uint8Array.from(Buffer.from(contentBase64, 'base64'));
      formData.append('file', new Blob([fileBytes], { type: mimeType }), fileName);
    }

    const response = await this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}/Attachments`,
      method: 'POST',
      body: formData,
    });
    return response.data?.[0] ?? {};
  }

  async deleteAttachment(input: {
    companyId: string;
    environment?: string;
    sourceType: ZohoSourceType;
    sourceId: string;
    attachmentId: string;
  }): Promise<void> {
    const environment = input.environment ?? 'prod';
    const moduleDef = ensureModule(input.sourceType);
    await this.requestWithRefresh<Record<string, unknown>>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${moduleDef.moduleName}/${encodeURIComponent(input.sourceId)}/Attachments/${encodeURIComponent(input.attachmentId)}`,
      method: 'DELETE',
    });
  }

  async deleteModuleAttachment(input: {
    companyId: string;
    environment?: string;
    moduleName: string;
    recordId: string;
    attachmentId: string;
  }): Promise<void> {
    const environment = input.environment ?? 'prod';
    const moduleName = ensureModuleName(input.moduleName);
    await this.requestWithRefresh<Record<string, unknown>>({
      companyId: input.companyId,
      environment,
      path: `/crm/v8/${encodeURIComponent(moduleName)}/${encodeURIComponent(input.recordId)}/Attachments/${encodeURIComponent(input.attachmentId)}`,
      method: 'DELETE',
    });
  }

  private async requestZohoListWithRefresh(input: {
    companyId: string;
    environment: string;
    moduleName: string;
    page: number;
    perPage: number;
    sortBy?: 'id' | 'Created_Time' | 'Modified_Time';
    sortOrder?: 'asc' | 'desc';
  }): Promise<ZohoListResponse> {
    const params = new URLSearchParams({
      page: String(input.page),
      per_page: String(input.perPage),
    });
    if (input.sortBy) {
      params.set('sort_by', input.sortBy);
    }
    if (input.sortOrder) {
      params.set('sort_order', input.sortOrder);
    }
    const path = `/crm/v2/${input.moduleName}?${params.toString()}`;
    return this.requestWithRefresh<ZohoListResponse>({
      companyId: input.companyId,
      environment: input.environment,
      path,
      method: 'GET',
    });
  }

  private async requestZohoSingleWithRefresh(input: {
    companyId: string;
    environment: string;
    path: string;
  }): Promise<ZohoSingleResponse> {
    return this.requestWithRefresh<ZohoSingleResponse>({
      companyId: input.companyId,
      environment: input.environment,
      path: input.path,
      method: 'GET',
    });
  }

  private async requestWithRefresh<T>(input: {
    companyId: string;
    environment: string;
    path: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: URLSearchParams | Record<string, unknown> | FormData;
  }): Promise<T> {
    const scopedClient = await this.resolveApiClient(input.companyId);
    const token = await this.tokenService.getValidAccessToken(input.companyId, input.environment);
    try {
      return await scopedClient.requestJson<T>({
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

      logger.warn('zoho.api.retry_after_token_refresh', {
        companyId: input.companyId,
        environment: input.environment,
        path: input.path,
      });

      const refreshedToken = await this.tokenService.forceRefresh(input.companyId, input.environment);
      return scopedClient.requestJson<T>({
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

  private async requestRawWithRefresh(input: {
    companyId: string;
    environment: string;
    path: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: URLSearchParams | Record<string, unknown> | FormData;
  }): Promise<ZohoRawResponse> {
    const scopedClient = await this.resolveApiClient(input.companyId);
    const token = await this.tokenService.getValidAccessToken(input.companyId, input.environment);
    try {
      return await scopedClient.requestRaw({
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

      logger.warn('zoho.api.retry_after_token_refresh', {
        companyId: input.companyId,
        environment: input.environment,
        path: input.path,
      });

      const refreshedToken = await this.tokenService.forceRefresh(input.companyId, input.environment);
      return scopedClient.requestRaw({
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

  private async resolveModuleEmailPredicates(input: {
    companyId: string;
    environment: string;
    moduleName: string;
  }): Promise<string[]> {
    const cacheKey = `${input.companyId}:${input.environment}:${input.moduleName}`;
    const cached = this.moduleEmailPredicateCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const path = `/crm/v8/settings/fields?module=${encodeURIComponent(input.moduleName)}`;
    const payload = await this.requestWithRefresh<ZohoFieldMetaResponse>({
      companyId: input.companyId,
      environment: input.environment,
      path,
      method: 'GET',
    });
    const predicates = buildEmailPredicatesFromFields(readFieldRows(payload));
    const validated = await this.validateEmailPredicates({
      companyId: input.companyId,
      environment: input.environment,
      moduleName: input.moduleName,
      predicates,
    });
    this.moduleEmailPredicateCache.set(cacheKey, validated);
    return validated;
  }

  private async validateEmailPredicates(input: {
    companyId: string;
    environment: string;
    moduleName: string;
    predicates: string[];
  }): Promise<string[]> {
    const validPredicates: string[] = [];

    for (const predicate of input.predicates) {
      const selectQuery =
        `select id from ${input.moduleName} where ` +
        `${predicate} = '${escapeCoqlLiteral(PREDICATE_VALIDATION_EMAIL)}' limit 0, 1`;
      try {
        await this.requestWithRefresh<ZohoCoqlResponse>({
          companyId: input.companyId,
          environment: input.environment,
          path: '/crm/v8/coql',
          method: 'POST',
          body: { select_query: selectQuery },
        });
        validPredicates.push(predicate);
      } catch (error) {
        if (!(error instanceof ZohoIntegrationError)) {
          throw error;
        }
        logger.warn('zoho.user_scope.predicate_invalid', {
          companyId: input.companyId,
          environment: input.environment,
          moduleName: input.moduleName,
          predicate,
          code: error.code,
          statusCode: error.statusCode,
          reason: error.message,
        });
      }
    }

    return validPredicates;
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
