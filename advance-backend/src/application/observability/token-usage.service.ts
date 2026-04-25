/**
 * TokenUsageService — AI token consumption tracking.
 *
 * Records actual token counts from the Vercel AI SDK response metadata
 * after each LLM call. This feeds cost attribution dashboards.
 *
 * Design:
 *   - All writes are fire-and-forget (non-fatal)
 *   - One row per LLM call (planner, executor tool-derive, synthesis)
 *   - Actual counts come from `usage` in Vercel AI generateText/generateObject responses
 *   - If the SDK doesn't return token counts, the row is skipped
 *
 * Usage in executor/planner/synthesis:
 *   tokenUsageService.record({ companyId, userId, agentTarget: 'planner',
 *     modelId: 'gpt-4o', provider: 'openai', channel,
 *     actualInputTokens: usage.promptTokens,
 *     actualOutputTokens: usage.completionTokens });
 */

import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecordTokensInput {
  companyId:           string;
  userId:              string;
  agentTarget:         string;   // e.g. 'planner', 'executor', 'synthesis'
  modelId:             string;   // e.g. 'gpt-4o', 'gpt-4o-mini'
  provider:            string;   // 'openai' | 'anthropic' | 'google'
  channel:             string;
  threadId?:           string;
  actualInputTokens?:  number;
  actualOutputTokens?: number;
  wasCompacted?:       boolean;
  mode?:               string;
}

export interface TokenUsageSummary {
  modelId:             string;
  totalInputTokens:    number;
  totalOutputTokens:   number;
  callCount:           number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class TokenUsageService {
  constructor(
    private readonly prisma:  PrismaClient,
    private readonly logger:  Logger,
  ) {}

  /**
   * Record token usage for one LLM call.
   * Call this after every generateText/generateObject response.
   * Fire-and-forget — never throws.
   */
  record(input: RecordTokensInput): void {
    // Skip if no actual counts reported by SDK
    if (
      (input.actualInputTokens === undefined || input.actualInputTokens === 0) &&
      (input.actualOutputTokens === undefined || input.actualOutputTokens === 0)
    ) {
      return;
    }

    this.prisma.aiTokenUsage.create({
      data: {
        companyId:   input.companyId,
        userId:      input.userId,
        agentTarget: input.agentTarget,
        modelId:     input.modelId,
        provider:    input.provider,
        channel:     input.channel,
        mode:        input.mode ?? 'high',
        wasCompacted: input.wasCompacted ?? false,
        ...(input.threadId            ? { threadId:            input.threadId }            : {}),
        ...(input.actualInputTokens  !== undefined ? { actualInputTokens:  input.actualInputTokens }  : {}),
        ...(input.actualOutputTokens !== undefined ? { actualOutputTokens: input.actualOutputTokens } : {}),
      },
    }).catch(e => {
      this.logger.warn('token_usage.record.failed', {
        agentTarget: input.agentTarget,
        error:       String(e),
      });
    });
  }

  /** Summarise token usage for a company over a date range (for cost dashboards). */
  async summariseByModel(input: {
    companyId: string;
    from:      Date;
    to:        Date;
  }): Promise<TokenUsageSummary[]> {
    const rows = await this.prisma.aiTokenUsage.groupBy({
      by:      ['modelId'],
      where:   {
        companyId: input.companyId,
        createdAt: { gte: input.from, lte: input.to },
      },
      _sum:  { actualInputTokens: true, actualOutputTokens: true },
      _count: { id: true },
    });

    return rows.map(r => ({
      modelId:             r.modelId,
      totalInputTokens:    r._sum.actualInputTokens  ?? 0,
      totalOutputTokens:   r._sum.actualOutputTokens ?? 0,
      callCount:           r._count.id,
    }));
  }
}
