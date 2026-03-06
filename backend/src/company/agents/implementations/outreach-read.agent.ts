import type { AgentInvokeInputDTO } from '../../contracts';
import {
  type OutreachQueryFilters,
  OutreachIntegrationError,
  outreachClient,
} from '../../integrations/outreach/outreach.client';
import { BaseAgent } from '../base';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const extractLimit = (objective: string): number => {
  const match = objective.match(/\b(?:top|show|list|find|get)\s+(\d{1,2})\b/i);
  if (!match) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, parsed);
};

const extractClientUrl = (objective: string): string | undefined => {
  const explicitUrl = objective.match(/\bhttps?:\/\/[^\s,]+/i)?.[0];
  if (explicitUrl) {
    return explicitUrl;
  }

  const domainCandidate = objective.match(
    /\b(?:for|from|on|site|website|domain)\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:\b|\/)/i,
  )?.[1];

  return domainCandidate ? `https://${domainCandidate}` : undefined;
};

const extractRange = (objective: string, aliases: string[]): { min?: number; max?: number } | undefined => {
  const aliasPattern = aliases.map((alias) => alias.replace(/\s+/g, '\\s+')).join('|');
  const between = new RegExp(`(?:${aliasPattern})\\s*(?:between|from)\\s*(\\d{1,3})\\s*(?:and|to)\\s*(\\d{1,3})`, 'i');
  const minimum = new RegExp(
    `(?:${aliasPattern})\\s*(?:>=|>|at\\s+least|above|over|min(?:imum)?)\\s*(\\d{1,3})`,
    'i',
  );
  const plus = new RegExp(`(?:${aliasPattern})\\s*(\\d{1,3})\\s*\\+`, 'i');
  const maximum = new RegExp(`(?:${aliasPattern})\\s*(?:<=|<|at\\s+most|below|under|max(?:imum)?)\\s*(\\d{1,3})`, 'i');

  const betweenMatch = objective.match(between);
  if (betweenMatch) {
    const first = Number.parseInt(betweenMatch[1] ?? '', 10);
    const second = Number.parseInt(betweenMatch[2] ?? '', 10);
    return {
      min: Math.min(first, second),
      max: Math.max(first, second),
    };
  }

  const minMatch = objective.match(minimum);
  const plusMatch = objective.match(plus);
  const maxMatch = objective.match(maximum);
  const min =
    minMatch && Number.isFinite(Number.parseInt(minMatch[1] ?? '', 10))
      ? Number.parseInt(minMatch[1] ?? '', 10)
      : plusMatch && Number.isFinite(Number.parseInt(plusMatch[1] ?? '', 10))
        ? Number.parseInt(plusMatch[1] ?? '', 10)
        : undefined;
  const max =
    maxMatch && Number.isFinite(Number.parseInt(maxMatch[1] ?? '', 10))
      ? Number.parseInt(maxMatch[1] ?? '', 10)
      : undefined;

  if (min === undefined && max === undefined) {
    return undefined;
  }
  return { min, max };
};

const extractPriceRange = (objective: string): { min?: number; max?: number } | undefined => {
  const money = '(?:₹|rs\\.?|inr|\\$)?\\s*(\\d{2,7})';
  const max = objective.match(new RegExp(`\\b(?:under|below|less\\s+than|<=)\\s*${money}`, 'i'));
  const min = objective.match(new RegExp(`\\b(?:over|above|more\\s+than|>=)\\s*${money}`, 'i'));

  const minValue =
    min && Number.isFinite(Number.parseInt(min[1] ?? '', 10))
      ? Number.parseInt(min[1] ?? '', 10)
      : undefined;
  const maxValue =
    max && Number.isFinite(Number.parseInt(max[1] ?? '', 10))
      ? Number.parseInt(max[1] ?? '', 10)
      : undefined;

  if (minValue === undefined && maxValue === undefined) {
    return undefined;
  }
  return {
    min: minValue,
    max: maxValue,
  };
};

const extractCountry = (objective: string): string | undefined => {
  const match = objective.match(/\b(?:in|country)\s*[:=]?\s*([a-z][a-z\s]{2,40})\b/i)?.[1];
  if (!match) {
    return undefined;
  }
  const cleaned = match.trim().replace(/\s+/g, ' ');
  if (cleaned.toLowerCase().includes('with') || cleaned.toLowerCase().includes('and')) {
    return undefined;
  }
  return cleaned;
};

const extractNiche = (objective: string): string | undefined => {
  const match = objective.match(/\b(?:niche|category)\s*[:=]?\s*([a-z][a-z\s-]{2,40})\b/i)?.[1];
  return match ? match.trim().replace(/\s+/g, ' ') : undefined;
};

const buildFiltersFromObjective = (objective: string): OutreachQueryFilters => {
  const daRange = extractRange(objective, ['da', 'domain authority']);
  const drRange = extractRange(objective, ['dr', 'domain rating']);
  const priceRange = extractPriceRange(objective);

  const filters: OutreachQueryFilters = {};
  const clientUrl = extractClientUrl(objective);
  const country = extractCountry(objective);
  const niche = extractNiche(objective);

  if (clientUrl) {
    filters.clientUrl = clientUrl;
  }
  if (daRange) {
    filters.domainAuthority = daRange;
  }
  if (drRange) {
    filters.domainRating = drRange;
  }
  if (priceRange) {
    filters.sellingPrice = priceRange;
  }
  if (country) {
    filters.webCountry = country;
  }
  if (niche) {
    filters.niche = niche;
  }
  if (/\b(?:available|availability)\b/i.test(objective)) {
    filters.availability = true;
  }

  return filters;
};

const formatNumber = (value: number | undefined): string => {
  if (value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const formatPrice = (value: number | undefined): string => {
  if (value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}`;
};

export class OutreachReadAgent extends BaseAgent {
  readonly key = 'outreach-read';

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    const objective = input.objective.trim();
    const limit = extractLimit(objective);

    // Allow explicit structured filters from caller, then enrich from natural language.
    const explicitFilters =
      input.contextPacket.filters && typeof input.contextPacket.filters === 'object'
        ? (input.contextPacket.filters as OutreachQueryFilters)
        : {};
    const parsedFilters = buildFiltersFromObjective(objective);
    const mergedFilters: OutreachQueryFilters = { ...parsedFilters, ...explicitFilters };

    try {
      const response = await outreachClient.queryPublishers({
        filters: mergedFilters,
        limit,
      });

      const records = response.records.slice(0, limit);
      const sourceRefs = records
        .map((record) => asString(record.id) ?? asString(record.website))
        .filter((entry): entry is string => Boolean(entry))
        .map((id) => ({ source: 'outreach' as const, id }));

      if (records.length === 0) {
        const emptyReason = response.filtersString
          ? `No outreach publishers matched your filters (${response.filtersString}).`
          : 'No outreach publishers matched this query.';
        return this.success(
          input,
          emptyReason,
          {
            answer: emptyReason,
            filtersApplied: response.filtersString,
            records: [],
            sourceRefs: [],
          },
          { latencyMs: Date.now() - startedAt, apiCalls: 1 },
        );
      }

      const lines = records.map((record, index) => {
        const website = asString(record.website) ?? asString(record.id) ?? `publisher_${index + 1}`;
        const niche = asString(record.niche) ?? 'n/a';
        const country = asString(record.webCountry) ?? 'n/a';
        const link = asString(record.linkAttribute) ?? 'n/a';
        return `${index + 1}. ${website} | DA ${formatNumber(record.domainAuthority)} | DR ${formatNumber(record.domainRating)} | Price ${formatPrice(record.sellingPrice)} | Niche ${niche} | Country ${country} | Link ${link}`;
      });

      const header = `Found ${records.length} outreach publisher${records.length === 1 ? '' : 's'} matching your query.`;
      const filterLine = response.filtersString ? `Applied filters: ${response.filtersString}` : undefined;
      const answer = [header, filterLine, ...lines].filter(Boolean).join('\n');

      return this.success(
        input,
        answer,
        {
          answer,
          filtersApplied: response.filtersString,
          records: records.map((record) => ({
            id: record.id,
            website: record.website,
            niche: record.niche,
            domainAuthority: record.domainAuthority,
            domainRating: record.domainRating,
            sellingPrice: record.sellingPrice,
            webCountry: record.webCountry,
            linkAttribute: record.linkAttribute,
            availability: record.availability,
          })),
          sourceRefs,
        },
        { latencyMs: Date.now() - startedAt, apiCalls: 1 },
      );
    } catch (error) {
      if (error instanceof OutreachIntegrationError) {
        return this.failure(
          input,
          `Outreach retrieval failed: ${error.message}`,
          error.code,
          error.message,
          error.code === 'outreach_unavailable',
          { latencyMs: Date.now() - startedAt, apiCalls: 1 },
        );
      }

      return this.failure(
        input,
        'Outreach retrieval failed',
        'outreach_invalid_response',
        error instanceof Error ? error.message : 'unknown_error',
        true,
        { latencyMs: Date.now() - startedAt, apiCalls: 1 },
      );
    }
  }
}
