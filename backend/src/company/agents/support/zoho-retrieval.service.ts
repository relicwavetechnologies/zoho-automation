import { embeddingService } from '../../integrations/embedding';
import { qdrantAdapter } from '../../integrations/vector';
import { logger } from '../../../utils/logger';

export type ZohoRetrievalItem = {
  sourceType: 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';
  sourceId: string;
  chunkIndex: number;
  score: number;
  payload: Record<string, unknown>;
};

export class ZohoRetrievalService {
  async query(input: { companyId: string; text: string; limit?: number }): Promise<ZohoRetrievalItem[]> {
    const limit = Math.max(1, Math.min(10, input.limit ?? 4));
    const startedAt = Date.now();
    try {
      const [queryVector] = await embeddingService.embed([input.text]);
      const matches = await qdrantAdapter.search({
        companyId: input.companyId,
        vector: queryVector,
        limit,
      });

      logger.success('retrieval.query.executed', {
        companyId: input.companyId,
        limit,
        matchCount: matches.length,
        provider: embeddingService.providerName,
        latencyMs: Date.now() - startedAt,
      });

      if (matches.length === 0) {
        logger.info('retrieval.query.empty', {
          companyId: input.companyId,
          limit,
        });
      }

      return matches.map((match) => ({
        sourceType: match.sourceType,
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
