import { embeddingService } from '../../integrations/embedding';
import { qdrantAdapter } from '../../integrations/vector';
import { logger } from '../../../utils/logger';
import { normalizeEmail, payloadReferencesEmail } from '../../integrations/zoho/zoho-email-scope';
import type { ZohoScopeMode } from '../../tools/zoho-role-access.service';

export type ZohoRetrievalItem = {
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';
  sourceId: string;
  chunkIndex: number;
  score: number;
  payload: Record<string, unknown>;
};

export class ZohoRetrievalService {
  async query(input: {
    companyId: string;
    requesterUserId?: string;
    requesterEmail?: string;
    scopeMode?: ZohoScopeMode;
    strictUserScopeEnabled?: boolean;
    text: string;
    limit?: number;
    sourceTypes?: Array<ZohoRetrievalItem['sourceType']>;
  }): Promise<ZohoRetrievalItem[]> {
    const limit = Math.max(1, Math.min(10, input.limit ?? 4));
    const startedAt = Date.now();
    try {
      const strictUserScopeEnabled = input.strictUserScopeEnabled ?? true;
      const scopeMode = input.scopeMode ?? 'email_scoped';
      const enforceEmailScope = strictUserScopeEnabled && scopeMode !== 'company_scoped';
      const normalizedRequesterEmail = normalizeEmail(input.requesterEmail);
      if (enforceEmailScope && !normalizedRequesterEmail) {
        logger.warn('retrieval.query.blocked_missing_requester_email', {
          companyId: input.companyId,
          scopeMode,
        });
        return [];
      }

      const [queryVector] = await embeddingService.embed([input.text]);
      const matches = await qdrantAdapter.search({
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        requesterEmail: normalizedRequesterEmail,
        enforceEmailMatch: enforceEmailScope,
        vector: queryVector,
        limit,
        sourceTypes: input.sourceTypes ?? ['zoho_lead', 'zoho_contact', 'zoho_deal', 'zoho_ticket'],
        includePersonal: false,
        includeShared: true,
        includePublic: false,
      });

      const safeMatches =
        enforceEmailScope && normalizedRequesterEmail
          ? matches.filter((match) => payloadReferencesEmail(match.payload, normalizedRequesterEmail))
          : matches;

      logger.success('retrieval.query.executed', {
        companyId: input.companyId,
        limit,
        matchCount: safeMatches.length,
        scopeMode,
        provider: embeddingService.providerName,
        latencyMs: Date.now() - startedAt,
      });

      if (safeMatches.length === 0) {
        logger.info('retrieval.query.empty', {
          companyId: input.companyId,
          limit,
        });
      }

      return safeMatches.map((match) => ({
        sourceType: match.sourceType as ZohoRetrievalItem['sourceType'],
        sourceId: match.sourceId,
        chunkIndex: match.chunkIndex,
        score: match.score,
        payload: match.payload,
      }));
    } catch (error) {
      logger.error('retrieval.query.failed', {
        companyId: input.companyId,
        limit,
        error,
      });
      throw error;
    }
  }
}

export const zohoRetrievalService = new ZohoRetrievalService();
