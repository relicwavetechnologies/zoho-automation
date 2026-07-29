import {
  AIRTABLE_PRODUCTS,
  airtableScopeGroupsFor,
} from '../airtable/airtable-mcp-manifest';
import type {
  AirtableMcpPort,
  ResolveAirtableMcpConnection,
} from '../orchestration/tools/families/airtable-mcp.tool';
import type {
  ZohoBooksPaginatedClient,
  ZohoBooksModule,
} from '../../infrastructure/zoho/zoho-books-paginated.client';
import {
  type CurrencyConverter,
  getModuleSchema,
  injectSyntheticFields,
} from '../../infrastructure/zoho/zoho-books-schema.cache';
import type {
  DataExportPage,
  DataExportSourceAdapter,
} from './data-export.types';
import type { DataExportSource } from './data-export.types';

type AirtableSource = Extract<DataExportSource, { kind: 'airtable_records' }>;
type ZohoBooksSource = Extract<DataExportSource, { kind: 'zoho_books' }>;

const AIRTABLE_REST_KEYS = new Set(['baseId', 'tableId', 'fieldIds']);
const AIRTABLE_PAGE_LIMIT = 20_000;
const AIRTABLE_MCP_PAGE_SIZE = 1_000;
const ZOHO_PAGE_LIMIT = 1_000;

export class AirtableDataExportSource implements DataExportSourceAdapter<AirtableSource> {
  readonly kind = 'airtable_records' as const;

  constructor(private readonly getConnection: ResolveAirtableMcpConnection) {}

  async *read(source: AirtableSource, context: {
    readonly companyId: string;
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<DataExportPage> {
    const product = AIRTABLE_PRODUCTS.find((candidate) => candidate.toolId === source.toolId);
    if (!product || !product.operations.some((operation) =>
      operation.nativeTool === source.nativeTool && operation.action === 'read'
    )) {
      throw new Error('Airtable export source is not an approved record read');
    }
    const resolved = await this.getConnection({
      companyId: context.companyId,
      userId: context.userId,
      connectionId: source.connectionId,
      minimumAccess: 'read_only',
      requiredScopeGroups: airtableScopeGroupsFor(product, 'read'),
    });
    if (resolved.status !== 'resolved') {
      throw new Error('Airtable connection is no longer available for this company export');
    }

    const client = resolved.connection.client;
    const baseInput = { ...source.input };
    delete baseInput['cursor'];
    delete baseInput['pageSize'];
    delete baseInput['maxRecords'];
    const baseId = primitive(baseInput['baseId']);
    const tableId = primitive(baseInput['tableId']);
    const useRest = source.nativeTool === 'list_records_for_table'
      && Boolean(baseId && tableId && client.listRecordsPage)
      && Object.keys(baseInput).every((key) => AIRTABLE_REST_KEYS.has(key));
    const fieldNames = baseId && tableId
      ? await client.listFieldNamesForTable?.(baseId, tableId, context.signal) ?? new Map<string, string>()
      : new Map<string, string>();
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < AIRTABLE_PAGE_LIMIT; page += 1) {
      context.signal?.throwIfAborted();
      const result = useRest
        ? await client.listRecordsPage!({
            baseId: baseId!,
            tableId: tableId!,
            ...(Array.isArray(baseInput['fieldIds'])
              ? { fieldIds: baseInput['fieldIds'].filter((value): value is string => typeof value === 'string') }
              : {}),
            ...(cursor ? { offset: cursor } : {}),
          }, context.signal)
        : await client.callTool(source.nativeTool, {
            ...baseInput,
            pageSize: AIRTABLE_MCP_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }, {
            ...(context.signal ? { signal: context.signal } : {}),
            maxTotalTimeoutMs: 60_000,
          });
      if (!isRecord(result) || !Array.isArray(result['records'])) {
        throw new Error(`${source.nativeTool} returned an unexpected record response`);
      }
      const rows = result['records']
        .filter(isRecord)
        .map((record) => flattenAirtableRecord(record, fieldNames));
      const next = typeof result['nextCursor'] === 'string' && result['nextCursor'].trim()
        ? result['nextCursor']
        : undefined;
      const sourceTruncated = Boolean(next && (seenCursors.has(next) || page === AIRTABLE_PAGE_LIMIT - 1));
      yield {
        rows,
        ...(next ? { hasMore: true } : {}),
        ...(sourceTruncated ? { sourceTruncated: true } : {}),
      };
      if (!next || sourceTruncated) return;
      seenCursors.add(next);
      cursor = next;
    }
  }
}

export class ZohoBooksDataExportSource implements DataExportSourceAdapter<ZohoBooksSource> {
  readonly kind = 'zoho_books' as const;

  constructor(
    private readonly booksClient: ZohoBooksPaginatedClient,
    private readonly getCurrencyConverter?: () => Promise<CurrencyConverter>,
  ) {}

  async *read(source: ZohoBooksSource, context: {
    readonly companyId: string;
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<DataExportPage> {
    const filters = normalizeZohoFilters(source.filters);
    const statuses = statusValues(filters?.['status']);
    const seen = new Set<string>();
    const schema = getModuleSchema(source.module);
    const currencyConverter = await this.getCurrencyConverter?.();
    for (const [statusIndex, status] of statuses.entries()) {
      for (let page = 1; page <= ZOHO_PAGE_LIMIT; page += 1) {
        context.signal?.throwIfAborted();
        const result = await this.booksClient.listRecords({
          companyId: context.companyId,
          userId: context.userId,
          connectionId: source.connectionId,
          moduleName: source.module,
          ...(source.organizationId ? { organizationId: source.organizationId } : {}),
          ...(filters
            ? { filters: { ...filters, ...(status ? { status } : {}) } }
            : {}),
          ...(source.query ? { query: source.query } : {}),
          page,
          perPage: 200,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const unique = result.items.filter((item) => {
          const key = recordId(source.module, item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const sourceTruncated = result.hasMore && page === ZOHO_PAGE_LIMIT;
        const hasMore = result.hasMore || statusIndex < statuses.length - 1;
        yield {
          rows: injectSyntheticFields(unique, schema, currencyConverter),
          ...(hasMore ? { hasMore: true } : {}),
          ...(sourceTruncated ? { sourceTruncated: true } : {}),
        };
        if (!result.hasMore || sourceTruncated) break;
      }
    }
  }
}

function normalizeZohoFilters(
  filters: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!filters) return undefined;
  const normalized = { ...filters };
  for (const [canonical, provider] of [
    ['dateFrom', 'date_start'],
    ['dateTo', 'date_end'],
  ] as const) {
    const value = normalized[canonical];
    if (value === undefined) continue;
    if (normalized[provider] !== undefined) {
      throw new Error(`Zoho source filter cannot include both ${canonical} and ${provider}`);
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Zoho source filter ${canonical} must be a non-empty date string`);
    }
    normalized[provider] = value.trim();
    delete normalized[canonical];
  }
  return normalized;
}

function flattenAirtableRecord(
  record: Record<string, unknown>,
  fieldNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const fields = isRecord(record['fields'])
    ? record['fields']
    : isRecord(record['cellValuesByFieldId'])
      ? record['cellValuesByFieldId']
      : {};
  const row: Record<string, unknown> = {};
  const id = primitive(record['id']) ?? primitive(record['recordId']);
  if (id) row['Record ID'] = id;
  for (const [fieldId, value] of Object.entries(fields)) {
    row[fieldNames.get(fieldId) ?? fieldId] = value;
  }
  return row;
}

function statusValues(value: unknown): Array<string | undefined> {
  if (typeof value !== 'string' || !value.trim()) return [undefined];
  return value.split(',').map((status) => status.trim()).filter(Boolean);
}

function recordId(module: ZohoBooksModule, row: Record<string, unknown>): string {
  const singular = module.replace(/s$/, '');
  return primitive(row[`${singular}_id`])
    ?? primitive(row['payment_id'])
    ?? primitive(row['transaction_id'])
    ?? primitive(row['account_id'])
    ?? primitive(row['id'])
    ?? JSON.stringify(row);
}

function primitive(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
