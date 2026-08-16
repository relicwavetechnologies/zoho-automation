import { z } from 'zod';

/**
 * The OMS webhook exposes a dynamic query language. Divo deliberately does
 * not pass that language through to the agent. These three operations are the
 * reviewed, stable subset that map to useful inventory workflows.
 */
export const OMS_SITE_DATA_OPERATIONS = [
  'sanitize_website_inputs',
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

/** The provider AND-combines filters and documents a hard ceiling of 20. */
export const MAX_PROVIDER_FILTERS = 20;

/**
 * Fields where a smaller value is the better result. The provider sorts before
 * it truncates to 100 rows, so an unqualified DESC on one of these returns the
 * 100 worst matches and discards every good one. "Cleanest sites" must not be
 * answered with the spammiest inventory, so the default direction is per-field
 * rather than a blanket DESC. An explicit sortDirection always wins.
 */
const LOWER_IS_BETTER = new Set<string>(['spamScore', 'sellingPrice', 'costPrice', 'turnAroundTime']);

export function defaultSortDirection(field: string): 'ASC' | 'DESC' {
  return LOWER_IS_BETTER.has(field) ? 'ASC' : 'DESC';
}

/**
 * spamScore is NOT NULL upstream, so "never measured" is stored as -1 rather
 * than null. Left alone that sentinel is actively misleading: it sorts first
 * under ASC, so "cleanest sites" returns unmeasured inventory, and it satisfies
 * any maxSpamScore bound, so a "spam score under 2" shortlist quietly includes
 * sites whose spam score is unknown. Whenever the caller constrains or ranks by
 * spam score without setting their own floor, the sentinel is excluded so an
 * unmeasured site is never presented as a clean one.
 */
export function excludesUnmeasuredSpamScore(value: {
  minSpamScore?: number | undefined; maxSpamScore?: number | undefined;
  sortBy?: string | undefined; sortDirection?: 'ASC' | 'DESC' | undefined;
}): boolean {
  if (value.minSpamScore !== undefined) return false;
  if (value.maxSpamScore !== undefined) return true;
  return value.sortBy === 'spamScore' && (value.sortDirection ?? defaultSortDirection('spamScore')) === 'ASC';
}

/** Every value here must also appear in OMS_SEARCH_COLUMNS: the provider
 *  rejects an orderBy on a column it was not asked to select. */
export const SEARCH_SORT_FIELDS = [
  'domainAuthority',
  'pageAuthority',
  'domainRating',
  'spamScore',
  'semrushOrganicTraffic',
  'semrushTraffic',
  'ahrefTraffic',
  'similarwebTraffic',
  'sellingPrice',
  'costPrice',
  'turnAroundTime',
] as const;

const searchSortField = z.enum(SEARCH_SORT_FIELDS);

const SanitizeWebsiteInputsSchema = z.object({
  operation: z.literal('sanitize_website_inputs'),
  inputs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(200),
}).strict();

// Kept as a raw object so the union below can discriminate on `operation`.
// The cross-field checks live in `refineSearchSites` and run once the branch
// has been chosen — see the union for why that ordering matters.
const SearchSitesObject = z.object({
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
  minDomainRating: metric.optional(),
  maxDomainRating: metric.optional(),
  // Spam score is inverted: lower is better, so maxSpamScore is the filter
  // that matters for shortlisting. Both bounds exist for range symmetry.
  minSpamScore: metric.optional(),
  maxSpamScore: metric.optional(),
  minOrganicTraffic: metric.optional(),
  maxOrganicTraffic: metric.optional(),
  minSemrushTraffic: metric.optional(),
  maxSemrushTraffic: metric.optional(),
  minAhrefTraffic: metric.optional(),
  maxAhrefTraffic: metric.optional(),
  minSimilarwebTraffic: metric.optional(),
  maxSimilarwebTraffic: metric.optional(),
  minSellingPrice: metric.optional(),
  maxSellingPrice: metric.optional(),
  sortBy: searchSortField.optional(),
  sortDirection: z.enum(['ASC', 'DESC']).optional(),
}).strict();

const refineSearchSites = (value: z.infer<typeof SearchSitesObject>, ctx: z.RefinementCtx): void => {
  const criteria = Object.entries(value).filter(([key, item]) => key !== 'operation' && key !== 'sortBy' && key !== 'sortDirection' && item !== undefined);
  if (criteria.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one search criterion.' });
  }
  // Each criterion becomes exactly one provider filter, and OMS accepts at most
  // 20. Rejecting here keeps the failure legible: an over-limit request is
  // rejected by OMS with an empty 200 body, which is indistinguishable from
  // "no matches" and would surface as an unexplained blocked result.
  // The spam-score sentinel guard becomes a real filter, so it counts against
  // the provider ceiling even though the caller did not supply it.
  const reservesSpamGuard = excludesUnmeasuredSpamScore(value);
  const emittedFilters = criteria.length + (reservesSpamGuard ? 1 : 0);
  if (emittedFilters > MAX_PROVIDER_FILTERS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      // Naming the reserved slot keeps the message true: with the guard in play
      // a 20-criterion request really does exceed the ceiling.
      message: reservesSpamGuard
        ? `Use at most ${MAX_PROVIDER_FILTERS} search criteria; OMS rejects a request with more, and constraining or ranking by spam score reserves one of them.`
        : `Use at most ${MAX_PROVIDER_FILTERS} search criteria; OMS rejects a request with more.`,
    });
  }
  for (const [minimum, maximum, label] of [
    [value.minDomainAuthority, value.maxDomainAuthority, 'domain authority'],
    [value.minPageAuthority, value.maxPageAuthority, 'page authority'],
    [value.minDomainRating, value.maxDomainRating, 'domain rating'],
    [value.minSpamScore, value.maxSpamScore, 'spam score'],
    [value.minOrganicTraffic, value.maxOrganicTraffic, 'organic traffic'],
    [value.minSemrushTraffic, value.maxSemrushTraffic, 'Semrush traffic'],
    [value.minAhrefTraffic, value.maxAhrefTraffic, 'Ahrefs traffic'],
    [value.minSimilarwebTraffic, value.maxSimilarwebTraffic, 'Similarweb traffic'],
    [value.minSellingPrice, value.maxSellingPrice, 'selling price'],
  ] as const) {
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Minimum ${label} cannot exceed maximum ${label}.` });
    }
  }
};

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

/**
 * Discriminated on `operation` so a rejection names what was actually wrong.
 *
 * A plain `z.union` tries every branch and, when all fail, reports only
 * `invalid_union` at the root — which the tool layer renders as
 * "(root): Invalid input". The caller is told nothing: not which operation was
 * being validated, not which field was missing, not that a key was
 * unrecognised. A model that passed `hostnames` instead of `websites` retried
 * twice with reformatted hostnames, because the one fact it needed was the one
 * the error had thrown away.
 *
 * Discriminating first picks the single branch the caller asked for and
 * surfaces that branch's real issues. Search's cross-field checks run after
 * the branch is chosen, which is why they had to move out of the object.
 */
export const OmsSiteDataToolArgsSchema = z
  .discriminatedUnion('operation', [
    SanitizeWebsiteInputsSchema,
    SearchSitesObject,
    GetSiteProfilesSchema,
    ListCatalogValuesSchema,
  ])
  .superRefine((value, ctx) => {
    if (value.operation === 'search_sites') refineSearchSites(value, ctx);
  });
export type OmsSiteDataToolArgs = z.infer<typeof OmsSiteDataToolArgsSchema>;
export type OmsProviderSiteDataToolArgs = Exclude<OmsSiteDataToolArgs, { operation: 'sanitize_website_inputs' }>;

// The provider allows up to 25 columns per request. Every filterable metric is
// also selected so a shortlist always shows the fields it was filtered on.
export const OMS_SEARCH_COLUMNS = [
  'website',
  'niche',
  'contentCategories',
  'domainAuthority',
  'pageAuthority',
  'domainRating',
  'spamScore',
  'semrushOrganicTraffic',
  'semrushTraffic',
  'ahrefTraffic',
  'similarwebTraffic',
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

export type OmsSanitizedWebsiteRow = {
  readonly input: string;
  readonly status: 'sanitized' | 'invalid';
  readonly inputKind?: 'email' | 'url' | 'hostname';
  readonly hostname?: string;
  readonly website?: string;
  readonly reason?: string;
};

export function sanitizeOmsWebsiteInputs(inputs: readonly string[]): OmsSanitizedWebsiteRow[] {
  const rows: OmsSanitizedWebsiteRow[] = [];
  for (const input of inputs) {
    const candidates = websiteCandidates(input);
    if (candidates.length === 0) {
      rows.push({ input, status: 'invalid', reason: 'No URL, email, or hostname found.' });
      continue;
    }
    for (const candidate of candidates) rows.push(sanitizeOneWebsiteInput(candidate));
  }
  return rows;
}

function sanitizeOneWebsiteInput(input: string): OmsSanitizedWebsiteRow {
  const candidate = stripWrapper(input);
  const emailHost = hostFromEmail(candidate);
  const parsed = emailHost
    ? { host: emailHost, kind: 'email' as const }
    : hostFromUrlOrHostname(candidate);
  if (!parsed) return { input, status: 'invalid', reason: 'Not a valid email, URL, or website hostname.' };
  const hostname = parsed.host.replace(/\.$/, '').toLowerCase();
  if (!website.safeParse(hostname).success) {
    return { input, status: 'invalid', reason: 'Hostname must be a public domain, not an IP, localhost, or malformed value.' };
  }
  return {
    input,
    status: 'sanitized',
    inputKind: parsed.kind,
    hostname,
    website: omsWebsiteFor(hostname),
  };
}

function websiteCandidates(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map(stripWrapper)
    .filter((candidate) => candidate && /@|:\/\/|\.|^www\./i.test(candidate));
}

function stripWrapper(value: string): string {
  return value.trim().replace(/^[<([{'"`]+|[>\])}'"`.,]+$/g, '');
}

function hostFromEmail(value: string): string | undefined {
  const address = value.replace(/^mailto:/i, '');
  const match = /^[^@\s]+@([^@\s/?#]+)$/i.exec(address);
  return match?.[1];
}

function hostFromUrlOrHostname(value: string): { host: string; kind: 'url' | 'hostname' } | undefined {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const looksUrl = hasScheme || /[/?#]/.test(value);
  try {
    const url = new URL(hasScheme ? value : `https://${value}`);
    return url.hostname ? { host: url.hostname, kind: looksUrl ? 'url' : 'hostname' } : undefined;
  } catch {
    return undefined;
  }
}

function omsWebsiteFor(hostname: string): string {
  if (hostname.startsWith('www.')) return hostname;
  const labels = hostname.split('.');
  const [, second, third] = labels;
  const countrySecondLevel = labels.length === 3 && second !== undefined && third !== undefined && second.length <= 3 && third.length === 2;
  const bareDomain = labels.length === 2 || countrySecondLevel;
  return bareDomain ? `www.${hostname}` : hostname;
}

export function buildOmsProviderRequest(args: OmsProviderSiteDataToolArgs): OmsProviderRequest {
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
      addComparison(filters, 'domainRating', 'gte', args.minDomainRating);
      addComparison(filters, 'domainRating', 'lte', args.maxDomainRating);
      addComparison(filters, 'spamScore', 'gte', excludesUnmeasuredSpamScore(args) ? 0 : args.minSpamScore);
      addComparison(filters, 'spamScore', 'lte', args.maxSpamScore);
      addComparison(filters, 'semrushOrganicTraffic', 'gte', args.minOrganicTraffic);
      addComparison(filters, 'semrushOrganicTraffic', 'lte', args.maxOrganicTraffic);
      addComparison(filters, 'semrushTraffic', 'gte', args.minSemrushTraffic);
      addComparison(filters, 'semrushTraffic', 'lte', args.maxSemrushTraffic);
      addComparison(filters, 'ahrefTraffic', 'gte', args.minAhrefTraffic);
      addComparison(filters, 'ahrefTraffic', 'lte', args.maxAhrefTraffic);
      addComparison(filters, 'similarwebTraffic', 'gte', args.minSimilarwebTraffic);
      addComparison(filters, 'similarwebTraffic', 'lte', args.maxSimilarwebTraffic);
      addComparison(filters, 'sellingPrice', 'gte', args.minSellingPrice);
      addComparison(filters, 'sellingPrice', 'lte', args.maxSellingPrice);
      return {
        columns: OMS_SEARCH_COLUMNS,
        filters,
        ...(args.sortBy ? { orderBy: [{ field: args.sortBy, direction: args.sortDirection ?? defaultSortDirection(args.sortBy) }] } : {}),
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
