import { randomUUID } from 'node:crypto';
import type { SemrushFetchedData, SemrushToolArgs } from '../../application/semrush/semrush.types';
import { SemrushServiceError } from '../../application/semrush/semrush.types';

const DPA_RPC_URL = 'https://www.semrush.com/dpa/rpc';
const BACKLINKS_WEBAPI_URL = 'https://www.semrush.com/backlinks/webapi2/';

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
 * Divo-specific Semrush web-session workaround.
 *
 * Keep this wrapper intentionally separate from SemrushClient. The official
 * api.semrush.com reports can run out of units for shapes that still work
 * through the Semrush web app endpoints we validated manually. Do not collapse
 * this back into the official API client unless the product decision changes
 * and the private web contracts are removed from docs/SEMRUSH-VALIDATION-NOTES.
 *
 * Secrets stay backend-owned: callers pass tool args only, and this client reads
 * the configured web api key/cookie from env via composition.
 */
export class SemrushWebClient {
  constructor(private readonly deps: {
    readonly enabled: boolean;
    readonly apiKey?: string;
    readonly cookie?: string;
    readonly timeoutMs: number;
    readonly fetchImpl?: typeof fetch;
  }) {}

  supports(args: SemrushToolArgs): boolean {
    return this.configured()
      && (args.operation === 'domain_overview' || args.operation === 'backlinks_comparison');
  }

  async fetch(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    if (!this.supports(args)) {
      throw new SemrushServiceError('not_configured', 'Semrush web session is not configured on this backend.');
    }
    switch (args.operation) {
      case 'domain_overview':
        return this.domainOverview(args.domain, args.database ?? 'in');
      case 'backlinks_comparison':
        return this.backlinksComparison(args.targets);
      default:
        throw new SemrushServiceError('capability_unavailable', `${args.operation} has no verified Semrush web contract yet.`);
    }
  }

  private configured(): boolean {
    return this.deps.enabled
      && Boolean(this.deps.apiKey?.trim())
      && Boolean(this.deps.cookie?.trim());
  }

  private async domainOverview(domain: string, database: string): Promise<SemrushFetchedData> {
    const payload = {
      id: Date.now(),
      jsonrpc: '2.0',
      method: 'ranks.Ranks',
      params: {
        request_id: randomUUID(),
        report: 'organic.overview',
        args: {
          database,
          searchItem: domain,
          searchType: 'domain',
          dateType: 'daily',
          display: {
            order: { field: 'positions', direction: 'desc' },
            page: 1,
            pageSize: 25,
          },
        },
        apiKey: this.deps.apiKey!.trim(),
      },
    };
    const body = await this.jsonRpc(payload);
    const result = Array.isArray(body.result) ? body.result : [];
    const selected = result.find(row => objectValue(row, 'database') === database) ?? result[0];
    const row = selected && typeof selected === 'object'
      ? domainOverviewRow(selected as Record<string, unknown>)
      : undefined;
    return {
      operation: 'domain_overview',
      status: row ? 'complete' : 'empty',
      coverage: {
        domain,
        database,
        apiVersion: 'web_dpa',
        report: 'organic.overview',
      },
      rows: row ? [row] : [],
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
        Cookie: this.deps.cookie!.trim(),
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
      status: 'complete',
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
        Cookie: this.deps.cookie!.trim(),
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
        throw new SemrushServiceError('provider_auth_failed', 'Semrush web session was rejected.');
      }
      if (response.status === 429) {
        throw new SemrushServiceError('rate_limited', 'Semrush web rate limit reached; no retry was attempted.');
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

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function webFailure(status: unknown, fallback: string): SemrushServiceError {
  const serialized = typeof status === 'string'
    ? status
    : status && typeof status === 'object'
      ? JSON.stringify(status)
      : '';
  if (/auth|forbidden|denied|session/i.test(serialized)) {
    return new SemrushServiceError('provider_auth_failed', 'Semrush web session was rejected.');
  }
  if (/limit|rate/i.test(serialized)) {
    return new SemrushServiceError('rate_limited', 'Semrush web rate limit reached; no retry was attempted.');
  }
  return new SemrushServiceError('provider_failure', serialized ? `${fallback} ${serialized.slice(0, 160)}` : fallback);
}
