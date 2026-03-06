import type { AgentInvokeInputDTO } from '../../contracts';
import { CompanyContextResolutionError, companyContextResolver, zohoRetrievalService } from '../support';
import { BaseAgent } from '../base';
import { resolveWithFallback } from '../../integrations/zoho/zoho-provider.resolver';
import { ZohoIntegrationError } from '../../integrations/zoho/zoho.errors';
import { mastra } from '../../integrations/mastra/mastra.instance';
import { logger } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RESULT_LIMIT = 3;
const MAX_RESULT_LIMIT = 8;
const LIVE_FETCH_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Lightweight types
// ---------------------------------------------------------------------------

type SourceRef = {
  source: 'vector' | 'mcp' | 'rest';
  id: string;
};

type LiveRecord = {
  sourceType: string;
  sourceId: string;
  payload: Record<string, unknown>;
};

type VectorMatch = {
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  payload: unknown;
  score: number;
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const normalizeText = (input: string): string => input.toLowerCase().trim();

const extractRequestedLimit = (objective: string): number => {
  const text = normalizeText(objective);
  const explicit = text.match(/\b(?:top|recent|latest|last|show|list)\b(?:\s+[a-z]+){0,2}\s+(\d{1,2})\b/);
  if (explicit) {
    const parsed = Number.parseInt(explicit[1] ?? '', 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(MAX_RESULT_LIMIT, parsed);
    }
  }
  return DEFAULT_RESULT_LIMIT;
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const buildLiveSourceRefs = (
  records: LiveRecord[],
  mode: 'mcp' | 'rest',
): SourceRef[] =>
  records.map((r) => ({ source: mode, id: `${r.sourceType}:${r.sourceId}` }));

const buildVectorSourceRefs = (
  matches: Array<{ sourceType: string; sourceId: string; chunkIndex: number }>,
): SourceRef[] =>
  matches.map((m) => ({
    source: 'vector' as const,
    id: `${m.sourceType}:${m.sourceId}#${m.chunkIndex}`,
  }));

/**
 * Compact plain-text fallback when the LLM synthesis call fails.
 * Produces a readable bullet summary directly from raw records.
 */
const buildPlainTextFallback = (
  objective: string,
  liveRecords: LiveRecord[],
  vectorRecords: VectorMatch[],
): string => {
  const limit = extractRequestedLimit(objective);
  const allRecords = [
    ...liveRecords.map((r) => ({ ...r, score: 1 })),
    ...vectorRecords.map((m) => ({
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      payload: toRecord(m.payload),
      score: m.score,
    })),
  ].slice(0, limit);

  if (allRecords.length === 0) {
    return 'No grounded Zoho records found for this query.';
  }

  const readField = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = payload[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };

  const lines = allRecords.map((r, idx) => {
    const label =
      readField(r.payload, ['Deal_Name', 'Full_Name', 'Subject', 'Name', 'name']) ??
      `${r.sourceType}:${r.sourceId}`;
    return `${idx + 1}. [${r.sourceType}] ${label}`;
  });

  return `Here are the most relevant Zoho records I found:\n${lines.join('\n')}`;
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class ZohoReadAgent extends BaseAgent {
  readonly key = 'zoho-read';

  // ── Step 1: fetch live records via MCP → REST fallback ─────────────────
  private async fetchLiveRecords(input: {
    companyId: string;
    taskId: string;
  }): Promise<{ records: LiveRecord[]; sourceRefs: SourceRef[]; mode: 'mcp' | 'rest'; fallbackUsed: boolean }> {
    const provider = await resolveWithFallback({ companyId: input.companyId });

    logger.debug('zoho.agent.live_fetch.start', {
      taskId: input.taskId,
      companyId: input.companyId,
      mode: provider.providerMode,
      fallbackUsed: provider.fallbackUsed,
    });

    const page = await provider.adapter.fetchHistoricalPage({
      context: {
        companyId: input.companyId,
        environment: provider.environment,
        connectionId: provider.connectionId,
      },
      pageSize: LIVE_FETCH_PAGE_SIZE,
    });

    const records: LiveRecord[] = page.records.map((r) => ({
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      payload: r.payload,
    }));

    const mode = provider.providerMode === 'mcp' ? 'mcp' : 'rest';
    return {
      records,
      sourceRefs: buildLiveSourceRefs(records, mode),
      mode,
      fallbackUsed: provider.fallbackUsed,
    };
  }

  // ── Step 2: ask the Mastra LLM to synthesise a natural-language answer ──
  private async synthesiseWithLLM(input: {
    taskId: string;
    messageId: string;
    userId: string;
    chatId: string;
    channel: string;
    companyId: string;
    requestId?: string;
    larkTenantKey?: string;
    objective: string;
    liveRecords: LiveRecord[];
    vectorContext: VectorMatch[];
  }): Promise<string> {
    const liveSnippet =
      input.liveRecords.length > 0
        ? JSON.stringify(input.liveRecords.slice(0, 8), null, 2)
        : '(no live records available)';

    const vectorSnippet =
      input.vectorContext.length > 0
        ? JSON.stringify(
          input.vectorContext.slice(0, 5).map((m) => ({
            sourceType: m.sourceType,
            sourceId: m.sourceId,
            score: m.score,
            payload: toRecord(m.payload),
          })),
          null,
          2,
        )
        : '(no vector context available)';

    const promptText = [
      `User request: "${input.objective}"`,
      ``,
      `## Live CRM records:`,
      liveSnippet,
      ``,
      `## Supporting vector context:`,
      vectorSnippet,
    ].join('\n');

    const agent = mastra.getAgent('synthesisAgent');
    const result = await agent.generate(promptText);

    return result.text;

    return result.text;
  }

  // ── Main invoke ──────────────────────────────────────────────────────────
  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    let apiCalls = 0;

    try {
      const VECTOR_CONTEXT_ENABLED = process.env.ZOHO_VECTOR_CONTEXT_ENABLED !== 'false';
      const limit = extractRequestedLimit(input.objective);
      const retrievalLimit = Math.min(10, Math.max(DEFAULT_RESULT_LIMIT, limit + 2));

      const companyId = await companyContextResolver.resolveCompanyId({
        companyId: input.contextPacket.companyId,
        larkTenantKey: input.contextPacket.larkTenantKey,
      });
      apiCalls++;

      // ── Step 1: Live Zoho data (MCP → REST fallback) ────────────────────
      let liveRecords: LiveRecord[] = [];
      let liveSourceRefs: SourceRef[] = [];
      let liveMode: 'mcp' | 'rest' = 'rest';
      let fallbackUsed = false;

      try {
        const live = await this.fetchLiveRecords({ companyId, taskId: input.taskId });
        liveRecords = live.records;
        liveSourceRefs = live.sourceRefs;
        liveMode = live.mode;
        fallbackUsed = live.fallbackUsed;
        apiCalls += 2;

        logger.debug('zoho.agent.live_fetch.success', {
          taskId: input.taskId,
          companyId,
          mode: liveMode,
          fallbackUsed,
          recordCount: liveRecords.length,
        });
      } catch (error) {
        logger.warn('zoho.agent.live_fetch.failed', {
          taskId: input.taskId,
          companyId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }

      // ── Step 2: Vector context (augmentation only) ───────────────────────
      let vectorMatches: VectorMatch[] = [];
      let vectorSourceRefs: SourceRef[] = [];

      if (VECTOR_CONTEXT_ENABLED) {
        try {
          vectorMatches = await zohoRetrievalService.query({
            companyId,
            text: input.objective,
            limit: retrievalLimit,
          });
          vectorSourceRefs = buildVectorSourceRefs(vectorMatches);
          apiCalls++;
        } catch (vecError) {
          logger.warn('zoho.agent.vector_context.failed', {
            taskId: input.taskId,
            companyId,
            reason: vecError instanceof Error ? vecError.message : 'unknown_error',
          });
        }
      }

      // ── Early exit if nothing at all ─────────────────────────────────────
      const allSourceRefs = [...liveSourceRefs, ...vectorSourceRefs];
      if (liveRecords.length === 0 && vectorMatches.length === 0) {
        return this.success(
          input,
          'No grounded Zoho records found for this query yet.',
          {
            companyId,
            answer: 'No grounded Zoho records found for this query yet.',
            sourceRefs: [],
            sources: [],
          },
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      // ── Step 3: LLM synthesis ────────────────────────────────────────────
      let answer: string;
      try {
        answer = await this.synthesiseWithLLM({
          taskId: input.taskId,
          messageId: String(input.contextPacket.chatId ?? input.taskId),
          userId: String(input.contextPacket.chatId ?? input.taskId),
          chatId: String(input.contextPacket.chatId ?? input.taskId),
          channel: String(input.contextPacket.channel ?? 'unknown'),
          companyId,
          requestId: typeof input.contextPacket.requestId === 'string' ? input.contextPacket.requestId : undefined,
          larkTenantKey: typeof input.contextPacket.larkTenantKey === 'string' ? input.contextPacket.larkTenantKey : undefined,
          objective: input.objective,
          liveRecords,
          vectorContext: vectorMatches,
        });
        apiCalls++;
      } catch (llmError) {
        logger.warn('zoho.agent.llm_synthesis.failed', {
          taskId: input.taskId,
          companyId,
          reason: llmError instanceof Error ? llmError.message : 'unknown_error',
        });
        // Graceful fallback: plain-text summary from raw records
        answer = buildPlainTextFallback(input.objective, liveRecords, vectorMatches);
      }

      const summarySources = allSourceRefs.slice(0, 4).map((ref) => ref.id);

      return this.success(
        input,
        answer,
        {
          companyId,
          answer,
          sources: summarySources,
          sourceRefs: allSourceRefs,
          liveProviderMode: liveMode,
          fallbackUsed,
          liveRecordCount: liveRecords.length,
          vectorRecordCount: vectorMatches.length,
        },
        { latencyMs: Date.now() - startedAt, apiCalls },
      );
    } catch (error) {
      if (error instanceof CompanyContextResolutionError) {
        return this.failure(
          input,
          error.message,
          error.code,
          error.message,
          false,
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      if (error instanceof ZohoIntegrationError) {
        return this.failure(
          input,
          'Zoho provider retrieval failed',
          error.code,
          error.message,
          error.retriable,
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      return this.failure(
        input,
        'Zoho retrieval failed',
        'embedding_unavailable',
        error instanceof Error ? error.message : 'unknown_error',
        true,
        { latencyMs: Date.now() - startedAt, apiCalls },
      );
    }
  }
}
