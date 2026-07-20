import { z } from 'zod';

/**
 * The OMS webhook exposes a dynamic query language. Divo deliberately does
 * not pass that language through to the agent. These three operations are the
 * reviewed, stable subset that map to useful inventory workflows.
 */
export const OMS_SITE_DATA_OPERATIONS = [
  'search_sites',
  'get_site_profiles',
  'list_catalog_values',
] as const;

export const OmsSiteDataOperationSchema = z.enum(OMS_SITE_DATA_OPERATIONS);
export type OmsSiteDataOperation = z.infer<typeof OmsSiteDataOperationSchema>;

const siteClassification = z.enum(['Normal', 'Casino', 'Cbd', 'Adult', 'Organic', 'Crypto']);
const priceCategory = z.enum(['Paid', 'Free', 'Exchange']);
const linkAttribute = z.enum(['DoFollow', 'NoFollow', 'Sponsored']);
const websiteType = z.enum(['Default', 'PR', 'Language', 'PR_Brand', 'PR_NonBrand', 'Foreign_PR']);
const websiteStatus = z.enum(['Normal', 'Blacklist', 'Disqualified']);
const websiteQuality = z.enum(['Pure', 'AlmostPure', 'Multi']);

const queryText = z.string().trim().min(1).max(120)
  .refine((value) => !/[\u0000\r\n]/.test(value), 'Use a single-line search value.');

const website = z.string().trim().toLowerCase().min(3).max(253)
  .refine(
    (value) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value),
    'Use a bare website hostname, without protocol, path, credentials, port, or query string.',
  );

const metric = z.number().finite().min(0).max(10_000_000_000);

const searchSortField = z.enum([
  'domainAuthority',
  'pageAuthority',
  'semrushOrganicTraffic',
  'semrushTraffic',
  'ahrefTraffic',
  'sellingPrice',
  'costPrice',
  'turnAroundTime',
]);

const SearchSitesSchema = z.object({
  operation: z.literal('search_sites'),
  niche: queryText.optional(),
  contentCategory: queryText.optional(),
  language: queryText.optional(),
  country: queryText.optional(),
  websiteStatus: websiteStatus.optional(),
  siteClassification: siteClassification.optional(),
  priceCategory: priceCategory.optional(),
  linkAttribute: linkAttribute.optional(),
  websiteType: websiteType.optional(),
  websiteQuality: websiteQuality.optional(),
  minDomainAuthority: metric.optional(),
  maxDomainAuthority: metric.optional(),
  minPageAuthority: metric.optional(),
  maxPageAuthority: metric.optional(),
  minOrganicTraffic: metric.optional(),
  maxOrganicTraffic: metric.optional(),
  minSellingPrice: metric.optional(),
  maxSellingPrice: metric.optional(),
  sortBy: searchSortField.optional(),
  sortDirection: z.enum(['ASC', 'DESC']).optional(),
}).strict().superRefine((value, ctx) => {
  const criteria = Object.entries(value).filter(([key, item]) => key !== 'operation' && key !== 'sortBy' && key !== 'sortDirection' && item !== undefined);
  if (criteria.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one search criterion.' });
  }
  for (const [minimum, maximum, label] of [
    [value.minDomainAuthority, value.maxDomainAuthority, 'domain authority'],
    [value.minPageAuthority, value.maxPageAuthority, 'page authority'],
    [value.minOrganicTraffic, value.maxOrganicTraffic, 'organic traffic'],
    [value.minSellingPrice, value.maxSellingPrice, 'selling price'],
  ] as const) {
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Minimum ${label} cannot exceed maximum ${label}.` });
    }
  }
});

const GetSiteProfilesSchema = z.object({
  operation: z.literal('get_site_profiles'),
  websites: z.array(website).min(1).max(20).superRefine((items, ctx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Website hostnames must be unique.' });
    }
  }),
}).strict();

export const OMS_CATALOG_FIELDS = [
  'niche',
  'contentCategories',
  'language',
  'webCountry',
  'websiteStatus',
  'websiteType',
  'websiteQuality',
  'siteClassification',
  'priceCategory',
  'linkAttribute',
] as const;

export const OmsCatalogFieldSchema = z.enum(OMS_CATALOG_FIELDS);
export type OmsCatalogField = z.infer<typeof OmsCatalogFieldSchema>;

const ListCatalogValuesSchema = z.object({
  operation: z.literal('list_catalog_values'),
  field: OmsCatalogFieldSchema,
}).strict();

// Search validation needs cross-field range checks, which makes that branch a
// ZodEffects value; use a strict union rather than discriminatedUnion (which
// accepts raw object branches only).
export const OmsSiteDataToolArgsSchema = z.union([
  SearchSitesSchema,
  GetSiteProfilesSchema,
  ListCatalogValuesSchema,
]);
export type OmsSiteDataToolArgs = z.infer<typeof OmsSiteDataToolArgsSchema>;

export const OMS_SEARCH_COLUMNS = [
  'website',
  'niche',
  'contentCategories',
  'domainAuthority',
  'pageAuthority',
  'semrushOrganicTraffic',
  'semrushTraffic',
  'ahrefTraffic',
  'sellingPrice',
  'costPrice',
  'websiteStatus',
  'websiteQuality',
  'language',
  'webCountry',
  'linkAttribute',
  'websiteType',
  'siteClassification',
  'priceCategory',
  'turnAroundTime',
  'sampleURL',
] as const;

export const OMS_PROFILE_COLUMNS = [
  'website',
  'niche',
  'contentCategories',
  'pureCategory',
  'language',
  'webCountry',
  'domainAuthority',
  'pageAuthority',
  'domainRating',
  'spamScore',
  'semrushOrganicTraffic',
  'semrushTraffic',
  'similarwebTraffic',
  'sellingPrice',
  'costPrice',
  'linkAttribute',
  'websiteType',
  'siteClassification',
  'priceCategory',
  'websiteStatus',
  'websiteQuality',
  'turnAroundTime',
  'sampleURL',
  'websiteRemark',
  'disclaimer',
] as const;

export type OmsSiteColumn = (typeof OMS_SEARCH_COLUMNS)[number] | (typeof OMS_PROFILE_COLUMNS)[number] | OmsCatalogField;

export type OmsFilter = {
  readonly field: OmsSiteColumn;
  readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'in' | 'isNull' | 'isNotNull';
  readonly value?: string | number | readonly string[];
};

export type OmsProviderRequest = {
  readonly columns: readonly OmsSiteColumn[];
  readonly filters?: readonly OmsFilter[];
  readonly groupBy?: readonly OmsSiteColumn[];
  readonly orderBy?: readonly Readonly<{ field: OmsSiteColumn; direction: 'ASC' | 'DESC' }>[];
};

export interface OmsFetchedData {
  readonly operation: OmsSiteDataOperation;
  readonly status: 'complete' | 'empty' | 'partial';
  readonly coverage: Record<string, unknown>;
  readonly rows: Array<Record<string, unknown>>;
}

export function buildOmsProviderRequest(args: OmsSiteDataToolArgs): OmsProviderRequest {
  switch (args.operation) {
    case 'search_sites': {
      const filters: OmsFilter[] = [];
      addContains(filters, 'niche', args.niche);
      addContains(filters, 'contentCategories', args.contentCategory);
      addContains(filters, 'language', args.language);
      addContains(filters, 'webCountry', args.country);
      addEqual(filters, 'websiteStatus', args.websiteStatus);
      addEqual(filters, 'siteClassification', args.siteClassification);
      addEqual(filters, 'priceCategory', args.priceCategory);
      addEqual(filters, 'linkAttribute', args.linkAttribute);
      addEqual(filters, 'websiteType', args.websiteType);
      addEqual(filters, 'websiteQuality', args.websiteQuality);
      addComparison(filters, 'domainAuthority', 'gte', args.minDomainAuthority);
      addComparison(filters, 'domainAuthority', 'lte', args.maxDomainAuthority);
      addComparison(filters, 'pageAuthority', 'gte', args.minPageAuthority);
      addComparison(filters, 'pageAuthority', 'lte', args.maxPageAuthority);
      addComparison(filters, 'semrushOrganicTraffic', 'gte', args.minOrganicTraffic);
      addComparison(filters, 'semrushOrganicTraffic', 'lte', args.maxOrganicTraffic);
      addComparison(filters, 'sellingPrice', 'gte', args.minSellingPrice);
      addComparison(filters, 'sellingPrice', 'lte', args.maxSellingPrice);
      return {
        columns: OMS_SEARCH_COLUMNS,
        filters,
        ...(args.sortBy ? { orderBy: [{ field: args.sortBy, direction: args.sortDirection ?? 'DESC' }] } : {}),
      };
    }
    case 'get_site_profiles':
      return {
        columns: OMS_PROFILE_COLUMNS,
        filters: [{ field: 'website', op: 'in', value: args.websites }],
      };
    case 'list_catalog_values':
      // The upstream accepts groupBy+orderBy but does not consistently honor
      // grouped sorting. The client applies deterministic local sorting instead.
      return { columns: [args.field], groupBy: [args.field] };
  }
  throw new OmsSiteDataServiceError('provider_failure', 'Unsupported OMS Site Data operation.');
}

function addContains(filters: OmsFilter[], field: OmsSiteColumn, value: string | undefined): void {
  if (value !== undefined) filters.push({ field, op: 'contains', value });
}

function addEqual(filters: OmsFilter[], field: OmsSiteColumn, value: string | undefined): void {
  if (value !== undefined) filters.push({ field, op: 'eq', value });
}

function addComparison(filters: OmsFilter[], field: OmsSiteColumn, op: 'gte' | 'lte', value: number | undefined): void {
  if (value !== undefined) filters.push({ field, op, value });
}

export class OmsSiteDataServiceError extends Error {
  constructor(
    readonly code: 'not_configured' | 'disabled' | 'provider_auth_failed' | 'provider_failure' | 'timeout' | 'ambiguous_empty_response',
    message: string,
  ) {
    super(message);
    this.name = 'OmsSiteDataServiceError';
  }
}
