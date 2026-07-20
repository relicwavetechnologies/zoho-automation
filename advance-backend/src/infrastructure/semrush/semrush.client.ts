import { URL, URLSearchParams } from 'node:url';
import type { SemrushFetchedData, SemrushToolArgs } from '../../application/semrush/semrush.types';
import { operationApiVersion, SemrushServiceError } from '../../application/semrush/semrush.types';

const V3_API_URL = 'https://api.semrush.com/';

export class SemrushClient {
  constructor(private readonly deps: { timeoutMs: number; fetchImpl?: typeof fetch } ) {}

  async fetch(input: { apiKey: string; args: SemrushToolArgs }): Promise<SemrushFetchedData> {
    const requiredVersion = operationApiVersion[input.args.operation];
    if (!requiredVersion) {
      throw new SemrushServiceError('capability_unavailable', `${input.args.operation} has no verified official Semrush API contract yet.`);
    }
    switch (input.args.operation) {
      case 'domain_overview': return this.domainOverview(input.apiKey, input.args.domain, input.args.database ?? 'in');
      case 'organic_positions': return this.organicPositions(input.apiKey, input.args.domain, input.args.database ?? 'in', input.args.limit ?? 100, input.args.offset ?? 0);
      default:
        throw new SemrushServiceError('capability_unavailable', `${input.args.operation} has no verified official Semrush API contract yet.`);
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
    assertV3Success(text);
    const rows = parseSemicolonCsv(text).slice(0, 1);
    return { operation: 'domain_overview', status: rows.length ? 'complete' : 'empty', coverage: { domain, database, apiVersion: 'v3' }, rows };
  }

  private async organicPositions(apiKey: string, domain: string, database: string, limit: number, offset: number): Promise<SemrushFetchedData> {
    const url = new URL(V3_API_URL);
    url.search = new URLSearchParams({
      key: apiKey,
      type: 'domain_organic',
      domain,
      database,
      display_limit: String(limit),
      display_offset: String(offset),
      export_columns: 'Ph,Po,Nq,Cp,Ur,Tr,Tc',
    }).toString();
    const text = await this.text(url, {});
    assertV3Success(text);
    const rows = parseSemicolonCsv(text).slice(0, limit);
    // v3's tabular response does not include a reliable total count. A full
    // requested page is therefore deliberately reported as partial rather
    // than pretending the result set is exhausted.
    const hasPossibleNextPage = rows.length === limit;
    return {
      operation: 'organic_positions',
      status: rows.length ? (hasPossibleNextPage ? 'partial' : 'complete') : 'empty',
      coverage: { domain, database, apiVersion: 'v3', offset, limit },
      rows,
      ...(hasPossibleNextPage ? { nextPage: String(offset + limit) } : {}),
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
      if (response.status === 401 || response.status === 403) throw new SemrushServiceError('provider_auth_failed', 'Semrush rejected the configured API key.');
      if (response.status === 429) throw new SemrushServiceError('rate_limited', 'Semrush rate limit reached; no retry was attempted.');
      if (body.includes('ERROR 132')) throw new SemrushServiceError('provider_insufficient_units', 'Semrush reports insufficient API units.');
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

function assertV3Success(text: string): void {
  if (!text.trim().startsWith('ERROR')) return;
  if (text.includes('ERROR 132')) throw new SemrushServiceError('provider_insufficient_units', 'Semrush reports insufficient API units.');
  throw new SemrushServiceError('provider_failure', 'Semrush returned an error for this official v3 request.');
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
