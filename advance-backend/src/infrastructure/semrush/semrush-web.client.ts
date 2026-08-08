import { randomUUID } from 'node:crypto';
import type { SemrushFetchedData, SemrushToolArgs } from '../../application/semrush/semrush.types';
import { SemrushServiceError } from '../../application/semrush/semrush.types';

const DPA_RPC_URL = 'https://www.semrush.com/dpa/rpc';
const BACKLINKS_WEBAPI_URL = 'https://www.semrush.com/backlinks/webapi2/';

/**
 * These reach a member, so they name the thing an administrator can actually
 * act on. Earlier wording blamed the "web session", which sent people hunting
 * for a fresh browser cookie — a value Semrush ignores on every wired route.
 */
const SEMRUSH_CREDENTIAL_REJECTED = 'Semrush rejected the configured API key.';
const SEMRUSH_QUOTA_EXHAUSTED = 'The configured Semrush API key has used up its allowance.';
const SEMRUSH_THROTTLED = 'Semrush is throttling requests; the same key works again shortly.';

/**
 * Semrush DPA dedupes on `params.request_id`. Senior curls use a UUID-shaped value
 * (for example `898248e6-0c40-0ecf-f2a1-15f31a189833`); reusing one is rejected.
 */
export function nextSemrushDpaRequestId(): string {
  return randomUUID();
}

const BACKLINKS_COLUMN_LABELS: Readonly<Record<string, string>> = {
  ascore: 'Authority Score',
  total: 'Backlinks',
  domains: 'Referring Domains',
  refdomains: 'Referring Domains',
  ip: 'Referring IPs',
  follow: 'Follow Links',
  nofollow: 'Nofollow Links',
  text: 'Text Links',
  image: 'Image Links',
  form: 'Form Links',
  frame: 'Frame Links',
  visits: 'Traffic',
};

/**
 * Backend-owned Semrush web session integration (`www.semrush.com` only).
 *
 * Each method maps to a senior-validated private recipe. Do not call
 * `api.semrush.com` from this client.
 */
export class SemrushWebClient {
  constructor(private readonly deps: {
    readonly apiKey?: string;
    readonly cookie?: string;
    readonly timeoutMs: number;
    readonly fetchImpl?: typeof fetch;
  }) {}

  assertConfigured(): void {
    if (!this.configured()) {
      throw new SemrushServiceError(
        'not_configured',
        'Semrush is not configured. Set SEMRUSH_WEB_API_KEY in the backend environment.',
      );
    }
  }

  async fetch(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    this.assertConfigured();
    switch (args.operation) {
      case 'domain_overview':
        return this.domainOverview(args.domain, args.database ?? 'in');
      case 'backlinks_comparison':
        return this.backlinksComparison(args.targets);
      case 'keyword_position_trend':
        return this.keywordPositionTrend(args);
      default:
        throw new SemrushServiceError('capability_unavailable', `${(args as { operation: string }).operation} is not available through Semrush web.`);
    }
  }

  /**
   * The key alone. Every wired route authenticates on `key`/`apiKey` and
   * answers identically with a valid cookie, no cookie, or a fabricated one —
   * so requiring a cookie only invented a refusal for a request Semrush would
   * have served. A cookie is still sent when configured, because the excluded
   * `/analytics/backlinks/webapi2` route does read it.
   */
  private configured(): boolean {
    return Boolean(this.deps.apiKey?.trim());
  }

  private sessionHeaders(): Record<string, string> {
    const cookie = this.deps.cookie?.trim();
    return cookie ? { Cookie: cookie } : {};
  }

  private buildDpaRpcPayload(
    method: string,
    report: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: Math.trunc(Math.random() * 1_000_000_000),
      jsonrpc: '2.0',
      method,
      params: {
        request_id: nextSemrushDpaRequestId(),
        report,
        args,
        apiKey: this.deps.apiKey!.trim(),
      },
    };
  }

  private async domainOverview(domain: string, database: string): Promise<SemrushFetchedData> {
    const payload = this.buildDpaRpcPayload('ranks.Ranks', 'organic.overview', {
      database,
      searchItem: domain,
      searchType: 'domain',
      dateType: 'daily',
      display: {
        order: { field: 'positions', direction: 'desc' },
        page: 1,
        pageSize: 200,
      },
    });
    const body = await this.jsonRpc(payload);
    const result = Array.isArray(body.result) ? body.result : [];
    const rows = result
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
      .map(row => domainOverviewRow(row))
      .sort(byRequestedDatabaseThenTraffic(database));
    return {
      operation: 'domain_overview',
      status: rows.length ? 'complete' : 'empty',
      coverage: {
        domain,
        database,
        databasesReturned: rows.length,
        apiVersion: 'web_dpa',
        report: 'organic.overview',
      },
      rows,
    };
  }

  private async keywordPositionTrend(args: Extract<SemrushToolArgs, { operation: 'keyword_position_trend' }>): Promise<SemrushFetchedData> {
    const database = args.database ?? 'in';
    const payload = this.buildDpaRpcPayload('organic.KeywordPositionTrend', 'organic.positions', {
      database,
      searchItem: args.domain,
      searchType: 'domain',
      date: args.date,
      dateType: args.dateType ?? 'daily',
      keyword: args.keyword,
      dateFormat: 'date',
      positionsType: 'organic',
    });
    const body = await this.jsonRpc(payload);
    const rows = normalizeRpcRows(body.result);
    return {
      operation: 'keyword_position_trend',
      status: rows.length ? 'complete' : 'empty',
      coverage: {
        domain: args.domain,
        keyword: args.keyword,
        date: args.date,
        database,
        apiVersion: 'web_dpa',
        report: 'organic.positions',
        method: 'organic.KeywordPositionTrend',
      },
      rows,
    };
  }

  private async backlinksComparison(targets: readonly string[]): Promise<SemrushFetchedData> {
    const form = new URLSearchParams();
    form.set('key', this.deps.apiKey!.trim());
    form.set('type', 'backlinks_comparison');
    form.set(
      'export_columns',
      'ascore,texts_num,forms_num,frames_num,images_num,follows_num,domains_num,ips_num,traffic,backlinks_outgoing_overview',
    );
    for (const target of targets) {
      form.append('targets[]', target);
      form.append('target_types[]', 'root_domain');
    }

    const response = await this.request(BACKLINKS_WEBAPI_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...this.sessionHeaders(),
        'User-Agent': 'Mozilla/5.0',
      },
      body: form,
    });
    const body = await response.json() as {
      status?: unknown;
      data?: unknown;
    };
    if (body.status !== 'SUCCESS') {
      throw webFailure(body.status, 'Semrush web backlinks request failed.');
    }
    const rows = Array.isArray(body.data)
      ? body.data.map(row => backlinksRow(row)).filter((row): row is Record<string, unknown> => row !== undefined)
      : [];
    const returned = new Set(rows.map(row => String(row.Target)));
    const missingTargets = targets.filter(target => !returned.has(target));
    return {
      operation: 'backlinks_comparison',
      status: rows.length ? 'complete' : 'empty',
      coverage: {
        apiVersion: 'web_backlinks',
        targets: [...targets],
        returnedTargets: targets.filter(target => returned.has(target)),
        ...(missingTargets.length > 0 ? { missingTargets } : {}),
        requestsBilled: 1,
      },
      rows: [
        ...rows,
        ...missingTargets.map(target => ({
          Target: target,
          'Provider Data Status': 'No provider data',
        })),
      ],
    };
  }

  private async jsonRpc(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request(DPA_RPC_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.sessionHeaders(),
        Origin: 'https://www.semrush.com',
        Referer: 'https://www.semrush.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json() as Record<string, unknown>;
    if (body.error) throw webFailure(body.error, 'Semrush web DPA request failed.');
    return body;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        ...init,
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (response.status === 401 || response.status === 403) {
        throw new SemrushServiceError('provider_auth_failed', SEMRUSH_CREDENTIAL_REJECTED);
      }
      if (response.status === 429) {
        throw new SemrushServiceError('rate_limited', SEMRUSH_THROTTLED);
      }
      throw new SemrushServiceError('provider_failure', `Semrush web request failed with HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof SemrushServiceError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new SemrushServiceError('timeout', 'Semrush web request timed out.');
      }
      throw new SemrushServiceError('provider_failure', 'Semrush web request could not be completed.');
    } finally {
      clearTimeout(timer);
    }
  }
}

function domainOverviewRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    Database: row.database,
    Domain: row.domain,
    Rank: row.rank,
    'Organic Keywords': row.organicPositions,
    'Organic Traffic': row.organicTraffic,
    'Organic Cost': row.organicTrafficCost,
    'Adwords Keywords': row.adsPositions,
    'Adwords Traffic': row.adsTraffic,
    'Adwords Cost': row.adsTrafficCost,
    'PLA keywords': row.plaPositions,
    'PLA uniques': row.plaCopies,
  };
}

function backlinksRow(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const counters = row.counters && typeof row.counters === 'object'
    ? row.counters as Record<string, unknown>
    : {};
  return {
    Target: row.target,
    ...Object.fromEntries(Object.entries({
      ascore: counters.ascore,
      total: counters.total,
      domains: counters.domains ?? counters.refdomains,
      ip: counters.ip,
      follow: counters.follow,
      nofollow: counters.nofollow,
      text: counters.text,
      image: counters.image,
      form: counters.form,
      frame: counters.frame,
      visits: counters.visits ?? row.visits,
    }).map(([key, metric]) => [BACKLINKS_COLUMN_LABELS[key] ?? key, metric])),
    'Provider Data Status': row.valid === false || row.status === 'not found' ? 'No provider data' : 'Returned',
  };
}

function normalizeRpcRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
      .map(row => flattenRow(row));
  }
  if (result && typeof result === 'object') {
    return [flattenRow(result as Record<string, unknown>)];
  }
  return [];
}

function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        output[nestedKey] = nestedValue;
      }
      continue;
    }
    output[key] = value;
  }
  return output;
}

/**
 * One `organic.overview` call answers with a row per country database — 26 for
 * a small domain. Keeping only the requested one discarded a country breakdown
 * the same request had already paid for, and left "traffic by country" looking
 * like a capability Semrush does not offer.
 *
 * The requested database leads so a single-country question still reads off
 * the first row; the rest follow by the traffic that makes them worth reading.
 */
function byRequestedDatabaseThenTraffic(requested: string) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const aRequested = a.Database === requested;
    const bRequested = b.Database === requested;
    if (aRequested !== bRequested) return aRequested ? -1 : 1;
    return finiteNumber(b['Organic Traffic']) - finiteNumber(a['Organic Traffic']);
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function webFailure(status: unknown, fallback: string): SemrushServiceError {
  const serialized = typeof status === 'string'
    ? status
    : status && typeof status === 'object'
      ? JSON.stringify(status)
      : '';
  if (/auth|forbidden|denied|session/i.test(serialized)) {
    return new SemrushServiceError('provider_auth_failed', SEMRUSH_CREDENTIAL_REJECTED);
  }
  // `Limits exceeded` is the spent-allowance answer, not a slow-down: it keeps
  // coming back for hours while a different key answers the same request. Only
  // an explicit throttle wording is treated as retryable.
  if (/throttl|too many requests|slow down/i.test(serialized)) {
    return new SemrushServiceError('rate_limited', SEMRUSH_THROTTLED);
  }
  if (/limit|quota|unit|credit/i.test(serialized)) {
    return new SemrushServiceError('provider_quota_exhausted', SEMRUSH_QUOTA_EXHAUSTED);
  }
  return new SemrushServiceError('provider_failure', serialized ? `${fallback} ${serialized.slice(0, 160)}` : fallback);
}
