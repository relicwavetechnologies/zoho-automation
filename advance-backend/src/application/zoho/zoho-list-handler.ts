import type {
  ZohoBooksModule,
  ZohoBooksPaginatedClient,
} from '../../infrastructure/zoho/zoho-books-paginated.client';

const DEFAULT_INLINE_THRESHOLD = 25;

export interface ZohoListCsvColumn<T extends Record<string, unknown>> {
  readonly key: string;
  readonly header: string;
  readonly value?: (item: T) => unknown;
}

export interface ListHandlerResult<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly items: T[];
  readonly totalCount: number;
  readonly summary: string;
  readonly truncated: false;
  readonly hasMore: boolean;
  readonly suggestExport: boolean;
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
  readonly offerExportOnOverflow?: boolean;
  readonly inlineThreshold?: number;
  readonly postFilter?: (items: readonly T[]) => T[];
  readonly summarize: (items: readonly T[], meta: { truncated: false; hasMore: boolean }) => string;
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
    page: 1,
    perPage: Math.max(inlineThreshold, 25),
  });
  const fetchedItems = firstPage.items as T[];
  const firstItems = input.postFilter ? input.postFilter(fetchedItems) : fetchedItems;
  const visible = firstItems.slice(0, inlineThreshold);
  const hasOverflow = firstPage.hasMore || firstItems.length > inlineThreshold;
  const suggestExport = hasOverflow && input.offerExportOnOverflow !== false;
  const baseSummary = input.summarize(visible, { truncated: false, hasMore: firstPage.hasMore });
  const summary = suggestExport
    ? [
        baseSummary,
        `Found more ${input.moduleLabel.toLowerCase()} than can fit inline.`,
        'For the complete dataset, retry with top-level exportAll=true; the governed dataExport pipeline will deliver an invoker-only Google reader artifact.',
      ].join(' ')
    : baseSummary;
  return {
    items: visible,
    totalCount: firstItems.length,
    summary,
    truncated: false,
    hasMore: firstPage.hasMore,
    suggestExport,
  };
}
