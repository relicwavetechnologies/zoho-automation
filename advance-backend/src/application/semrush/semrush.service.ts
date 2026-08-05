import type { Logger } from '../../shared/logger';
import type { SemrushWebClient } from '../../infrastructure/semrush/semrush-web.client';
import {
  semrushPreflightLimits,
  type SemrushFetchedData,
  type SemrushToolArgs,
  SemrushServiceError,
} from './semrush.types';

/**
 * Backend-owned Semrush integration via validated `www.semrush.com` recipes only.
 */
export class SemrushService {
  constructor(
    private readonly webClient: SemrushWebClient,
    private readonly logger: Logger,
  ) {}

  async preflight(args: SemrushToolArgs): Promise<Record<string, unknown>> {
    this.webClient.assertConfigured();
    return {
      configured: true,
      operation: args.operation,
      apiVersion: 'web_private',
      providerHost: 'www.semrush.com',
      reportType: semrushWebReportType(args),
      limits: semrushPreflightLimits(args),
    };
  }

  async execute(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    this.webClient.assertConfigured();
    const request = semrushRequestLogContext(args);
    try {
      const data = await this.webClient.fetch(args);
      this.logger.info('semrush.request.complete', {
        ...request,
        status: data.status,
        rowCount: data.rows.length,
      });
      return data;
    } catch (error) {
      this.logger.warn('semrush.request.failed', {
        ...request,
        failureCode: error instanceof SemrushServiceError ? error.code : 'unknown',
      });
      throw error;
    }
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
