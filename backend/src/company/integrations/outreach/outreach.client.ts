import config from '../../../config';
import { logger } from '../../../utils/logger';

const NUMERIC_FIELDS = [
  'domainAuthority',
  'pageAuthority',
  'domainRating',
  'spamScore',
  'costPrice',
  'sellingPrice',
  'semrushTraffic',
  'semrushOrganicTraffic',
] as const;

const EXACT_STRING_FIELDS = [
  'niche',
  'language',
  'webCountry',
  'contentCategories',
  'priceCategory',
  'linkAttribute',
  'websiteStatus',
  'turnAroundTime',
] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];
type ExactStringField = (typeof EXACT_STRING_FIELDS)[number];

type RangeValue = {
  min?: number;
  max?: number;
};

export type OutreachQueryFilters = Partial<Record<NumericField, number | RangeValue>> &
  Partial<Record<ExactStringField, string>> & {
    websiteRemark?: string;
    website?: string;
    clientUrl?: string;
    availability?: boolean;
  };

export type OutreachQueryInput = {
  filters?: OutreachQueryFilters;
  limit?: number;
  offset?: number;
  page?: number;
};

export type OutreachPublisherRecord = {
  id?: string;
  website?: string;
  niche?: string;
  priceCategory?: string;
  domainAuthority?: number;
  pageAuthority?: number;
  linkAttribute?: string;
  semrushTraffic?: number;
  spamScore?: number;
  domainRating?: number;
  costPrice?: number;
  sellingPrice?: number;
  webCountry?: string;
  language?: string;
  numberOfLinks?: number | null;
  turnAroundTime?: string;
  disclaimer?: string;
  availability?: boolean;
  websiteRemark?: string;
  raw: Record<string, unknown>;
};

export class OutreachIntegrationError extends Error {
  readonly code: 'outreach_unavailable' | 'outreach_invalid_response';

  constructor(message: string, code: 'outreach_unavailable' | 'outreach_invalid_response') {
    super(message);
    this.name = 'OutreachIntegrationError';
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const readBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') {
      return true;
    }
    if (lowered === 'false') {
      return false;
    }
  }
  return undefined;
};

const escapeSqlLiteral = (input: string): string => input.replace(/'/g, "''");

const normalizeClientUrlToken = (value: string): string => value.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

const toRange = (value: number | RangeValue | undefined): RangeValue | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { min: value, max: value };
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const min = typeof value.min === 'number' && Number.isFinite(value.min) ? value.min : undefined;
  const max = typeof value.max === 'number' && Number.isFinite(value.max) ? value.max : undefined;
  if (min === undefined && max === undefined) {
    return null;
  }
  return { min, max };
};

export const buildOutreachFilterString = (filters?: OutreachQueryFilters): string => {
  if (!filters) {
    return '';
  }

  const conditions: string[] = [];

  const websiteToken = readString(filters.clientUrl) ?? readString(filters.website);
  if (websiteToken) {
    const token = escapeSqlLiteral(normalizeClientUrlToken(websiteToken));
    conditions.push(`"website" LIKE '%${token}%'`);
  }

  if (readString(filters.websiteRemark)) {
    const token = escapeSqlLiteral(readString(filters.websiteRemark)!);
    conditions.push(`"websiteRemark" LIKE '%${token}%'`);
  }

  for (const field of EXACT_STRING_FIELDS) {
    const value = readString(filters[field]);
    if (!value) {
      continue;
    }
    conditions.push(`"${field}" = '${escapeSqlLiteral(value)}'`);
  }

  for (const field of NUMERIC_FIELDS) {
    const range = toRange(filters[field]);
    if (!range) {
      continue;
    }
    if (range.min !== undefined) {
      conditions.push(`"${field}" >= ${range.min}`);
    }
    if (range.max !== undefined) {
      conditions.push(`"${field}" <= ${range.max}`);
    }
  }

  const availability = readBoolean(filters.availability);
  if (availability !== undefined) {
    conditions.push(`"availability" = ${availability}`);
  }

  return conditions.join(' AND ');
};

const unwrapRecords = (payload: unknown): Record<string, unknown>[] => {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
        const asObj = asRecord(item);
        if (!asObj) {
          return null;
        }
        const wrapped = asRecord(asObj.json);
        return wrapped ?? asObj;
      })
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  const asObj = asRecord(payload);
  if (!asObj) {
    return [];
  }

  const wrapped = asRecord(asObj.json);
  if (wrapped) {
    return [wrapped];
  }

  for (const key of ['sites', 'publishers', 'data']) {
    const candidate = asObj[key];
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => {
          const record = asRecord(item);
          if (!record) {
            return null;
          }
          const nested = asRecord(record.json);
          return nested ?? record;
        })
        .filter((item): item is Record<string, unknown> => Boolean(item));
    }
  }

  return [asObj];
};

const normalizeRecord = (raw: Record<string, unknown>): OutreachPublisherRecord => ({
  id: readString(raw.id) ?? (readNumber(raw.id) !== undefined ? String(readNumber(raw.id)) : undefined),
  website: readString(raw.website),
  niche: readString(raw.niche),
  priceCategory: readString(raw.priceCategory),
  domainAuthority: readNumber(raw.domainAuthority),
  pageAuthority: readNumber(raw.pageAuthority),
  linkAttribute: readString(raw.linkAttribute),
  semrushTraffic: readNumber(raw.semrushTraffic),
  spamScore: readNumber(raw.spamScore),
  domainRating: readNumber(raw.domainRating),
  costPrice: readNumber(raw.costPrice),
  sellingPrice: readNumber(raw.sellingPrice),
  webCountry: readString(raw.webCountry),
  language: readString(raw.language),
  numberOfLinks: readNumber(raw.numberOfLinks) ?? null,
  turnAroundTime: readString(raw.turnAroundTime),
  disclaimer: readString(raw.disclaimer),
  availability: readBoolean(raw.availability),
  websiteRemark: readString(raw.websiteRemark),
  raw,
});

export class OutreachClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async queryPublishers(input: OutreachQueryInput): Promise<{
    records: OutreachPublisherRecord[];
    filtersString: string;
    raw: unknown;
  }> {
    const filtersString = buildOutreachFilterString(input.filters);
    const body: Record<string, unknown> = {
      limit: Math.max(1, Math.min(100, input.limit ?? 10)),
      offset: Math.max(0, input.offset ?? 0),
      page: Math.max(1, input.page ?? 1),
    };
    if (filtersString.length > 0) {
      body.filters = filtersString;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(config.OUTREACH_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.OUTREACH_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OutreachIntegrationError(
        error instanceof Error ? error.message : 'Outreach request failed',
        'outreach_unavailable',
      );
    }

    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      logger.warn('outreach.api.request.failed', {
        statusCode: response.status,
        body,
      });
      throw new OutreachIntegrationError(
        `Outreach API request failed (${response.status})`,
        'outreach_unavailable',
      );
    }

    const records = unwrapRecords(payload).map(normalizeRecord);
    return {
      records,
      filtersString,
      raw: payload,
    };
  }
}

export const outreachClient = new OutreachClient();
