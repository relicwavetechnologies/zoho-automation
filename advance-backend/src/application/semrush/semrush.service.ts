import type { Logger } from '../../shared/logger';
import { SemrushClient } from '../../infrastructure/semrush/semrush.client';
import {
  operationApiVersion,
  type SemrushFetchedData,
  type SemrushToolArgs,
  SemrushServiceError,
} from './semrush.types';

/**
 * Normal server-configured Semrush integration. Credentials remain in the
 * backend environment and every call stays on a fixed official endpoint.
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
  ) {}

  async preflight(args: SemrushToolArgs): Promise<Record<string, unknown>> {
    this.assertOperation(args);
    await this.resolveApiKey();
    return {
      configured: true,
      operation: args.operation,
      apiVersion: operationApiVersion[args.operation],
      limits: preflightLimits(args),
    };
  }

  async execute(args: SemrushToolArgs): Promise<SemrushFetchedData> {
    this.assertOperation(args);
    const apiKey = await this.resolveApiKey();
    let data: SemrushFetchedData;
    try {
      data = await this.client.fetch({ apiKey, args });
    } catch (error) {
      if (!this.apiKeyWebhookUrl || !isCredentialFailure(error)) throw error;
      this.invalidateWebhookApiKey(apiKey);
      let replacement = await this.resolveApiKey();
      if (replacement === apiKey) {
        this.invalidateWebhookApiKey(replacement);
        const configured = this.apiKey?.trim();
        if (!configured || configured === apiKey) throw error;
        replacement = configured;
        this.cachedWebhookApiKey = replacement;
      }
      try {
        data = await this.client.fetch({ apiKey: replacement, args });
      } catch (replacementError) {
        if (isCredentialFailure(replacementError)) this.invalidateWebhookApiKey(replacement);
        throw replacementError;
      }
    }
    this.logger.info('semrush.request.complete', {
      operation: args.operation,
      status: data.status,
      rowCount: data.rows.length,
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
