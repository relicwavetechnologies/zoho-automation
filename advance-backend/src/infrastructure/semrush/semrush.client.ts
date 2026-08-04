import { URL, URLSearchParams } from 'node:url';
import type { SemrushFetchedData, SemrushToolArgs } from '../../application/semrush/semrush.types';
import { operationApiVersion, SemrushServiceError } from '../../application/semrush/semrush.types';

const V3_API_URL = 'https://api.semrush.com/';
/** Backlinks reports live on their own host path and take one target per call. */
const ANALYTICS_V1_API_URL = 'https://api.semrush.com/analytics/v1/';
const BACKLINKS_COLUMN_LABELS: Readonly<Record<string, string>> = {
  target: 'Target',
  ascore: 'Authority Score',
  total: 'Backlinks',
  domains_num: 'Referring Domains',
  urls_num: 'Referring URLs',
  ips_num: 'Referring IPs',
  follows_num: 'Follow Links',
  nofollows_num: 'Nofollow Links',
  texts_num: 'Text Links',
  images_num: 'Image Links',
};
const BACKLINKS_PROVIDER_DATA_STATUS_COLUMN = 'Provider Data Status';

export class SemrushClient {
  constructor(private readonly deps: { timeoutMs: number; fetchImpl?: typeof fetch } ) {}

  async fetch(input: { apiKey: string; args: SemrushToolArgs }): Promise<SemrushFetchedData> {
    const requiredVersion = operationApiVersion[input.args.operation];
    if (!requiredVersion) {
      throw new SemrushServiceError('capability_unavailable', `${input.args.operation} has no verified official Semrush API contract yet.`);
    }
    const args = input.args;
    switch (args.operation) {
      case 'domain_overview': return this.domainOverview(input.apiKey, args.domain, args.database ?? 'in');
      case 'organic_positions': return this.organicPositions(input.apiKey, args.domain, args.database ?? 'in', args.limit ?? 100, args.offset ?? 0);
      case 'organic_position_trend': return this.organicPositionTrend(input.apiKey, args.domain, args.database ?? 'in', args.limit ?? 24);
      case 'keyword_research': return this.keywordResearch(input.apiKey, args.keywords, args.database ?? 'in');
      case 'domain_comparison':
      case 'keyword_gap':
        return this.compareDomains(input.apiKey, args.operation, args.targets, args.database ?? 'in', args.limit ?? 100);
      case 'backlinks_comparison': return this.backlinksComparison(input.apiKey, args.targets);
      default:
        throw new SemrushServiceError('capability_unavailable', `${(args as { operation: string }).operation} has no verified official Semrush API contract yet.`);
    }
  }

  private async domainOverview(apiKey: string, domain: string, database: string): Promise<SemrushFetchedData> {
    const url = new URL(V3_API_URL);
    url.search = new URLSearchParams({
      key: apiKey,
      type: 'domain_ranks',
      domain,
      database,
      export_columns: 'Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac,Sh,Sv',
    }).toString();
    const text = await this.text(url, {});
    const rows = readSemrushRows(text).slice(0, 1);
    return { operation: 'domain_overview', status: rows.length ? 'complete' : 'empty', coverage: { domain, database, apiVersion: 'v3' }, rows };
  }

  private async organicPositions(apiKey: string, domain: string, database: string, limit: number, offset: number): Promise<SemrushFetchedData> {
    const url = new URL(V3_API_URL);
    const providerLimit = Math.min(limit + 1, 1_000);
    url.search = new URLSearchParams({
      key: apiKey,
      type: 'domain_organic',
      domain,
      database,
      display_limit: String(providerLimit),
      display_offset: String(offset),
      // Keep the full official domain_organic default field set. A narrower
      // projection silently drops ranking movement and competition evidence.
      export_columns: 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Tc,Co,Nr,Td,Fk,Fp',
    }).toString();
    let text: string;
    try {
      text = await this.text(url, {});
    } catch (error) {
      if (error instanceof SemrushServiceError && error.code === 'no_more_rows' && offset > 0) {
        return {
          operation: 'organic_positions',
          status: 'empty',
          coverage: { domain, database, apiVersion: 'v3', offset, limit },
          rows: [],
        };
      }
      throw error;
    }
    const providerRows = readSemrushRows(text);
    const rows = providerRows.slice(0, limit);
    // Ask for one look-ahead row whenever the provider's 1,000-row ceiling
    // allows it. Equality with the user's limit alone is not proof that a next
    // page exists; Semrush rejects an offset exactly at end-of-data.
    const hasPossibleNextPage = providerRows.length > limit
      || (limit === 1_000 && providerRows.length === limit);
    return {
      operation: 'organic_positions',
      status: rows.length ? (hasPossibleNextPage ? 'partial' : 'complete') : 'empty',
      coverage: { domain, database, apiVersion: 'v3', offset, limit },
      rows,
      ...(hasPossibleNextPage ? { nextPage: String(offset + limit) } : {}),
    };
  }

  /** Monthly authority/traffic history for one domain, newest month first. */
  private async organicPositionTrend(apiKey: string, domain: string, database: string, limit: number): Promise<SemrushFetchedData> {
    const url = new URL(V3_API_URL);
    url.search = new URLSearchParams({
      key: apiKey,
      type: 'domain_rank_history',
      domain,
      database,
      display_limit: String(limit),
      export_columns: 'Dt,Rk,Or,Ot,Oc,Ad,At,Ac',
    }).toString();
    const text = await this.text(url, {});
    const rows = readSemrushRows(text).slice(0, limit);
    return {
      operation: 'organic_position_trend',
      status: rows.length ? 'complete' : 'empty',
      coverage: { domain, database, apiVersion: 'v3', months: rows.length },
      rows,
    };
  }

  /** Batched keyword metrics. Semrush separates phrases with ";" in one call. */
  private async keywordResearch(apiKey: string, keywords: readonly string[], database: string): Promise<SemrushFetchedData> {
    const url = new URL(V3_API_URL);
    url.search = new URLSearchParams({
      key: apiKey,
      type: 'phrase_these',
      phrase: keywords.join(';'),
      database,
      export_columns: 'Ph,Nq,Cp,Co,Nr,Td',
    }).toString();
    const text = await this.text(url, {});
    const rows = readSemrushRows(text);
    return {
      operation: 'keyword_research',
      status: rows.length ? 'complete' : 'empty',
      // Semrush silently omits phrases it has no data for, so the caller needs
      // the requested count to see which ones came back at all.
      coverage: { database, apiVersion: 'v3', requestedKeywords: keywords.length, returnedKeywords: rows.length },
      rows,
    };
  }

  /**
   * Both comparison operations run on `domain_domains`. The leading sign is the
   * operator: `*` includes a domain, `-` excludes it. A gap is therefore the
   * competitors included and the first target excluded, which yields exactly
   * the keywords they rank for and it does not.
   *
   * The response header carries the real domain names, so rows come back keyed
   * by domain rather than by positional P0/P1 columns.
   */
  private async compareDomains(
    apiKey: string,
    operation: 'domain_comparison' | 'keyword_gap',
    targets: readonly string[],
    database: string,
    limit: number,
  ): Promise<SemrushFetchedData> {
    const ordered = operation === 'keyword_gap'
      ? [...targets.slice(1).map(target => `*|or|${target}`), `-|or|${targets[0]}`]
      : targets.map(target => `*|or|${target}`);
    const url = new URL(V3_API_URL);
    url.search = new URLSearchParams({
      key: apiKey,
      type: 'domain_domains',
      domains: ordered.join('|'),
      database,
      display_limit: String(limit),
      // Exactly one position column per domain; asking for more returns
      // placeholder "DomainN Pos" headers for domains that were never sent.
      export_columns: ['Ph', 'Nq', 'Cp', 'Co', ...targets.map((_, index) => `P${index}`)].join(','),
    }).toString();
    const text = await this.text(url, {});
    const rows = readSemrushRows(text).slice(0, limit);
    const hasPossibleNextPage = rows.length === limit;
    return {
      operation,
      status: rows.length ? (hasPossibleNextPage ? 'partial' : 'complete') : 'empty',
      coverage: {
        database,
        apiVersion: 'v3',
        targets: [...targets],
        ...(operation === 'keyword_gap' ? { excludedTarget: targets[0] } : {}),
        limit,
      },
      rows,
    };
  }

  /**
   * The Backlinks host answers one target per request, so a comparison is N
   * sequential calls — each billed. It also returns an empty `target` column,
   * so the domain is stamped back onto its row or the comparison is unreadable.
   */
  private async backlinksComparison(apiKey: string, targets: readonly string[]): Promise<SemrushFetchedData> {
    const returnedRows: Array<Record<string, string>> = [];
    const missingTargets: string[] = [];
    for (const target of targets) {
      const url = new URL(ANALYTICS_V1_API_URL);
      url.search = new URLSearchParams({
        key: apiKey,
        type: 'backlinks_overview',
        target,
        target_type: 'root_domain',
        export_columns: 'target,ascore,total,domains_num,urls_num,ips_num,follows_num,nofollows_num,texts_num,images_num',
      }).toString();
      const text = await this.text(url, {});
      const parsed = readSemrushRows(text);
      if (parsed.length === 0) {
        missingTargets.push(target);
        continue;
      }
      for (const row of parsed) {
        returnedRows.push({
          ...Object.fromEntries(Object.entries({ ...row, target }).map(([column, value]) => [
            BACKLINKS_COLUMN_LABELS[column] ?? column,
            value,
          ])),
          [BACKLINKS_PROVIDER_DATA_STATUS_COLUMN]: 'Returned',
        });
      }
    }
    // Do not invent zero-valued metrics when a requested target has no report.
    // A placeholder preserves comparison coverage and names the provider state.
    const rows = [
      ...returnedRows,
      ...missingTargets.map(target => ({
        Target: target,
        [BACKLINKS_PROVIDER_DATA_STATUS_COLUMN]: 'No provider data',
      })),
    ];
    return {
      operation: 'backlinks_comparison',
      status: rows.length ? 'complete' : 'empty',
      coverage: {
        apiVersion: 'analytics_v1',
        targets: [...targets],
        returnedTargets: targets.filter(target => !missingTargets.includes(target)),
        ...(missingTargets.length > 0 ? { missingTargets } : {}),
        requestsBilled: targets.length,
      },
      rows,
    };
  }

  private async text(url: URL, headers: Record<string, string>): Promise<string> {
    const response = await this.request(url, headers);
    return response.text();
  }

  private async request(url: URL, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        method: 'GET',
        headers: { Accept: 'application/json,text/csv,text/plain', ...headers },
        signal: controller.signal,
      });
      if (response.ok) return response;
      const body = (await response.text()).slice(0, 500);
      if (/ERROR 132|API UNITS BALANCE IS ZERO/i.test(body)) throw new SemrushServiceError('provider_insufficient_units', 'Semrush reports insufficient API units.');
      if (/ERROR 605\b/i.test(body)) throw new SemrushServiceError('no_more_rows', 'Semrush has no rows at this offset.');
      if (response.status === 401 || /ERROR (?:70|110|120|121|122)\b|INVALID IMPORT KEY|WRONG (?:KEY|FORMAT)/i.test(body)) {
        throw new SemrushServiceError('provider_auth_failed', 'Semrush rejected the configured API key.');
      }
      if (response.status === 429) throw new SemrushServiceError('rate_limited', 'Semrush rate limit reached; no retry was attempted.');
      throw new SemrushServiceError('provider_failure', `Semrush request failed with HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof SemrushServiceError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new SemrushServiceError('timeout', 'Semrush request timed out; no retry was attempted because the request may have been billed.');
      throw new SemrushServiceError('provider_failure', 'Semrush request could not be completed.');
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseSemicolonCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0] ?? '');
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

/**
 * Semrush answers with HTTP 200 and a plain-text body for success, no-match and
 * failure alike, so the body is the only thing that distinguishes them.
 *
 * `ERROR 50 :: NOTHING FOUND` is a completed report with no matching rows — a
 * comparison of domains that share no keywords returns it routinely — so it is
 * an empty result, not a failure. Treating it as an error would report "Semrush
 * failed" for a question that simply has no answer.
 */
function readSemrushRows(text: string): Array<Record<string, string>> {
  const trimmed = text.trim();
  if (!trimmed) throw new SemrushServiceError('provider_failure', 'Semrush returned an empty response body.');
  if (/ERROR 132|API UNITS BALANCE IS ZERO/i.test(trimmed)) {
    throw new SemrushServiceError('provider_insufficient_units', 'Semrush reports insufficient API units.');
  }
  if (/^ERROR\s+(?:70|110|120|121|122)\b|INVALID IMPORT KEY|WRONG (?:KEY|FORMAT)/i.test(trimmed)) {
    throw new SemrushServiceError('provider_auth_failed', 'Semrush rejected the configured API key.');
  }
  if (/^ERROR\s+50\b/i.test(trimmed) || /NOTHING FOUND/i.test(trimmed)) return [];
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (trimmed.startsWith('ERROR')) {
    throw new SemrushServiceError('provider_failure', `Semrush returned an error for this official request: ${firstLine.slice(0, 120)}`);
  }
  // Every report is semicolon-delimited. A prose body is a provider failure the
  // documented contract does not cover — "Validation Error : target" and
  // "Internal Server Error" both arrive this way — and parsing one as CSV would
  // silently produce a single nonsense row instead of an error.
  if (!firstLine.includes(';')) {
    throw new SemrushServiceError('provider_failure', `Semrush returned an unexpected response: ${firstLine.slice(0, 120)}`);
  }
  return parseSemicolonCsv(text);
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
    } else if (char === ';' && !quoted) { values.push(value); value = ''; } else value += char;
  }
  values.push(value);
  return values;
}
