import { createHash, randomUUID } from 'node:crypto';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import { CompanyOmsConnectionRepository, type SafeOmsConnection } from '../../infrastructure/persistence/company-oms-connection.repository';
import { OmsSiteDataClient } from '../../infrastructure/oms/oms-site-data.client';
import type { OmsFetchedData, OmsSiteDataToolArgs } from './oms-site-data.types';
import { OmsSiteDataServiceError } from './oms-site-data.types';
import type { ApiKeyExhaustionNotifierPort } from '../governance/api-key-exhaustion.notifier';

const CONNECTION_PROOF_TTL_SECONDS = 10 * 60;
type Verification = { companyId: string; userId: string; fingerprint: string };

/** Owns company-scoped OMS connection readiness and provider execution. */
export class CompanyOmsSiteDataService {
  private exhaustionNotifier: ApiKeyExhaustionNotifierPort | undefined;

  constructor(
    private readonly connections: CompanyOmsConnectionRepository,
    private readonly client: OmsSiteDataClient,
    private readonly cache: CachePort,
    private readonly logger: Logger,
    private readonly environmentApiKey: string,
  ) {}

  bindExhaustionNotifier(notifier: ApiKeyExhaustionNotifierPort): void {
    this.exhaustionNotifier = notifier;
  }

  async verify(companyId: string, userId: string, apiKey: string): Promise<{ verificationToken: string }> {
    const key = apiKey.trim();
    if (!key) throw new Error('An OMS Site Data API key is required.');
    await this.client.verifyKey(key);
    const verificationToken = randomUUID();
    const stored = await this.cache.set(proofKey(verificationToken), {
      companyId,
      userId,
      fingerprint: fingerprint(key),
    } satisfies Verification, CONNECTION_PROOF_TTL_SECONDS);
    if (!stored.ok) throw new Error('Unable to retain OMS connection verification proof. Please test the key again.');
    return { verificationToken };
  }

  async saveVerified(input: { companyId: string; userId: string; label: string; apiKey: string; verificationToken: string }): Promise<SafeOmsConnection> {
    const proof = await this.cache.get<Verification>(proofKey(input.verificationToken));
    await this.cache.del(proofKey(input.verificationToken));
    if (!proof.ok || !proof.value || proof.value.companyId !== input.companyId || proof.value.userId !== input.userId || proof.value.fingerprint !== fingerprint(input.apiKey)) {
      throw new Error('Test this exact OMS Site Data API key successfully before saving it.');
    }
    return this.connections.saveVerified(input);
  }

  async preflight(companyId: string, args: OmsSiteDataToolArgs): Promise<Record<string, unknown>> {
    const connection = await this.requireActiveConnection(companyId);
    return {
      configured: true,
      enabled: true,
      operation: args.operation,
      connectionSource: connection.source,
      limits: { maxRowsPerResponse: 100, maxProfileWebsites: 20 },
      caveats: ['The provider has no pagination.', 'A 200 response with an empty body is ambiguous and is never reported as no matching data.'],
    };
  }

  async execute(input: { companyId: string; args: OmsSiteDataToolArgs }): Promise<OmsFetchedData> {
    const connection = await this.requireActiveConnection(input.companyId);
    try {
      const data = await this.client.fetch(connection.apiKey, input.args);
      if (connection.source === 'company') await this.connections.markSuccess(connection.id);
      void this.exhaustionNotifier?.clear(input.companyId, 'oms_site_data');
      return data;
    } catch (error) {
      const normalized = error instanceof OmsSiteDataServiceError
        ? error
        : new OmsSiteDataServiceError('provider_failure', 'OMS Site Data request failed.');
      const unavailableUntil = normalized.code === 'provider_auth_failed'
        ? new Date(Date.now() + 15 * 60_000)
        : undefined;
      if (connection.source === 'company') await this.connections.markFailure(connection.id, normalized.code, unavailableUntil).catch((markError) => {
        this.logger.warn('oms.site_data.connection_failure_not_recorded', {
          companyId: input.companyId,
          code: normalized.code,
          error: markError instanceof Error ? markError.message : String(markError),
        });
      });
      if (normalized.code === 'provider_auth_failed') {
        void this.exhaustionNotifier?.notifyIfExhausted({
          companyId: input.companyId,
          provider: 'oms_site_data',
          code: normalized.code,
          message: normalized.message,
          source: 'company-oms-site-data.execute',
        });
      }
      throw normalized;
    }
  }

  private async requireActiveConnection(companyId: string) {
    const connection = await this.connections.findActive(companyId);
    if (connection) return { source: 'company' as const, id: connection.id, apiKey: connection.apiKey };
    // An admin-managed connection takes precedence over the environment fallback.
    // Its disabled/revoked state is therefore an effective company kill switch.
    if (await this.connections.hasConfiguredConnection(companyId)) {
      throw new OmsSiteDataServiceError('disabled', 'OMS Site Data is disabled or temporarily unavailable for this company.');
    }
    const apiKey = this.environmentApiKey.trim();
    if (apiKey) return { source: 'environment' as const, id: 'environment', apiKey };
    throw new OmsSiteDataServiceError('not_configured', 'OMS Site Data has not been configured for this company.');
  }
}

function proofKey(token: string): string { return `oms:site-data:verification:${token}`; }
function fingerprint(apiKey: string): string { return createHash('sha256').update(apiKey.trim()).digest('hex'); }
