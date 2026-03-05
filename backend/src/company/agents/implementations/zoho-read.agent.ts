import type { AgentInvokeInputDTO } from '../../contracts';
import { CompanyContextResolutionError, companyContextResolver, zohoRetrievalService } from '../support';
import { BaseAgent } from '../base';

export class ZohoReadAgent extends BaseAgent {
  readonly key = 'zoho-read';

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    try {
      const companyId = await companyContextResolver.resolveCompanyId({
        companyId: input.contextPacket.companyId,
      });
      const matches = await zohoRetrievalService.query({
        companyId,
        text: input.objective,
        limit: 4,
      });

      if (matches.length === 0) {
        return this.success(
          input,
          'No grounded Zoho records found for this query yet.',
          {
            companyId,
            sources: [],
          },
          { latencyMs: Date.now() - startedAt, apiCalls: 2 },
        );
      }

      const topSources = matches.map((match) => `${match.sourceType}:${match.sourceId}#${match.chunkIndex}`);
      return this.success(
        input,
        `Grounded Zoho context found from ${topSources.length} sources.`,
        {
          companyId,
          sources: topSources,
          topScore: matches[0].score,
          records: matches.map((match) => ({
            sourceType: match.sourceType,
            sourceId: match.sourceId,
            chunkIndex: match.chunkIndex,
            score: match.score,
          })),
        },
        { latencyMs: Date.now() - startedAt, apiCalls: 2 },
      );
    } catch (error) {
      if (error instanceof CompanyContextResolutionError) {
        return this.failure(
          input,
          error.message,
          error.code,
          error.message,
          false,
          { latencyMs: Date.now() - startedAt, apiCalls: 1 },
        );
      }

      return this.failure(
        input,
        'Zoho retrieval failed',
        'embedding_unavailable',
        error instanceof Error ? error.message : 'unknown_error',
        true,
        { latencyMs: Date.now() - startedAt, apiCalls: 1 },
      );
    }
  }
}
