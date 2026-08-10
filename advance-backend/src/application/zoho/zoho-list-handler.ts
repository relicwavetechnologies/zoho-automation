import type {
  ZohoBooksModule,
  ZohoBooksPaginatedClient,
} from '../../infrastructure/zoho/zoho-books-paginated.client';
import type { DatasetCoverage } from '../provider-data/dataset-preview';

const DEFAULT_INLINE_THRESHOLD = 25;

export interface ZohoListCsvColumn<T extends Record<string, unknown>> {
  readonly key: string;
  readonly header: string;
  readonly value?: (item: T) => unknown;
}

export interface ListHandlerResult<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly items: T[];
  readonly page: number;
  readonly totalCount?: number;
  readonly summary: string;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly coverage: DatasetCoverage;
}

export interface HandleZohoListInput<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly companyId: string;
  readonly userId?: string;
  readonly connectionId?: string;
  readonly organizationId?: string;
  readonly moduleName: ZohoBooksModule;
  readonly moduleLabel: string;
  readonly filters?: Record<string, unknown>;
  readonly query?: string;
  readonly page?: number;
  readonly inlineThreshold?: number;
  readonly postFilter?: (items: readonly T[]) => T[];
  readonly summarize: (items: readonly T[], meta: { truncated: boolean; hasMore: boolean }) => string;
  readonly booksClient: ZohoBooksPaginatedClient;
}

export async function handleZohoList<T extends Record<string, unknown> = Record<string, unknown>>(
  input: HandleZohoListInput<T>,
): Promise<ListHandlerResult<T>> {
  const inlineThreshold = input.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
  const firstPage = await input.booksClient.listRecords({
    companyId: input.companyId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    moduleName: input.moduleName,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.query ? { query: input.query } : {}),
    page: input.page ?? 1,
    perPage: Math.max(inlineThreshold, 25),
  });
  const fetchedItems = firstPage.items as T[];
  const firstItems = input.postFilter ? input.postFilter(fetchedItems) : fetchedItems;
  const visible = firstItems.slice(0, inlineThreshold);
  const hasOverflow = firstPage.hasMore || firstItems.length > inlineThreshold;
  const baseSummary = input.summarize(visible, { truncated: hasOverflow, hasMore: firstPage.hasMore });
  const coverage: DatasetCoverage = hasOverflow
    ? {
        kind: 'truncated',
        returnedRows: visible.length,
        ...(firstPage.hasMore ? {} : { knownTotal: firstItems.length }),
        reason: firstPage.hasMore ? 'source_has_more' : 'requested_preview_limit',
      }
    : { kind: 'complete', totalRows: visible.length };
  return {
    items: visible,
    page: firstPage.page,
    ...(!firstPage.hasMore ? { totalCount: firstItems.length } : {}),
    summary: baseSummary,
    truncated: hasOverflow,
    hasMore: firstPage.hasMore,
    coverage,
  };
}
