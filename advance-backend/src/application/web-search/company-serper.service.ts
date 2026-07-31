import { randomUUID } from 'node:crypto';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import { SerperClient, SearchIntegrationError, type SerperSearchInput, type SerperSearchResponse } from '../../infrastructure/ai/search/serper.client';
import { CompanySerperConnectionRepository, serperKeyFingerprint } from '../../infrastructure/persistence/company-serper-connection.repository';
import type { ApiKeyExhaustionNotifierPort } from '../governance/api-key-exhaustion.notifier';
import { isSerperPoolExhausted } from '../governance/api-key-exhaustion.classifier';

const TEST_TTL_SECONDS = 10 * 60;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_FAILURE_COOLDOWN_MS = 15 * 60_000;
const verificationKey = (token: string) => `serper:verification:${token}`;
type Verification = { companyId: string; userId: string; fingerprint: string };

const cooldownUntil = (error: unknown): Date => {
  if (error instanceof SearchIntegrationError) {
    const delayMs = error.code === 'search_rate_limited'
      ? error.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
      : AUTH_FAILURE_COOLDOWN_MS;
    return new Date(Date.now() + delayMs);
  }
  return new Date(Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
};

/** Owns company Serper credential validation, storage proof, and safe failover. */
export class CompanySerperService {
  private exhaustionNotifier: ApiKeyExhaustionNotifierPort | undefined;

  constructor(
    private readonly connections: CompanySerperConnectionRepository,
    private readonly cache: CachePort,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly legacyApiKey = '',
  ) {}

  bindExhaustionNotifier(notifier: ApiKeyExhaustionNotifierPort): void {
    this.exhaustionNotifier = notifier;
  }

  async verify(companyId: string, userId: string, apiKey: string): Promise<{ verificationToken: string }> {
    const key = apiKey.trim();
    if (!key) throw new Error('An API key is required');
    await new SerperClient({ apiKey: key, timeoutMs: this.timeoutMs }).search({ query: 'Divo connection verification', num: 1 });
    const verificationToken = randomUUID();
    const stored = await this.cache.set(verificationKey(verificationToken), { companyId, userId, fingerprint: serperKeyFingerprint(key) } satisfies Verification, TEST_TTL_SECONDS);
    if (!stored.ok) throw new Error('Unable to retain the verification result. Please test the key again.');
    return { verificationToken };
  }

  async saveVerified(input: { companyId: string; userId: string; label: string; apiKey: string; verificationToken: string; remainingCredits?: number }) {
    const proof = await this.cache.get<Verification>(verificationKey(input.verificationToken));
    await this.cache.del(verificationKey(input.verificationToken));
    if (!proof.ok || !proof.value || proof.value.companyId !== input.companyId || proof.value.userId !== input.userId || proof.value.fingerprint !== serperKeyFingerprint(input.apiKey)) {
      throw new Error('Test this exact API key successfully before saving it.');
    }
    return this.connections.saveVerified(input);
  }

  async search(companyId: string, input: SerperSearchInput): Promise<SerperSearchResponse> {
    const configured = await this.connections.activeKeys(companyId);
    const hasCompanyConnection = configured.length > 0 || await this.connections.hasConnection(companyId);
    const candidates = configured.length > 0
      ? configured
      : !hasCompanyConnection && this.legacyApiKey
        ? [{ id: 'legacy-env', apiKey: this.legacyApiKey }]
        : [];
    if (candidates.length === 0) {
      throw new SearchIntegrationError(
        hasCompanyConnection
          ? 'No eligible Web Search connection is available for this company'
          : 'No Web Search connection is configured for this company',
        hasCompanyConnection ? 'search_unavailable' : 'search_not_configured',
      );
    }
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const result = await new SerperClient({ apiKey: candidate.apiKey, timeoutMs: this.timeoutMs }).search(input);
        if (candidate.id !== 'legacy-env') {
          try {
            await this.connections.markSuccess(candidate.id);
          } catch (error) {
            this.logger.error('serper.connection.usage_record_failed', {
              companyId,
              connectionId: candidate.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        void this.exhaustionNotifier?.clear(companyId, 'serper');
        return result;
      } catch (error) {
        lastError = error;
        const code = error instanceof SearchIntegrationError ? error.code : 'search_unavailable';
        const creditsExhausted = code === 'search_credits_exhausted';
        const shouldFailOver = creditsExhausted || code === 'search_rate_limited' || code === 'search_auth_failed';
        const unavailableUntil = candidate.id !== 'legacy-env' && shouldFailOver && !creditsExhausted ? cooldownUntil(error) : undefined;
        if (candidate.id !== 'legacy-env' && shouldFailOver) {
          try {
            if (creditsExhausted) {
              await this.connections.markCreditsExhausted(candidate.id, code);
            } else {
              await this.connections.markFailure(candidate.id, code, unavailableUntil!);
            }
          } catch (markError) {
            this.logger.error('serper.connection.failure_record_failed', {
              companyId,
              connectionId: candidate.id,
              reason: markError instanceof Error ? markError.message : String(markError),
            });
          }
        }
        if (!shouldFailOver) throw error;
        this.logger.warn('serper.connection.failed_over', {
          companyId,
          connectionId: candidate.id,
          code,
          ...(unavailableUntil ? { unavailableUntil: unavailableUntil.toISOString() } : {}),
        });
      }
    }
    const finalError = lastError instanceof SearchIntegrationError
      ? lastError
      : lastError instanceof Error
        ? new SearchIntegrationError(lastError.message, 'search_unavailable')
        : new SearchIntegrationError('All company Web Search connections are unavailable', 'search_unavailable');
    if (isSerperPoolExhausted({ code: finalError.code, message: finalError.message })) {
      void this.exhaustionNotifier?.notifyIfExhausted({
        companyId,
        provider: 'serper',
        code: finalError.code,
        message: finalError.message,
        source: 'company-serper.search',
        force: true,
      });
    }
    throw finalError;
  }
}
