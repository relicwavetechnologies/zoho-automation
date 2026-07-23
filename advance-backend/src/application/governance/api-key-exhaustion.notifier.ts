import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import type { ApprovalResolverService } from '../approval/approval-resolver.service';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import { buildApiKeyExhaustionCard } from './api-key-exhaustion.card';
import {
  isApiKeyExhausted,
  type ApiKeyProvider,
  type ExhaustionSignal,
} from './api-key-exhaustion.classifier';

const DEDUP_TTL_SECONDS = 24 * 60 * 60;

export type ApiKeyExhaustionNotifyInput = ExhaustionSignal & {
  readonly companyId: string;
  readonly provider: ApiKeyProvider;
  readonly source?: string;
  /** Caller already confirmed exhaustion (e.g. Serper pool drained). Skip classifier. */
  readonly force?: boolean;
};

type LarkDmPort = Pick<LarkChannelAdapter, 'sendDirectCard'>;

/**
 * First-fire company-admin Lark DM when a backend API key is exhausted.
 * Fail-open: never throws into the user-facing request path.
 */
export class ApiKeyExhaustionNotifier {
  constructor(
    private readonly deps: {
      cache: CachePort;
      approvalResolver: ApprovalResolverService;
      larkAdapter: LarkDmPort;
      logger: Logger;
    },
  ) {}

  /** Clear the dedup key after a successful call so a later exhaustion can alert again. */
  async clear(companyId: string, provider: ApiKeyProvider): Promise<void> {
    if (!companyId) return;
    try {
      await this.deps.cache.del(dedupKey(companyId, provider));
    } catch (error) {
      this.deps.logger.warn('api_key_exhaustion.clear_failed', {
        companyId,
        provider,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async notifyIfExhausted(input: ApiKeyExhaustionNotifyInput): Promise<{ notified: boolean }> {
    try {
      if (!input.companyId) return { notified: false };
      if (!input.force && !isApiKeyExhausted(input)) return { notified: false };

      const code = (input.code ?? `http_${input.httpStatus ?? 'unknown'}`).trim() || 'exhausted';
      const message = (input.message ?? 'API key exhausted or quota reached.').trim();
      const key = dedupKey(input.companyId, input.provider);

      const claimed = await this.deps.cache.setNx(
        key,
        { companyId: input.companyId, provider: input.provider, code, at: new Date().toISOString() },
        DEDUP_TTL_SECONDS,
      );
      if (!claimed.ok) {
        this.deps.logger.warn('api_key_exhaustion.dedup_unavailable', {
          companyId: input.companyId,
          provider: input.provider,
        });
        return { notified: false };
      }
      if (!claimed.value) {
        this.deps.logger.debug('api_key_exhaustion.dedup_skip', {
          companyId: input.companyId,
          provider: input.provider,
          code,
        });
        return { notified: false };
      }

      const admin = await this.deps.approvalResolver.resolveCompanyAdmin(input.companyId);
      if (!admin?.larkOpenId) {
        this.deps.logger.warn('api_key_exhaustion.no_admin', {
          companyId: input.companyId,
          provider: input.provider,
          code,
        });
        return { notified: false };
      }

      const card = buildApiKeyExhaustionCard({
        provider: input.provider,
        code,
        message,
        detectedAt: new Date().toISOString(),
      });
      const sent = await this.deps.larkAdapter.sendDirectCard(admin.larkOpenId, card);
      if (!sent.ok) {
        this.deps.logger.warn('api_key_exhaustion.lark_send_failed', {
          companyId: input.companyId,
          provider: input.provider,
          adminUserId: admin.userId,
          reason: sent.error.message,
        });
        // Keep dedup so we do not hammer Lark while delivery is broken.
        return { notified: false };
      }

      this.deps.logger.info('api_key_exhaustion.notified', {
        companyId: input.companyId,
        provider: input.provider,
        code,
        adminUserId: admin.userId,
        source: input.source,
        messageId: sent.value.messageId,
      });
      return { notified: true };
    } catch (error) {
      this.deps.logger.warn('api_key_exhaustion.notify_failed', {
        companyId: input.companyId,
        provider: input.provider,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { notified: false };
    }
  }
}

export type ApiKeyExhaustionNotifierPort = Pick<ApiKeyExhaustionNotifier, 'notifyIfExhausted' | 'clear'>;

function dedupKey(companyId: string, provider: ApiKeyProvider): string {
  return `api-key-exhausted:${companyId}:${provider}`;
}
