import type { Logger } from '../../shared/logger';
import type { SemrushWebClient } from '../../infrastructure/semrush/semrush-web.client';
import type { SemrushKeyProvider } from './semrush-key.provider';
import {
  type SemrushFetchedData,
  type SemrushToolArgs,
  SemrushServiceError,
} from './semrush.types';

/**
 * Backend-owned Semrush integration via validated `www.semrush.com` recipes only.
 */
/** Codes that mean "this key is finished", as opposed to "Semrush is busy". */
function isSpentKey(error: unknown): boolean {
  return error instanceof SemrushServiceError
    && (error.code === 'provider_auth_failed' || error.code === 'provider_quota_exhausted');
}

export class SemrushService {
  constructor(
    private readonly webClient: SemrushWebClient,
    private readonly keys: SemrushKeyProvider,
    private readonly logger: Logger,
  ) {}

  async execute(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    const request = semrushRequestLogContext(args);
    const apiKey = await this.keys.resolve();
    try {
      return this.complete(request, await this.webClient.fetch({ apiKey, args }));
    } catch (error) {
      if (!isSpentKey(error) || !this.keys.canRotate) throw this.failed(request, error);

      // Keys exhaust in ordinary use, and the webhook knows which one is live.
      // Retrying here rather than inside the client is deliberate: `fetch`
      // rebuilds the request, so the second attempt carries a fresh
      // `params.request_id`. Replaying the body with only the key swapped would
      // be refused as a duplicate however good the replacement was.
      this.keys.invalidate(apiKey);
      const replacement = await this.keys.resolve();
      if (replacement === apiKey) {
        // The source has nothing newer, so a retry would spend the same dead
        // key again and report a different failure for the same cause.
        this.keys.invalidate(replacement);
        throw this.failed(request, error);
      }
      this.logger.warn('semrush.key.rotated', {
        ...request,
        failureCode: error instanceof SemrushServiceError ? error.code : 'unknown',
      });
      try {
        return this.complete(request, await this.webClient.fetch({ apiKey: replacement, args }));
      } catch (retryError) {
        if (isSpentKey(retryError)) this.keys.invalidate(replacement);
        throw this.failed(request, retryError);
      }
    }
  }

  private complete(request: Record<string, unknown>, data: SemrushFetchedData): SemrushFetchedData {
    this.logger.info('semrush.request.complete', {
      ...request,
      status: data.status,
      rowCount: data.rows.length,
    });
    return data;
  }

  private failed(request: Record<string, unknown>, error: unknown): unknown {
    this.logger.warn('semrush.request.failed', {
      ...request,
      failureCode: error instanceof SemrushServiceError ? error.code : 'unknown',
    });
    return error;
  }
}

function semrushRequestLogContext(args: SemrushToolArgs): Record<string, unknown> {
  const base = {
    operation: args.operation,
    apiVersion: 'web_private',
    providerHost: 'www.semrush.com',
    reportType: semrushWebReportType(args),
  };
  if (args.operation === 'domain_overview' || args.operation === 'keyword_position_trend') {
    return {
      ...base,
      domain: args.domain,
      database: args.database ?? 'in',
      ...(args.operation === 'keyword_position_trend'
        ? { keyword: args.keyword, date: args.date }
        : {}),
    };
  }
  return { ...base, targetCount: args.targets.length };
}

function semrushWebReportType(args: SemrushToolArgs): string {
  switch (args.operation) {
    case 'domain_overview':
      return 'dpa/rpc ranks.Ranks organic.overview';
    case 'backlinks_comparison':
      return 'backlinks/webapi2 backlinks_comparison';
    case 'keyword_position_trend':
      return 'dpa/rpc organic.KeywordPositionTrend organic.positions';
  }
}
