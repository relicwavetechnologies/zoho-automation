import { embeddingService } from '../../integrations/embedding';
import {
  ACTIVE_EMBEDDING_SCHEMA_VERSION,
  qdrantAdapter,
  RETRIEVAL_PROFILE_CONFIG,
} from '../../integrations/vector';
import { googleRankingService } from '../../integrations/search';
import { logger } from '../../../utils/logger';
import { normalizeEmail } from '../../integrations/zoho/zoho-email-scope';
import type { ZohoScopeMode } from '../../tools/zoho-role-access.service';

export type ZohoRetrievalItem = {
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket';
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
    const profile = RETRIEVAL_PROFILE_CONFIG.zoho;
    const limit = Math.max(1, Math.min(profile.finalTopK, input.limit ?? 4));
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

      const [queryVector] = await embeddingService.embedQueries([input.text]);
      const groups = await qdrantAdapter.search({
        companyId: input.companyId,
        requesterUserId: input.requesterUserId,
        requesterEmail: normalizedRequesterEmail,
        enforceEmailMatch: enforceEmailScope,
        denseVector: queryVector,
        lexicalQueryText: input.text,
        limit: profile.groupLimit,
        candidateLimit: profile.branchLimit,
        retrievalProfile: 'zoho',
        fusion: 'dbsf',
        groupByField: 'documentKey',
        groupSize: profile.groupSize,
        rerankTopK: profile.rerankTopN,
        rerankRequired: profile.rerankRequired,
        schemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
        sourceTypes: input.sourceTypes ?? [
          'zoho_lead',
          'zoho_contact',
          'zoho_account',
          'zoho_deal',
          'zoho_ticket',
        ],
        includePersonal: false,
        includeShared: true,
        includePublic: false,
      });
      const matches = groups.flatMap((group) => group.hits);

      const safeMatches =
        enforceEmailScope && normalizedRequesterEmail
          ? matches.filter((match) =>
              Array.isArray(match.payload.relationEmails)
              && match.payload.relationEmails.some(
                (value) => typeof value === 'string' && value.trim().toLowerCase() === normalizedRequesterEmail,
              ),
            )
          : matches;
      const reranked = await googleRankingService.rerank(
        input.text,
        safeMatches.map((match) => ({
          id: `${match.sourceType}:${match.sourceId}:${match.chunkIndex}`,
          documentKey:
            match.documentKey ?? `${input.companyId}:${match.sourceType}:${match.sourceId}`,
          chunkIndex: match.chunkIndex,
          title:
            typeof match.payload.citationTitle === 'string'
              ? match.payload.citationTitle
              : typeof match.payload.title === 'string'
                ? match.payload.title
                : undefined,
          content:
            typeof match.payload._chunk === 'string'
              ? match.payload._chunk
              : typeof match.payload.text === 'string'
                ? match.payload.text
                : '',
          score: match.score,
          payload: match.payload,
        })),
        Math.min(profile.rerankTopN, safeMatches.length),
        { required: profile.rerankRequired },
      );
      const rerankedById = new Map(reranked.map((item) => [item.id, item]));
      const finalMatches = safeMatches
        .filter((match) =>
          rerankedById.has(`${match.sourceType}:${match.sourceId}:${match.chunkIndex}`),
        )
        .sort((left, right) => {
          const leftScore =
            rerankedById.get(`${left.sourceType}:${left.sourceId}:${left.chunkIndex}`)
              ?.rerankScore ?? left.score;
          const rightScore =
            rerankedById.get(`${right.sourceType}:${right.sourceId}:${right.chunkIndex}`)
              ?.rerankScore ?? right.score;
          return rightScore - leftScore;
        })
        .slice(0, limit);

      logger.success('retrieval.query.executed', {
        companyId: input.companyId,
        limit,
        matchCount: finalMatches.length,
        scopeMode,
        provider: embeddingService.providerName,
        latencyMs: Date.now() - startedAt,
      });

      if (finalMatches.length === 0) {
        logger.info('retrieval.query.empty', {
          companyId: input.companyId,
          limit,
        });
      }

      return finalMatches.map((match) => ({
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
