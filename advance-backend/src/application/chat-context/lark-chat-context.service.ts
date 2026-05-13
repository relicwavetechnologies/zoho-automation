import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import type { InfraError } from '../../shared/errors';
import { InfraError as InfraErrorClass } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { LarkChatContextRepoPort } from '../../infrastructure/persistence/lark-chat-context.repository';
import type { GroupChatMessage, GroupChatSummary, GroupChatWindow } from '../../domain/conversation/group-context';
import { GROUP_CONTEXT_POLICY } from '../../domain/conversation/group-context-policy';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 24;
}

function mergeRecentItems(
  existing: readonly string[] | undefined,
  additions: readonly string[],
  limit: number,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const item of [...(existing ?? []), ...additions]) {
    const normalized = item.trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }

  return merged.slice(-limit);
}

function extractUrlsAndFiles(content: string, attachedFiles?: readonly string[]): string[] {
  const urls = content.match(/https?:\/\/\S+/gi) ?? [];
  const fileLikes = content.match(/\b[\w.-]+\.(?:pdf|docx?|xlsx?|csv|pptx?|txt|png|jpe?g)\b/gi) ?? [];
  return [...urls, ...fileLikes, ...(attachedFiles ?? [])].map(item => item.slice(0, 180));
}

function looksLikeDecision(content: string): boolean {
  return /\b(?:decided|decision|final|approved|confirmed|we will|let'?s go with|locked)\b/i.test(content);
}

function looksLikeBlocker(content: string): boolean {
  return /\b(?:blocked|blocker|risk|issue|problem|failed|cannot|can't|not working|stuck)\b/i.test(content);
}

function looksLikeDeadline(content: string): boolean {
  return /\b(?:deadline|due|by|before|today|tomorrow|eod|eow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i.test(content);
}

export function partitionRecentMessages(
  messages: GroupChatMessage[],
  tokenBudget: number,
  minMessages: number,
  maxMessages: number,
): { compactedChunk: GroupChatMessage[]; retained: GroupChatMessage[] } {
  if (messages.length <= minMessages) {
    return { compactedChunk: [], retained: messages };
  }

  const capped = messages.length > maxMessages
    ? messages.slice(messages.length - maxMessages)
    : messages;

  let tokenCount = 0;
  let retainFrom = 0;

  for (let i = capped.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(capped[i]!.content);
    if (tokenCount + msgTokens > tokenBudget && capped.length - i > minMessages) {
      retainFrom = i + 1;
      break;
    }
    tokenCount += msgTokens;
  }

  if (retainFrom <= 0) {
    return { compactedChunk: [], retained: capped };
  }

  return {
    compactedChunk: capped.slice(0, retainFrom),
    retained: capped.slice(retainFrom),
  };
}

function buildDeterministicSummary(
  messages: readonly GroupChatMessage[],
  existingSummary: GroupChatSummary | null,
): GroupChatSummary {
  const userGoals: string[] = [...(existingSummary?.userGoals ?? [])];
  const activeEntities: string[] = [...(existingSummary?.activeEntities ?? [])];
  const completedActions: string[] = [...(existingSummary?.completedActions ?? [])];
  const decisions: string[] = [...(existingSummary?.decisions ?? [])];
  const openQuestions: string[] = [...(existingSummary?.openQuestions ?? [])];
  const deadlines: string[] = [...(existingSummary?.deadlines ?? [])];
  const mentionedResources: string[] = [...(existingSummary?.mentionedResources ?? [])];
  const blockers: string[] = [...(existingSummary?.blockers ?? [])];

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content.length > 10) {
      userGoals.push(`${msg.senderName}: ${msg.content.slice(0, 200)}`);
    }
    if (msg.role === 'assistant' && msg.content.length > 10) {
      completedActions.push(`Divo: ${msg.content.slice(0, 200)}`);
    }
    if (looksLikeDecision(msg.content)) {
      decisions.push(`${msg.senderName}: ${msg.content.slice(0, 220)}`);
    }
    if (msg.content.includes('?')) {
      openQuestions.push(`${msg.senderName}: ${msg.content.slice(0, 220)}`);
    }
    if (looksLikeDeadline(msg.content)) {
      deadlines.push(`${msg.senderName}: ${msg.content.slice(0, 180)}`);
    }
    if (looksLikeBlocker(msg.content)) {
      blockers.push(`${msg.senderName}: ${msg.content.slice(0, 220)}`);
    }
    mentionedResources.push(...extractUrlsAndFiles(msg.content, msg.attachedFiles));
  }

  const result: GroupChatSummary = {
    activeEntities: activeEntities.slice(-8),
    decisions: mergeRecentItems([], decisions, 12),
    openQuestions: mergeRecentItems([], openQuestions, 12),
    deadlines: mergeRecentItems([], deadlines, 12),
    mentionedResources: mergeRecentItems([], mentionedResources, 16),
    completedActions: mergeRecentItems([], completedActions, 12),
    constraints: mergeRecentItems([], existingSummary?.constraints ?? [], 12),
    blockers: mergeRecentItems([], blockers, 12),
    userGoals: mergeRecentItems([], userGoals, 12),
    sourceMessageCount: existingSummary?.sourceMessageCount ?? 0,
    updatedAt: new Date().toISOString(),
  };
  if (existingSummary?.summary) (result as unknown as Record<string, unknown>)['summary'] = existingSummary.summary;
  if (existingSummary?.latestObjective) (result as unknown as Record<string, unknown>)['latestObjective'] = existingSummary.latestObjective;
  if (existingSummary?.latestDirection) (result as unknown as Record<string, unknown>)['latestDirection'] = existingSummary.latestDirection;
  if (existingSummary?.owners) (result as unknown as Record<string, unknown>)['owners'] = existingSummary.owners;
  if (existingSummary?.superseded) (result as unknown as Record<string, unknown>)['superseded'] = existingSummary.superseded;
  return result;
}

const SUMMARIZE_SYSTEM = `Summarize the older portion of a group chat into rolling compact memory for future turns.
Keep facts concrete, durable, and machine-usable.
Preserve the high-level summary, current objective, latest direction, decisions, open questions, owners, deadlines, active entities, mentioned resources, completed actions, blockers, user goals, and constraints.
Do not restate greetings, repetitive acknowledgements, or speculative reasoning.
Favor continuity and important operational state over verbatim detail.
Update changed facts instead of silently deleting them. If a previously important fact is now obsolete, put it in superseded.

Respond with valid JSON only. Schema:
{
  "summary": "string (max 6000 chars)",
  "latestObjective": "string (max 500 chars)",
  "latestDirection": "string (max 800 chars)",
  "activeEntities": ["string (max 20 items)"],
  "decisions": ["string (max 20 items)"],
  "openQuestions": ["string (max 20 items)"],
  "owners": ["string (max 20 items)"],
  "deadlines": ["string (max 20 items)"],
  "mentionedResources": ["string (max 24 items)"],
  "completedActions": ["string (max 20 items)"],
  "constraints": ["string (max 20 items)"],
  "blockers": ["string (max 20 items)"],
  "userGoals": ["string (max 20 items)"],
  "superseded": ["string (max 12 items)"]
}`;

function parseSummaryJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  return JSON.parse(candidate) as Record<string, unknown>;
}

function readString(value: unknown, fallback: string | undefined, maxChars: number): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, maxChars);
  return fallback;
}

function readStringArray(value: unknown, fallback: readonly string[] | undefined, maxItems: number): string[] {
  if (!Array.isArray(value)) return [...(fallback ?? [])].slice(-maxItems);
  return mergeRecentItems([], value.map(String), maxItems);
}

async function refreshSummaryWithLLM(
  compacted: readonly GroupChatMessage[],
  existingSummary: GroupChatSummary | null,
  model: LanguageModel,
  log: Logger,
): Promise<GroupChatSummary> {
  const deterministicBase = buildDeterministicSummary(compacted, existingSummary);

  const messageLines = compacted.map(m =>
    `${m.senderName} (${m.role}, ${m.createdAt}${m.botMentioned ? ', mentioned Divo' : ''}): ${m.content.slice(0, 700)}`,
  ).join('\n');

  try {
    const { text } = await generateText({
      model,
      system: SUMMARIZE_SYSTEM,
      prompt: JSON.stringify({
        priorSummary: existingSummary ?? null,
        olderMessages: messageLines,
      }),
      temperature: 0,
      maxOutputTokens: 4096,
      abortSignal: AbortSignal.timeout(15_000),
    });

    const parsed = parseSummaryJson(text);
    const result: GroupChatSummary = {
      activeEntities: readStringArray(parsed.activeEntities, deterministicBase.activeEntities, 20),
      decisions: readStringArray(parsed.decisions, deterministicBase.decisions, 20),
      openQuestions: readStringArray(parsed.openQuestions, deterministicBase.openQuestions, 20),
      owners: readStringArray(parsed.owners, deterministicBase.owners, 20),
      deadlines: readStringArray(parsed.deadlines, deterministicBase.deadlines, 20),
      mentionedResources: readStringArray(parsed.mentionedResources, deterministicBase.mentionedResources, 24),
      completedActions: readStringArray(parsed.completedActions, deterministicBase.completedActions, 20),
      constraints: readStringArray(parsed.constraints, deterministicBase.constraints, 20),
      blockers: readStringArray(parsed.blockers, deterministicBase.blockers, 20),
      userGoals: readStringArray(parsed.userGoals, deterministicBase.userGoals, 20),
      superseded: readStringArray(parsed.superseded, deterministicBase.superseded, 12),
      sourceMessageCount: deterministicBase.sourceMessageCount,
      updatedAt: new Date().toISOString(),
    };
    const summary = readString(parsed.summary, deterministicBase.summary, 6000);
    const latestObjective = readString(parsed.latestObjective, deterministicBase.latestObjective, 500);
    const latestDirection = readString(parsed.latestDirection, deterministicBase.latestDirection, 800);
    if (summary) (result as unknown as Record<string, unknown>)['summary'] = summary;
    if (latestObjective) (result as unknown as Record<string, unknown>)['latestObjective'] = latestObjective;
    if (latestDirection) (result as unknown as Record<string, unknown>)['latestDirection'] = latestDirection;
    return result;
  } catch (e) {
    log.warn('chat_context.llm_summary_failed', { error: String(e) });
    return deterministicBase;
  }
}

export class LarkChatContextService {
  constructor(private readonly deps: {
    repo: LarkChatContextRepoPort;
    model: LanguageModel;
    logger: Logger;
  }) {}

  async appendMessage(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
    senderOpenId: string;
    senderName: string;
    role: 'user' | 'assistant';
    content: string;
    botMentioned: boolean;
    attachedFiles?: string[];
  }): Promise<Result<void, InfraError>> {
    if (!input.content.trim() && (!input.attachedFiles || input.attachedFiles.length === 0)) {
      return ok(undefined);
    }

    const log = this.deps.logger.child({ chatId: input.chatId });

    const ctxResult = await this.deps.repo.getOrCreate({
      companyId: input.companyId,
      chatId: input.chatId,
      ...(input.chatType ? { chatType: input.chatType } : {}),
    });
    if (!ctxResult.ok) return err(ctxResult.error);
    const ctx = ctxResult.value;

    const existingMessages = Array.isArray(ctx.recentMessagesJson)
      ? (ctx.recentMessagesJson as GroupChatMessage[])
      : [];

    const newMessage: GroupChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderOpenId: input.senderOpenId,
      senderName: input.senderName,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString(),
      botMentioned: input.botMentioned,
      ...(input.attachedFiles && input.attachedFiles.length > 0
        ? { attachedFiles: input.attachedFiles }
        : {}),
    };

    const allMessages = [...existingMessages, newMessage];
    const newCount = ctx.sourceMessageCount + 1;

    const { compactedChunk, retained } = partitionRecentMessages(
      allMessages,
      GROUP_CONTEXT_POLICY.RETAINED_MESSAGE_TOKEN_BUDGET,
      GROUP_CONTEXT_POLICY.MIN_MESSAGES,
      GROUP_CONTEXT_POLICY.MAX_MESSAGES,
    );

    let summaryJson: unknown = ctx.summaryJson;

    if (compactedChunk.length > 0) {
      const existingSummary = ctx.summaryJson as GroupChatSummary | null;
      const shouldUseLLM =
        newCount >= GROUP_CONTEXT_POLICY.MIN_MESSAGES_FOR_LLM_SUMMARY &&
        compactedChunk.length >= GROUP_CONTEXT_POLICY.SUMMARY_REFRESH_DELTA;

      if (shouldUseLLM) {
        const summary = await refreshSummaryWithLLM(
          compactedChunk, existingSummary, this.deps.model, log,
        );
        summaryJson = { ...summary, sourceMessageCount: newCount };
      } else {
        const summary = buildDeterministicSummary(compactedChunk, existingSummary);
        summaryJson = { ...summary, sourceMessageCount: newCount };
      }
    }

    return this.deps.repo.update(ctx.id, {
      recentMessagesJson: retained,
      summaryJson,
      sourceMessageCount: newCount,
      lastMessageAt: new Date(),
    });
  }

  async loadContext(
    companyId: string,
    chatId: string,
  ): Promise<Result<GroupChatWindow, InfraError>> {
    const ctxResult = await this.deps.repo.getOrCreate({ companyId, chatId });
    if (!ctxResult.ok) return err(ctxResult.error);
    const ctx = ctxResult.value;

    const recentMessages = Array.isArray(ctx.recentMessagesJson)
      ? (ctx.recentMessagesJson as GroupChatMessage[])
      : [];

    const summary = ctx.summaryJson as GroupChatSummary | null;

    return ok({
      summary,
      recentMessages,
      totalMessageCount: ctx.sourceMessageCount,
    });
  }

  async clear(
    companyId: string,
    chatId: string,
  ): Promise<Result<void, InfraError>> {
    return this.deps.repo.clear(companyId, chatId);
  }
}
