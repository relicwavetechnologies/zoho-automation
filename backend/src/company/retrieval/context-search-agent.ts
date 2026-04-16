/**
 * Context Search Agent
 *
 * A tiered reasoning agent that sits on top of contextSearchBrokerService.
 * Replaces the bare broker call in legacy-tools.ts as the primary entry point
 * for all contextSearch tool invocations.
 *
 * Architecture:
 *   [1] Tier Classifier      — pure logic, no LLM
 *   [2] Intent Classifier    — reuses existing Groq llama (cached)
 *   [3] Scope Reasoner       — 1 LLM call (nano/mini based on tier)
 *   [4] Filename Fast Path   — trigram fuzzy match on FileAsset + workspace
 *   [5] Parallel Search      — Promise.allSettled within scope, optional timeout
 *   [6] Quality Gate         — expand scope once if top score < threshold
 *   [7] Rerank Decision      — Groq listwise or score sort based on tier
 *   [8] Token Budget         — trim output to per-tier limit
 *
 * Emits structured ExecutionEvents for full observability in admin dashboard.
 * Filter by actorKey=context_search to see the full lifecycle.
 */

import OpenAI from 'openai';
import { promises as fs } from 'fs';
import path from 'path';

import config from '../../config';
import { logger } from '../../utils/logger';
import { prisma } from '../../utils/prisma';
import { redDebug } from '../../utils/red-debug';
import { getCachedSearchIntent } from '../orchestration/search-intent-classifier';
import {
  contextSearchBrokerService,
  type ContextSearchBrokerSearchInput,
  type ContextSearchBrokerSearchOutput,
  type ContextSearchBrokerResult,
  type ContextSearchBrokerSourceKey,
} from './context-search-broker.service';
import { llmRerankerService, type RerankCandidate } from './llm-reranker.service';
import {
  isFilenameQuery,
  trigramSimilarity,
  scoreFilenameMatches,
  TRIGRAM_STRONG_MATCH_THRESHOLD,
} from '../../utils/trigram';
import { stepResultRepository } from '../observability/executions/step-result.repository';
import { executionRepository } from '../observability/executions/repository';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SearchTier = 'simple' | 'standard' | 'complex';

export type ContextSearchAgentInput = ContextSearchBrokerSearchInput & {
  executionId?: string;
  executionSequenceBase?: number;
};

export type ContextSearchAgentOutput = ContextSearchBrokerSearchOutput & {
  tier: SearchTier;
  totalRounds: number;
  rerankMethod: string;
  fastPathUsed: boolean;
  durationMs: number;
  sourcesSearched: string[];
};

// ─── Constants ───────────────────────────────────────────────────────────────

const QUALITY_THRESHOLD = 0.55;

const MAX_SEARCH_ROUNDS: Record<SearchTier, number> = {
  simple: 1,
  standard: 2,
  complex: 3,
};

const MAX_RESULTS_PER_TIER: Record<SearchTier, number> = {
  simple: 3,
  standard: 7,
  complex: 10,
};

const EXCERPT_MAX_CHARS = 200;

const OUTPUT_TOKEN_BUDGET: Record<SearchTier, number> = {
  simple: 500,
  standard: 1_000,
  complex: 2_000,
};

// Rough chars-per-token estimate for budget enforcement
const CHARS_PER_TOKEN = 4;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const withOptionalTimeout = <T>(
  p: Promise<T>,
  label: string,
): Promise<T | null> => {
  if (!config.CONTEXT_SEARCH_TIMEOUT_ENABLED) return p;
  return Promise.race([
    p,
    sleep(config.CONTEXT_SEARCH_TIMEOUT_MS).then(() => {
      logger.warn('context_search_agent.source_timeout', { label });
      return null;
    }),
  ]);
};

const trimExcerpt = (text: string): string => {
  if (text.length <= EXCERPT_MAX_CHARS) return text;
  const cut = text.slice(0, EXCERPT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > EXCERPT_MAX_CHARS * 0.7 ? cut.slice(0, lastSpace) : cut) + '…';
};

const estimateTokens = (results: ContextSearchBrokerResult[]): number =>
  results.reduce((acc, r) => acc + Math.ceil((r.excerpt?.length ?? 0) / CHARS_PER_TOKEN), 0);

const enforceTokenBudget = (
  results: ContextSearchBrokerResult[],
  tier: SearchTier,
): ContextSearchBrokerResult[] => {
  const budget = OUTPUT_TOKEN_BUDGET[tier];
  const trimmed = results.map((r) => ({
    ...r,
    excerpt: trimExcerpt(r.excerpt ?? ''),
  }));

  let total = 0;
  const output: ContextSearchBrokerResult[] = [];
  for (const r of trimmed) {
    const tokens = Math.ceil((r.excerpt?.length ?? 0) / CHARS_PER_TOKEN);
    if (total + tokens > budget && output.length >= 1) break;
    output.push(r);
    total += tokens;
  }
  return output;
};

// ─── Observability ───────────────────────────────────────────────────────────

type EventEmitter = {
  executionId: string;
  sequenceOffset: number;
  counter: number;
};

const makeEmitter = (executionId: string, base: number): EventEmitter => ({
  executionId,
  sequenceOffset: base,
  counter: 0,
});

const emitEvent = async (
  emitter: EventEmitter | null,
  event: {
    eventType: string;
    title: string;
    status?: string;
    summary?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> => {
  if (!emitter) return;
  try {
    emitter.counter += 1;
    await executionRepository.appendEvent({
      executionId: emitter.executionId,
      phase: 'tool',
      eventType: event.eventType,
      actorType: 'tool',
      actorKey: 'context_search',
      title: event.title,
      status: event.status ?? null,
      summary: event.summary ?? null,
      payload: event.payload,
    });
  } catch (error) {
    logger.warn('context_search_agent.emit_event_failed', {
      eventType: event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ─── Tier Classifier ─────────────────────────────────────────────────────────

const classifyTier = (input: {
  query: string;
  sources?: ContextSearchBrokerSearchInput['sources'];
}): SearchTier => {
  const query = input.query.trim();
  const wordCount = query.split(/\s+/).length;
  const sources = input.sources ?? {};
  const enabledSources = Object.entries(sources)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  const enabledCount = enabledSources.length;

  // Single source explicitly set -> always simple regardless of query length
  // The caller already decided the scope, no reasoning needed
  if (enabledCount === 1) return 'simple';

  // Filename queries with no multi-source -> simple
  if (isFilenameQuery(query) && enabledCount <= 1) return 'simple';

  // Short single-intent queries with no multi-source -> simple
  if (wordCount <= 5 && enabledCount <= 1) return 'simple';

  // Contact/person lookup signals with larkContacts only -> simple
  if (
    enabledSources.length <= 2 &&
    enabledSources.includes('larkContacts') &&
    /\b(email|contact|phone|lark|id|number|address)\b/i.test(query)
  ) return 'simple';

  // Multiple sources explicitly requested -> complex
  if (enabledCount >= 3) return 'complex';

  // Cross-source keywords -> complex
  if (/\b(everything|all|across|summary|compare|overview|history|timeline)\b/i.test(query)) {
    return 'complex';
  }

  // Date range queries -> complex
  if (/\b(last\s+\w+|past\s+\w+|this\s+(week|month|quarter|year)|yesterday|since|between|from.*to)\b/i.test(query)) {
    return 'complex';
  }

  // Mixed language complex patterns
  if (/[\u0900-\u097f]/.test(query) && wordCount > 5) return 'complex';

  return 'standard';
};

// ─── Scope Reasoner ──────────────────────────────────────────────────────────

const SCOPE_REASONER_SYSTEM = `You are a search scope classifier. Given a user query, decide which data sources to search.

Available sources:
- personalHistory: past conversations, decisions, drafts, discussion history
- files: uploaded PDFs, spreadsheets, contracts, reports, images
- workspace: local filesystem files (code, configs) — only if workspace is active
- larkContacts: people lookup — names, emails, Lark IDs
- zohoCrmContext: CRM records — contacts, leads, accounts, deals
- zohoBooksLive: financial records — invoices, bills, payments, balances
- web: live internet search

Rules:
- filename query (has extension or file keywords) → files only, maybe workspace
- contact/person lookup → larkContacts first, maybe zohoCrmContext
- financial/invoice → zohoBooksLive
- conversation recall / "what did we discuss" → personalHistory
- web/current info → web only
- ambiguous cross-source → multiple sources
- Hindi/mixed language: treat same as English for source selection

Return ONLY valid JSON: {"sources": ["source1", "source2"], "reasoning": "one line"}`;

const runScopeReasoner = async (input: {
  query: string;
  tier: SearchTier;
  workspaceAvailable: boolean;
}): Promise<{
  sources: ContextSearchBrokerSourceKey[];
  reasoning: string;
  model: string;
}> => {
  const model = input.tier === 'simple' ? 'gpt-4.1-nano' : 'gpt-4.1-mini';

  try {
    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY ?? '' });
    const res = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: SCOPE_REASONER_SYSTEM },
        {
          role: 'user',
          content: `Query: "${input.query}"\nWorkspace available: ${input.workspaceAvailable}`,
        },
      ],
    });

    const content = res.choices[0]?.message?.content?.trim() ?? '';
    const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as { sources?: unknown; reasoning?: unknown };

    const validKeys = new Set<ContextSearchBrokerSourceKey>([
      'personalHistory', 'files', 'larkContacts', 'zohoCrmContext',
      'zohoBooksLive', 'workspace', 'web', 'skills',
    ]);

    const sources = (Array.isArray(parsed.sources) ? parsed.sources : [])
      .filter((s): s is ContextSearchBrokerSourceKey => validKeys.has(s as ContextSearchBrokerSourceKey))
      .filter((s) => s !== 'workspace' || input.workspaceAvailable);

    return {
      sources: sources.length > 0 ? sources : ['personalHistory', 'files'],
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      model,
    };
  } catch (error) {
    logger.warn('context_search_agent.scope_reasoner_failed', {
      query: input.query.slice(0, 80),
      error: error instanceof Error ? error.message : String(error),
    });
    // Safe fallback based on simple heuristics
    if (isFilenameQuery(input.query)) return { sources: ['files'], reasoning: 'fallback:filename', model };
    if (/\b(invoice|bill|payment|overdue|balance)\b/i.test(input.query)) return { sources: ['zohoBooksLive'], reasoning: 'fallback:financial', model };
    if (/\b(contact|email|phone|lark id)\b/i.test(input.query)) return { sources: ['larkContacts'], reasoning: 'fallback:contact', model };
    if (/\b(discuss|discuss|decision|draft|last\s+(week|time))\b/i.test(input.query)) return { sources: ['personalHistory'], reasoning: 'fallback:history', model };
    return { sources: ['personalHistory', 'files', 'zohoCrmContext'], reasoning: 'fallback:general', model };
  }
};

// ─── Filename Fast Path ───────────────────────────────────────────────────────

const GROQ_FILENAME_SYSTEM = `You are a filename matcher. Given a user query and a list of filenames, identify which filename the user is most likely referring to.

Rules:
- Match on meaning, not just exact words. "mr market" matches "Mr. Market Functional Doc.pdf"
- Abbreviations, partial names, and informal references should resolve to the best match
- If no filename is a reasonable match, say so

Return ONLY valid JSON: {"match": "exact filename here or null", "confidence": 0.0-1.0, "reason": "one line"}`;

const resolveFilenameWithGroq = async (
  query: string,
  candidates: string[],
  timeoutMs?: number,
): Promise<{ match: string | null; confidence: number } | null> => {
  if (!config.GROQ_API_KEY?.trim() || candidates.length === 0) return null;

  const candidateList = candidates.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const userMessage = `Query: "${query}"\n\nFilenames:\n${candidateList}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GROQ_FILENAME_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs ?? 4_000),
    });

    if (!res.ok) return null;

    const payload = await res.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const parsed = JSON.parse(content.slice(start, end + 1)) as {
      match?: unknown;
      confidence?: unknown;
    };

    return {
      match: typeof parsed.match === 'string' && parsed.match !== 'null' ? parsed.match : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
  } catch {
    return null;
  }
};

const runFilenameFastPath = async (input: {
  companyId: string;
  query: string;
  workspaceAvailable: boolean;
  workspacePath?: string;
}): Promise<{
  hit: boolean;
  strongMatch: boolean;
  results: ContextSearchBrokerResult[];
  durationMs: number;
  stage: 'trigram' | 'groq' | 'none';
}> => {
  const startMs = Date.now();

  let fileAssets: Array<{
    id: string;
    fileName: string;
    cloudinaryUrl: string;
    mimeType: string;
  }> = [];
  try {
    fileAssets = await prisma.fileAsset.findMany({
      where: { companyId: input.companyId, ingestionStatus: 'done' },
      select: { id: true, fileName: true, cloudinaryUrl: true, mimeType: true },
      take: 500,
    });
  } catch (error) {
    logger.warn('context_search_agent.filename_fast_path.db_error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let workspaceFilenames: string[] = [];
  if (input.workspaceAvailable && input.workspacePath) {
    try {
      const entries = await fs.readdir(input.workspacePath, { withFileTypes: true });
      workspaceFilenames = entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      // non-fatal
    }
  }

  const allFilenames = fileAssets.map((f) => f.fileName);

  const trigramMatches = scoreFilenameMatches(input.query, allFilenames);
  const wsTrigramMatches = scoreFilenameMatches(input.query, workspaceFilenames);

  console.log('[CSA_TRIGRAM_V2]', JSON.stringify({
    query: input.query,
    fileCount: allFilenames.length,
    topMatches: trigramMatches.slice(0, 5).map((m) => ({ filename: m.filename, score: m.score })),
    wsMatches: wsTrigramMatches.slice(0, 3).map((m) => ({ filename: m.filename, score: m.score })),
  }));

  const strongTrigramMatch = trigramMatches[0]?.score >= TRIGRAM_STRONG_MATCH_THRESHOLD
    ? trigramMatches[0]
    : null;

  if (strongTrigramMatch) {
    const asset = fileAssets.find((f) => f.fileName === strongTrigramMatch.filename);
    if (asset) {
      return {
        hit: true,
        strongMatch: true,
        stage: 'trigram',
        durationMs: Date.now() - startMs,
        results: [{
          scope: 'files',
          sourceType: 'file_document',
          sourceId: asset.id,
          chunkIndex: 0,
          score: strongTrigramMatch.score,
          excerpt: `File: ${asset.fileName}`,
          chunkRef: `files:file_document:${asset.id}:0`,
          sourceLabel: `Company file · ${asset.fileName}`,
          fileName: asset.fileName,
          title: asset.fileName,
          url: asset.cloudinaryUrl,
          authorityLevel: 'documentary' as const,
        }],
      };
    }
  }

  const candidateFilenames = trigramMatches.slice(0, 10).map((m) => m.filename);

  if (candidateFilenames.length === 0) {
    const broadCandidates = allFilenames
      .map((f) => ({ filename: f, score: trigramSimilarity(input.query, f) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((m) => m.filename);
    candidateFilenames.push(...broadCandidates);
  }

  if (candidateFilenames.length > 0) {
    const groqResult = await resolveFilenameWithGroq(
      input.query,
      candidateFilenames,
      config.CONTEXT_SEARCH_TIMEOUT_ENABLED ? 4_000 : undefined,
    );

    console.log('[CSA_GROQ_FILENAME]', JSON.stringify({
      query: input.query,
      candidates: candidateFilenames,
      groqResult,
    }));

    if (groqResult?.match && groqResult.confidence >= 0.7) {
      const asset = fileAssets.find((f) => f.fileName === groqResult.match);
      if (asset) {
        return {
          hit: true,
          strongMatch: true,
          stage: 'groq',
          durationMs: Date.now() - startMs,
          results: [{
            scope: 'files',
            sourceType: 'file_document',
            sourceId: asset.id,
            chunkIndex: 0,
            score: groqResult.confidence,
            excerpt: `File: ${asset.fileName}`,
            chunkRef: `files:file_document:${asset.id}:0`,
            sourceLabel: `Company file · ${asset.fileName}`,
            fileName: asset.fileName,
            title: asset.fileName,
            url: asset.cloudinaryUrl,
            authorityLevel: 'documentary' as const,
          }],
        };
      }
    }

    if (trigramMatches.length > 0) {
      const candidateResults: ContextSearchBrokerResult[] = trigramMatches
        .slice(0, 5)
        .map((match) => {
          const asset = fileAssets.find((f) => f.fileName === match.filename)!;
          return {
            scope: 'files' as const,
            sourceType: 'file_document',
            sourceId: asset.id,
            chunkIndex: 0,
            score: match.score,
            excerpt: `File: ${asset.fileName}`,
            chunkRef: `files:file_document:${asset.id}:0`,
            sourceLabel: `Company file · ${asset.fileName}`,
            fileName: asset.fileName,
            title: asset.fileName,
            url: asset.cloudinaryUrl,
            authorityLevel: 'documentary' as const,
          };
        });

      return {
        hit: true,
        strongMatch: false,
        stage: 'groq',
        durationMs: Date.now() - startMs,
        results: candidateResults,
      };
    }
  }

  const wsResults: ContextSearchBrokerResult[] = wsTrigramMatches.slice(0, 3).map((match) => ({
    scope: 'workspace' as const,
    sourceType: 'workspace_file',
    sourceId: Buffer.from(match.filename).toString('base64url'),
    chunkIndex: 0,
    score: match.score,
    excerpt: `Workspace file: ${match.filename}`,
    chunkRef: `workspace:workspace_file:${Buffer.from(match.filename).toString('base64url')}:0`,
    sourceLabel: `Workspace · ${match.filename}`,
    fileName: match.filename,
    title: match.filename,
    authorityLevel: 'documentary' as const,
  }));

  return {
    hit: wsResults.length > 0,
    strongMatch: false,
    stage: 'none',
    durationMs: Date.now() - startMs,
    results: wsResults,
  };
};

// ─── Parallel Source Search ───────────────────────────────────────────────────

const runParallelSearch = async (input: {
  brokerInput: ContextSearchBrokerSearchInput;
  sources: ContextSearchBrokerSourceKey[];
  tier: SearchTier;
}): Promise<{
  output: ContextSearchBrokerSearchOutput;
  sourceDurations: Record<string, number>;
  timedOutSources: string[];
}> => {
  const sourcesObject: Record<ContextSearchBrokerSourceKey, boolean> = {
    personalHistory: false,
    files: false,
    larkContacts: false,
    zohoCrmContext: false,
    zohoBooksLive: false,
    workspace: false,
    web: false,
    skills: false,
  };
  for (const s of input.sources) sourcesObject[s] = true;

  const startMs = Date.now();
  const timedOutSources: string[] = [];

  // Run broker with selected sources — broker handles parallel fan-out internally
  const searchPromise = contextSearchBrokerService.search({
    ...input.brokerInput,
    sources: sourcesObject,
    limit: MAX_RESULTS_PER_TIER[input.tier] * 2, // over-fetch for reranking
  });

  const result = await withOptionalTimeout(searchPromise, `parallel_search_${input.tier}`);

  if (!result) {
    timedOutSources.push('all');
    return {
      output: {
        results: [],
        matches: [],
        resolvedEntities: {},
        sourceCoverage: {} as any,
        citations: [],
        nextFetchRefs: [],
        searchSummary: 'Search timed out.',
      },
      sourceDurations: { all: Date.now() - startMs },
      timedOutSources,
    };
  }

  return {
    output: result,
    sourceDurations: { total: Date.now() - startMs },
    timedOutSources,
  };
};

// ─── Quality Gate ─────────────────────────────────────────────────────────────

const checkQualityGate = (results: ContextSearchBrokerResult[]): {
  passed: boolean;
  topScore: number;
} => {
  if (results.length === 0) return { passed: false, topScore: 0 };
  const topScore = Math.max(...results.map((r) => r.score));
  return { passed: topScore >= QUALITY_THRESHOLD, topScore };
};

const getExpansionSources = (
  alreadySearched: ContextSearchBrokerSourceKey[],
  tier: SearchTier,
): ContextSearchBrokerSourceKey[] => {
  const searched = new Set(alreadySearched);
  const expansionOrder: ContextSearchBrokerSourceKey[] =
    tier === 'complex'
      ? ['zohoBooksLive', 'zohoCrmContext', 'files', 'personalHistory', 'workspace', 'web']
      : ['files', 'personalHistory', 'zohoCrmContext', 'zohoBooksLive'];

  return expansionOrder.filter((s) => !searched.has(s)).slice(0, tier === 'complex' ? 3 : 1);
};

// ─── Main Agent ───────────────────────────────────────────────────────────────

class ContextSearchAgent {
  async search(input: ContextSearchAgentInput): Promise<ContextSearchAgentOutput> {
    const startMs = Date.now();
    const query = input.query.trim();
    const workspaceAvailable = !!input.runtime.workspace?.path;
    const emitter = input.executionId
      ? makeEmitter(input.executionId, input.executionSequenceBase ?? 0)
      : null;

    // [1] Tier Classification
    const tier = classifyTier({ query, sources: input.sources });
    console.log(
      '[CSA_DEBUG]',
      JSON.stringify({
        query,
        tier,
        isFilenameQuery: isFilenameQuery(query),
      }),
    );

    // [2] Intent Classifier (cached, reuse existing)
    const intent = await getCachedSearchIntent({
      runtime: input.runtime,
      message: query,
    });

    // [3] Scope Reasoner
    const scopeDecision = await runScopeReasoner({
      query,
      tier,
      workspaceAvailable,
    });

    // Emit start event
    await emitEvent(emitter, {
      eventType: 'context_search.start',
      title: 'Context Search Started',
      payload: {
        query,
        tier,
        intentClassification: {
          queryType: intent.queryType,
          extractedEntity: intent.extractedEntity,
          sourceHint: intent.sourceHint,
          confidence: intent.confidence,
        },
        scopeDecision: {
          model: scopeDecision.model,
          sourcesSelected: scopeDecision.sources,
          reasoning: scopeDecision.reasoning,
        },
        filenameFastPathTriggered: isFilenameQuery(query),
        workspaceAvailable,
        timeoutEnabled: config.CONTEXT_SEARCH_TIMEOUT_ENABLED,
      },
    });

    let allResults: ContextSearchBrokerResult[] = [];
    let lastOutput: ContextSearchBrokerSearchOutput | null = null;
    let fastPathUsed = false;
    let rerankMethod = 'score_sort';
    let round = 0;
    let searchedSources = new Set<ContextSearchBrokerSourceKey>(scopeDecision.sources);

    // [4] Filename Fast Path
    if (isFilenameQuery(query)) {
      const fastPath = await runFilenameFastPath({
        companyId: input.runtime.companyId,
        query,
        workspaceAvailable,
        workspacePath: input.runtime.workspace?.path,
      });
      console.log('[CSA_FAST_PATH]', JSON.stringify({
        hit: fastPath.hit,
        strongMatch: fastPath.strongMatch,
        resultCount: fastPath.results.length,
        topScore: fastPath.results[0]?.score ?? null,
        topFileName: fastPath.results[0]?.fileName ?? null,
        allResults: fastPath.results.map((r) => ({ fileName: r.fileName, score: r.score })),
      }));

      await emitEvent(emitter, {
        eventType: 'context_search.source_result',
        title: 'Source: filename_fast_path',
        status: fastPath.hit ? 'hit' : 'miss',
        payload: {
          source: 'filename_fast_path',
          query,
          resultCount: fastPath.results.length,
          topScore: fastPath.results[0]?.score ?? null,
          durationMs: fastPath.durationMs,
          fastPathUsed: true,
          strongMatch: fastPath.strongMatch,
        },
      });

      if (fastPath.strongMatch) {
        fastPathUsed = true;
        allResults = fastPath.results;

        // Still do semantic search for content but merge filename hits at top
        const semanticOut = await runParallelSearch({
          brokerInput: { ...input, query },
          sources: ['files'],
          tier,
        });
        if (semanticOut.output.results.length > 0) {
          // Merge: fast path results first (they have correct file), then semantic content chunks
          const seenIds = new Set(allResults.map((r) => r.sourceId));
          for (const r of semanticOut.output.results) {
            if (!seenIds.has(r.sourceId)) {
              allResults.push(r);
              seenIds.add(r.sourceId);
            }
          }
          lastOutput = semanticOut.output;
        }
      } else if (fastPath.hit) {
        // Weak matches — include as candidates, still run semantic
        allResults.push(...fastPath.results);
      }
    }

    // [5] Parallel Search (if not fast-path short-circuit)
    if (!fastPathUsed || allResults.length < 2) {
      const maxRounds = MAX_SEARCH_ROUNDS[tier];

      while (round < maxRounds) {
        round++;

        const sourcesToSearch = round === 1
          ? scopeDecision.sources
          : getExpansionSources(Array.from(searchedSources), tier);

        if (sourcesToSearch.length === 0) break;
        for (const s of sourcesToSearch) searchedSources.add(s);

        const searchResult = await runParallelSearch({
          brokerInput: { ...input, query },
          sources: sourcesToSearch,
          tier,
        });
        console.log('[CSA_SEARCH_ROUND]', JSON.stringify({
          round,
          sources: sourcesToSearch,
          resultCount: searchResult.output.results.length,
          topResults: searchResult.output.results.slice(0, 3).map((r) => ({
            scope: r.scope,
            fileName: r.fileName,
            title: r.title,
            score: r.score,
          })),
        }));

        lastOutput = searchResult.output;

        // Merge results (dedupe by sourceId+chunkIndex)
        const seen = new Set(allResults.map((r) => `${r.sourceId}:${r.chunkIndex}`));
        for (const r of searchResult.output.results) {
          const key = `${r.sourceId}:${r.chunkIndex}`;
          if (!seen.has(key)) {
            allResults.push(r);
            seen.add(key);
          }
        }

        // Emit per-source result event
        for (const [source, coverage] of Object.entries(searchResult.output.sourceCoverage)) {
          if (!coverage.enabled) continue;
          await emitEvent(emitter, {
            eventType: 'context_search.source_result',
            title: `Source: ${source}`,
            status: coverage.resultCount > 0 ? 'hit' : 'miss',
            payload: {
              source,
              query,
              resultCount: coverage.resultCount,
              topScore: allResults.filter((r) => {
                const scopeMap: Record<string, string> = {
                  personalHistory: 'personal_history',
                  files: 'files',
                  larkContacts: 'lark_contacts',
                  zohoCrmContext: 'zoho_crm',
                  zohoBooksLive: 'zoho_books',
                  workspace: 'workspace',
                  web: 'web',
                  skills: 'skills',
                };
                return r.scope === (scopeMap[source] ?? source);
              }).reduce((max, r) => Math.max(max, r.score), 0) || null,
              durationMs: searchResult.sourceDurations.total ?? 0,
              fastPathUsed: false,
              correctiveRetryUsed: false,
            },
          });
        }

        // [6] Quality Gate
        const gate = checkQualityGate(allResults);

        await emitEvent(emitter, {
          eventType: 'context_search.quality_gate',
          title: `Quality Gate — Round ${round}`,
          status: gate.passed ? 'passed' : round < maxRounds ? 'expanding' : 'low_confidence',
          payload: {
            round,
            topScore: gate.topScore,
            threshold: QUALITY_THRESHOLD,
            totalCandidates: allResults.length,
            decision: gate.passed ? 'accept' : round < maxRounds ? 'expand_scope' : 'return_low_confidence',
            expandedTo: !gate.passed && round < maxRounds
              ? getExpansionSources(Array.from(searchedSources), tier)
              : null,
          },
        });

        if (gate.passed) break;

        if (round >= maxRounds) {
          logger.info('context_search_agent.max_rounds_reached', {
            companyId: input.runtime.companyId,
            query: query.slice(0, 80),
            tier,
            rounds: round,
            topScore: gate.topScore,
          });
          break;
        }
      }
    }

    // Sort by score before reranking
    allResults.sort((a, b) => b.score - a.score);

    // [7] Rerank Decision
    const rerankDecision = llmRerankerService.shouldRerank({
      tier,
      resultCount: allResults.length,
      fastPathUsed,
    });

    const rerankStartMs = Date.now();
    const topScoreBefore = allResults[0]?.score ?? 0;

    if (rerankDecision.rerank && allResults.length > 0) {
      const candidates: RerankCandidate[] = allResults.map((r) => ({
        id: `${r.sourceId}:${r.chunkIndex}`,
        content: `[${r.scope}] ${r.title ?? r.fileName ?? ''}\n${r.excerpt ?? ''}`,
        score: r.score,
      }));

      const rerankOut = await llmRerankerService.rerank(query, candidates, {
        timeoutMs: config.CONTEXT_SEARCH_TIMEOUT_ENABLED
          ? config.CONTEXT_SEARCH_TIMEOUT_MS
          : undefined,
      });

      rerankMethod = rerankOut.method;

      if (rerankOut.method === 'groq_listwise') {
        const scoreMap = new Map(rerankOut.ranked.map((r) => [r.id, r.score]));
        allResults = allResults
          .map((r) => ({
            ...r,
            score: scoreMap.get(`${r.sourceId}:${r.chunkIndex}`) ?? r.score,
          }))
          .sort((a, b) => b.score - a.score);
      }

      await emitEvent(emitter, {
        eventType: 'context_search.rerank',
        title: `Reranking ${candidates.length} candidates`,
        status: rerankOut.skipped ? 'skipped' : rerankOut.method === 'score_sort' ? 'fallback_score_sort' : 'completed',
        payload: {
          method: rerankOut.method,
          candidateCount: candidates.length,
          model: rerankOut.method === 'groq_listwise' ? RERANKER_MODEL_LABEL : null,
          durationMs: rerankOut.durationMs,
          topScoreBefore,
          topScoreAfter: allResults[0]?.score ?? 0,
          reason: rerankOut.skipReason ?? null,
        },
      });
    } else {
      await emitEvent(emitter, {
        eventType: 'context_search.rerank',
        title: 'Reranking skipped',
        status: 'skipped',
        payload: {
          method: 'score_sort',
          candidateCount: allResults.length,
          model: null,
          durationMs: Date.now() - rerankStartMs,
          topScoreBefore,
          topScoreAfter: topScoreBefore,
          reason: rerankDecision.reason,
        },
      });
    }

    // [8] Token Budget
    const maxResults = MAX_RESULTS_PER_TIER[tier];
    const sliced = allResults.slice(0, maxResults);
    const budgeted = enforceTokenBudget(sliced, tier);
    const tokensTrimmed = budgeted.length < sliced.length;

    const durationMs = Date.now() - startMs;
    const sourcesSearched = Array.from(searchedSources);
    const gate = checkQualityGate(budgeted);
    const completionStatus = budgeted.length === 0 ? 'empty' : gate.passed ? 'success' : 'low_confidence';

    const summary = budgeted.length > 0
      ? `Found ${budgeted.length} result(s) across ${sourcesSearched.join(', ')}.`
      : `No results found. Searched: ${sourcesSearched.join(', ')}.`;

    // Emit complete event
    await emitEvent(emitter, {
      eventType: 'context_search.complete',
      title: 'Context Search Complete',
      status: completionStatus,
      summary,
      payload: {
        tier,
        totalRounds: round,
        sourcesSearched,
        totalCandidatesConsidered: allResults.length,
        resultsReturned: budgeted.length,
        topScore: budgeted[0]?.score ?? null,
        rerankMethod,
        fastPathUsed,
        durationMs,
        tokenBudget: {
          outputTokensEstimate: estimateTokens(budgeted),
          trimmed: tokensTrimmed,
        },
        results: budgeted.map((r) => ({
          source: r.scope,
          fileName: r.fileName ?? null,
          score: r.score,
          excerptPreview: (r.excerpt ?? '').slice(0, 80),
        })),
      },
    });

    // Write StepResult for copy/replay in admin dashboard
    if (input.executionId) {
      try {
        await stepResultRepository.writeStepResult({
          executionId: input.executionId,
          sequence: (input.executionSequenceBase ?? 0) + (emitter?.counter ?? 0) + 1,
          toolName: 'contextSearch',
          actorKey: 'context_search',
          title: `Context Search: "${query.slice(0, 60)}"`,
          success: budgeted.length > 0,
          status: tier,
          summary,
          rawOutput: {
            query,
            tier,
            sources: sourcesSearched,
            fastPathUsed,
            rerankMethod,
            durationMs,
            results: budgeted,
          },
        });
      } catch (error) {
        logger.warn('context_search_agent.step_result_write_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Build final output using lastOutput as base or construct from scratch
    const base = lastOutput ?? {
      results: budgeted,
      matches: budgeted,
      resolvedEntities: {},
      sourceCoverage: {} as any,
      citations: [],
      nextFetchRefs: budgeted.map((r) => r.chunkRef),
      searchSummary: summary,
    };
    console.log('[CSA_FINAL]', JSON.stringify({
      tier,
      fastPathUsed,
      totalResults: budgeted.length,
      results: budgeted.map((r) => ({ scope: r.scope, fileName: r.fileName, score: r.score })),
    }));

    return {
      ...base,
      results: budgeted,
      matches: budgeted,
      nextFetchRefs: budgeted.map((r) => r.chunkRef),
      searchSummary: completionStatus === 'low_confidence'
        ? `Low confidence — ${summary}`
        : summary,
      tier,
      totalRounds: round,
      rerankMethod,
      fastPathUsed,
      durationMs,
      sourcesSearched,
    };
  }

  // Pass-through fetch to broker — no changes needed
  async fetch(
    input: Parameters<typeof contextSearchBrokerService.fetch>[0],
  ): ReturnType<typeof contextSearchBrokerService.fetch> {
    return contextSearchBrokerService.fetch(input);
  }

  toVercelCitationsFromSearch(
    output: ContextSearchAgentOutput,
  ): ReturnType<typeof contextSearchBrokerService.toVercelCitationsFromSearch> {
    return contextSearchBrokerService.toVercelCitationsFromSearch(output);
  }
}

const RERANKER_MODEL_LABEL = 'llama-3.1-8b-instant (groq)';

export const contextSearchAgent = new ContextSearchAgent();
