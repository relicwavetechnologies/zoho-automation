import { generateText, type LanguageModel } from 'ai';
import type { Logger } from '../../../shared/logger';
import type { CachePort } from '../../../shared/cache';
import type { ConversationRepoPort } from '../../../infrastructure/persistence/conversation.repository';
import type { ConversationSummary } from '../../../domain/conversation/conversation-summary';
import { HISTORY_POLICY } from '../../../domain/conversation/history-policy';

const LOCK_TTL_SECONDS = 60;
const lockKey = (chatId: string) => `convsummary:lock:${chatId}`;

const SUMMARIZE_SYSTEM = `Extract durable facts from older conversation turns between a user and Divo (an AI operations assistant).
The goal is to compress older history into structured memory so the conversation can continue with full context but fewer tokens.

Preservation priority (highest first):
1. User corrections and preferences (these MUST survive)
2. Confirmed facts: names, amounts, dates, IDs (invoice numbers, task names, email addresses)
3. Decisions made and their rationale
4. Active/in-progress work
5. Which tools were used (just family names, not call details)

Discard:
- Greetings, acknowledgements, filler
- Raw tool call parameters and verbose tool outputs
- Superseded progress (only keep the latest state)
- The assistant's reasoning process

If a prior summary already contains a fact, update it if changed or keep it as-is. Do not duplicate.
Cap each array at the specified max. Prefer recent items when trimming.

Respond with valid JSON only. Schema:
{
  "facts": ["string — confirmed facts, max 30 items, max 200 chars each"],
  "decisions": ["string — decisions made, max 15 items"],
  "entities": ["string — people, companies, projects, IDs mentioned, max 20 items"],
  "activeWork": ["string — tasks/actions still in progress, max 10 items"],
  "toolsUsed": ["string — tool family names used (zohoBooks, larkMessaging, etc.), max 15 items"]
}`;

export interface ConversationSummarizerDeps {
  conversationRepo: ConversationRepoPort;
  model: LanguageModel;
  cache: CachePort;
  logger: Logger;
}

export class ConversationSummarizer {
  constructor(private readonly deps: ConversationSummarizerDeps) {}

  async maybeSummarize(chatId: string): Promise<void> {
    const lockResult = await this.deps.cache.setNx(lockKey(chatId), 1, LOCK_TTL_SECONDS);
    if (!lockResult.ok || !lockResult.value) return;

    try {
      await this.checkAndSummarize(chatId);
    } finally {
      void this.deps.cache.del(lockKey(chatId));
    }
  }

  private async checkAndSummarize(chatId: string): Promise<void> {
    const metaResult = await this.deps.conversationRepo.getConversationMeta(chatId);
    if (!metaResult.ok || !metaResult.value) return;

    const meta = metaResult.value;
    const unsummarizedTurns = meta.lastMessageSequence - meta.lastSummarizedSequence;

    if (unsummarizedTurns < HISTORY_POLICY.MIN_TURNS_BEFORE_SUMMARIZATION) return;

    const histResult = await this.deps.conversationRepo.getHistoryAfterSequence(
      chatId, meta.lastSummarizedSequence, 60,
    );
    if (!histResult.ok) return;
    const turns = histResult.value;
    if (turns.length < HISTORY_POLICY.MIN_TURNS_BEFORE_SUMMARIZATION) return;

    const estimatedTokens = turns.reduce((sum, t) => sum + Math.ceil(t.content.length / 4), 0);
    if (estimatedTokens < HISTORY_POLICY.SUMMARIZATION_SOFT_THRESHOLD) return;

    this.deps.logger.info('conversation_summarizer.running', {
      chatId,
      unsummarizedTurns,
      estimatedTokens,
      lastSummarizedSequence: meta.lastSummarizedSequence,
    });

    const existingSummary = meta.summaryJson as ConversationSummary | null;

    const turnsToSummarize = turns.slice(0, -HISTORY_POLICY.TOOL_RESULT_VERBATIM_TURNS);
    if (turnsToSummarize.length === 0) return;

    const turnLines = turnsToSummarize.map(t => {
      const content = t.content.length > 1000 ? t.content.slice(0, 1000) + '...' : t.content;
      return `[${t.role}] (${t.timestamp}): ${content}`;
    }).join('\n\n');

    try {
      const { text } = await generateText({
        model: this.deps.model,
        system: SUMMARIZE_SYSTEM,
        prompt: JSON.stringify({
          priorSummary: existingSummary,
          olderTurns: turnLines,
        }),
        temperature: 0,
        maxOutputTokens: 4096,
        abortSignal: AbortSignal.timeout(20_000),
      });

      const parsed = parseSummaryJson(text);
      const merged = mergeSummary(existingSummary, parsed, turnsToSummarize.length);

      await this.deps.conversationRepo.updateSummary(meta.id, {
        summaryJson: merged,
        summaryUpdatedAt: new Date(),
        lastSummarizedSequence: meta.lastMessageSequence - HISTORY_POLICY.TOOL_RESULT_VERBATIM_TURNS,
      });

      this.deps.logger.info('conversation_summarizer.complete', {
        chatId,
        summarizedTurns: turnsToSummarize.length,
        facts: merged.facts.length,
        decisions: merged.decisions.length,
        entities: merged.entities.length,
      });
    } catch (e) {
      this.deps.logger.warn('conversation_summarizer.llm_failed', {
        chatId,
        error: String(e),
      });
    }
  }
}

function parseSummaryJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  return JSON.parse(candidate) as Record<string, unknown>;
}

function readStringArray(
  raw: unknown,
  fallback: readonly string[],
  max: number,
): string[] {
  if (!Array.isArray(raw)) return [...fallback].slice(-max);
  const strings = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return strings.slice(-max);
}

function mergeSummary(
  existing: ConversationSummary | null,
  parsed: Record<string, unknown>,
  newTurnCount: number,
): ConversationSummary {
  const existingFacts = existing?.facts ?? [];
  const existingDecisions = existing?.decisions ?? [];
  const existingEntities = existing?.entities ?? [];
  const existingActiveWork = existing?.activeWork ?? [];
  const existingToolsUsed = existing?.toolsUsed ?? [];

  const facts = dedupeStrings([
    ...existingFacts,
    ...readStringArray(parsed.facts, [], 30),
  ], 30);

  const decisions = dedupeStrings([
    ...existingDecisions,
    ...readStringArray(parsed.decisions, [], 15),
  ], 15);

  const entities = dedupeStrings([
    ...existingEntities,
    ...readStringArray(parsed.entities, [], 20),
  ], 20);

  const activeWork = readStringArray(parsed.activeWork, existingActiveWork, 10);

  const toolsUsed = dedupeStrings([
    ...existingToolsUsed,
    ...readStringArray(parsed.toolsUsed, [], 15),
  ], 15);

  return {
    facts,
    decisions,
    entities,
    activeWork,
    toolsUsed,
    summarizedTurnCount: (existing?.summarizedTurnCount ?? 0) + newTurnCount,
    lastSummarizedSequence: 0, // caller sets the real value
    updatedAt: new Date().toISOString(),
  };
}

function dedupeStrings(items: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result.slice(-max);
}

export function formatConversationSummary(summary: ConversationSummary): string {
  const sections: string[] = [];

  if (summary.facts.length > 0) {
    sections.push(`Facts: ${summary.facts.join('; ')}`);
  }
  if (summary.decisions.length > 0) {
    sections.push(`Decisions: ${summary.decisions.join('; ')}`);
  }
  if (summary.entities.length > 0) {
    sections.push(`Entities: ${summary.entities.join(', ')}`);
  }
  if (summary.activeWork.length > 0) {
    sections.push(`Active work: ${summary.activeWork.join('; ')}`);
  }
  if (summary.toolsUsed.length > 0) {
    sections.push(`Tools used: ${summary.toolsUsed.join(', ')}`);
  }

  return sections.join('\n');
}
