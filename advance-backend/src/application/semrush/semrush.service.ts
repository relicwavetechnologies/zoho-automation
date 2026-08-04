import type { Logger } from '../../shared/logger';
import { SemrushClient } from '../../infrastructure/semrush/semrush.client';
import {
  operationApiVersion,
  type SemrushFetchedData,
  type SemrushToolArgs,
  SemrushServiceError,
} from './semrush.types';

/**
 * Backend-owned Semrush integration.
 *
 * The official API remains the default path, but selected operations may use
 * the Divo-specific Semrush web-session workaround when configured. That
 * workaround is intentional: it covers validated Semrush web app contracts
 * whose official API equivalents can fail with exhausted units. Do not remove
 * the web client preference as a "cleanup" without rechecking the validation
 * notes and the production failure mode.
 */
export class SemrushService {
  private cachedWebhookApiKey: string | undefined;
  private webhookApiKeyLoad: Promise<string> | undefined;

  constructor(
    private readonly client: SemrushClient,
    private readonly apiKey: string | undefined,
    private readonly logger: Logger,
    private readonly apiKeyWebhookUrl?: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly webClient?: {
      supports(args: SemrushToolArgs): boolean;
      fetch(args: SemrushToolArgs): Promise<SemrushFetchedData>;
    },
  ) {}

  async preflight(args: SemrushToolArgs): Promise<Record<string, unknown>> {
    this.assertOperation(args);
    if (!this.webClient?.supports(args)) await this.resolveApiKey();
    return {
      configured: true,
      operation: args.operation,
      apiVersion: this.webClient?.supports(args) ? 'web_private' : operationApiVersion[args.operation],
      limits: preflightLimits(args),
    };
  }

  async execute(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    this.assertOperation(args);
    const request = semrushRequestLogContext(args);
    // Prefer the custom web wrapper only for explicitly supported operations.
    // If the web session expires we fall back to the official API, but the
    // custom path must stay first while SEMRUSH_WEB_ENABLED is configured.
    if (this.webClient?.supports(args)) {
      try {
        const data = await this.webClient.fetch(args);
        this.logger.info('semrush.request.complete', {
          ...request,
          apiVersion: 'web_private',
          providerHost: 'www.semrush.com',
          reportType: semrushWebReportType(args),
          status: data.status,
          rowCount: data.rows.length,
          attemptedKeySources: ['web_env'],
        });
        return data;
      } catch (error) {
        this.logger.warn('semrush.web_request.failed_falling_back', {
          ...request,
          apiVersion: 'web_private',
          providerHost: 'www.semrush.com',
          reportType: semrushWebReportType(args),
          failureCode: error instanceof SemrushServiceError ? error.code : 'unknown',
        });
      }
    }
    const apiKey = await this.resolveApiKey();
    const attemptedKeySources = [this.apiKeyWebhookUrl ? 'webhook' : 'static_env'];
    let data: SemrushFetchedData;
    try {
      data = await this.client.fetch({ apiKey, args });
    } catch (error) {
      if (!this.apiKeyWebhookUrl || !isCredentialFailure(error)) {
        this.logger.warn('semrush.request.failed', {
          ...request,
          failureCode: error instanceof SemrushServiceError ? error.code : 'unknown',
          attemptedKeySources,
        });
        throw error;
      }
      this.invalidateWebhookApiKey(apiKey);
      let replacement = await this.resolveApiKey();
      attemptedKeySources.push('webhook_refresh');
      if (replacement === apiKey) {
        this.invalidateWebhookApiKey(replacement);
        const configured = this.apiKey?.trim();
        if (!configured || configured === apiKey) {
          this.logger.warn('semrush.request.failed', {
            ...request,
            failureCode: error instanceof SemrushServiceError ? error.code : 'unknown',
            attemptedKeySources,
          });
          throw error;
        }
        replacement = configured;
        this.cachedWebhookApiKey = replacement;
        attemptedKeySources.push('static_env_fallback');
      }
      try {
        data = await this.client.fetch({ apiKey: replacement, args });
      } catch (replacementError) {
        if (isCredentialFailure(replacementError)) this.invalidateWebhookApiKey(replacement);
        this.logger.warn('semrush.request.failed', {
          ...request,
          failureCode: replacementError instanceof SemrushServiceError ? replacementError.code : 'unknown',
          attemptedKeySources,
        });
        throw replacementError;
      }
    }
    this.logger.info('semrush.request.complete', {
      ...request,
      status: data.status,
      rowCount: data.rows.length,
      attemptedKeySources,
    });
    return data;
  }

  private assertOperation(args: SemrushToolArgs): void {
    const apiVersion = operationApiVersion[args.operation];
    if (!apiVersion) throw new SemrushServiceError('capability_unavailable', `${args.operation} has no verified official Semrush API contract yet.`);
  }

  private async resolveApiKey(): Promise<string> {
    if (!this.apiKeyWebhookUrl) {
      const configured = this.apiKey?.trim();
      if (!configured) throw new SemrushServiceError('not_configured', 'Semrush is not configured on this backend.');
      return configured;
    }

    if (this.cachedWebhookApiKey) return this.cachedWebhookApiKey;
    this.webhookApiKeyLoad ??= this.loadWebhookApiKey();
    try {
      this.cachedWebhookApiKey = await this.webhookApiKeyLoad;
      return this.cachedWebhookApiKey;
    } finally {
      this.webhookApiKeyLoad = undefined;
    }
  }

  private async loadWebhookApiKey(): Promise<string> {
    try {
      const response = await this.fetchImpl(this.apiKeyWebhookUrl!, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new SemrushServiceError('provider_failure', `Semrush key webhook failed with HTTP ${response.status}.`);
      }
      const payload = await response.json() as { api_key?: unknown; status?: unknown };
      const apiKey = typeof payload.api_key === 'string' ? payload.api_key.trim() : '';
      if (payload.status !== 'active' || !apiKey) {
        throw new SemrushServiceError('not_configured', 'Semrush key webhook returned no active API key.');
      }
      return apiKey;
    } catch (error) {
      if (error instanceof SemrushServiceError) throw error;
      throw new SemrushServiceError('provider_failure', 'Semrush key webhook could not be reached.');
    }
  }

  private invalidateWebhookApiKey(failedApiKey: string): void {
    if (this.cachedWebhookApiKey === failedApiKey) this.cachedWebhookApiKey = undefined;
  }
}

function preflightLimits(args: SemrushToolArgs): Record<string, number> {
  switch (args.operation) {
    case 'domain_overview': return { maxRowsPerRequest: 1 };
    case 'organic_positions': return { maxRowsPerRequest: 1_000, maxOffset: 9_000 };
    case 'organic_position_trend': return { maxMonthsPerRequest: 120 };
    case 'keyword_research': return { maxKeywordsPerRequest: 25 };
    case 'domain_comparison':
    case 'keyword_gap': return { maxRowsPerRequest: 1_000, maxTargets: 5 };
    case 'backlinks_comparison': return { maxTargets: 10, requestsPerTarget: 1 };
  }
}

function isCredentialFailure(error: unknown): boolean {
  return error instanceof SemrushServiceError
    && ['provider_auth_failed', 'provider_insufficient_units'].includes(error.code);
}

function semrushRequestLogContext(args: SemrushToolArgs): Record<string, unknown> {
  const base = {
    operation: args.operation,
    apiVersion: operationApiVersion[args.operation],
    reportType: semrushReportType(args.operation),
  };
  if ('domain' in args) {
    return {
      ...base,
      domain: args.domain,
      database: args.database ?? 'in',
      ...('limit' in args && args.limit !== undefined ? { limit: args.limit } : {}),
      ...('offset' in args && args.offset !== undefined ? { offset: args.offset } : {}),
    };
  }
  if ('keywords' in args) {
    return { ...base, database: args.database ?? 'in', keywordCount: args.keywords.length };
  }
  if ('targets' in args) {
    return {
      ...base,
      database: 'database' in args ? args.database ?? 'in' : undefined,
      targetCount: args.targets.length,
      ...('limit' in args && args.limit !== undefined ? { limit: args.limit } : {}),
    };
  }
  return base;
}

function semrushReportType(operation: SemrushToolArgs['operation']): string {
  switch (operation) {
    case 'domain_overview': return 'domain_ranks';
    case 'organic_positions': return 'domain_organic';
    case 'organic_position_trend': return 'domain_rank_history';
    case 'keyword_research': return 'phrase_these';
    case 'domain_comparison':
    case 'keyword_gap': return 'domain_domains';
    case 'backlinks_comparison': return 'backlinks_overview';
  }
}

function semrushWebReportType(args: SemrushToolArgs): string {
  switch (args.operation) {
    case 'domain_overview': return 'dpa/rpc ranks.Ranks organic.overview';
    case 'backlinks_comparison': return 'backlinks/webapi2 backlinks_comparison';
    default: return semrushReportType(args.operation);
  }
}
