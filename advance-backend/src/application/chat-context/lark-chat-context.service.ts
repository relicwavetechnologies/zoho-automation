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

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content.length > 10) {
      userGoals.push(`${msg.senderName}: ${msg.content.slice(0, 200)}`);
    }
    if (msg.role === 'assistant' && msg.content.length > 10) {
      completedActions.push(`Divo: ${msg.content.slice(0, 200)}`);
    }
  }

  const result: GroupChatSummary = {
    activeEntities: activeEntities.slice(-8),
    completedActions: completedActions.slice(-10),
    constraints: [...(existingSummary?.constraints ?? [])],
    userGoals: userGoals.slice(-8),
    sourceMessageCount: existingSummary?.sourceMessageCount ?? 0,
    updatedAt: new Date().toISOString(),
  };
  if (existingSummary?.summary) (result as unknown as Record<string, unknown>)['summary'] = existingSummary.summary;
  if (existingSummary?.latestObjective) (result as unknown as Record<string, unknown>)['latestObjective'] = existingSummary.latestObjective;
  return result;
}

const SUMMARIZE_SYSTEM = `Summarize the older portion of a group chat into rolling compact memory for future turns.
Keep facts concrete, durable, and machine-usable.
Preserve the high-level summary, current objective, active entities, user goals, completed actions, and constraints.
Do not restate greetings, repetitive acknowledgements, or speculative reasoning.
Favor continuity and important operational state over verbatim detail.

Respond with valid JSON only. Schema:
{
  "summary": "string (max 1600 chars)",
  "latestObjective": "string (max 300 chars)",
  "activeEntities": ["string (max 8 items)"],
  "completedActions": ["string (max 10 items)"],
  "constraints": ["string (max 8 items)"],
  "userGoals": ["string (max 8 items)"]
}`;

async function refreshSummaryWithLLM(
  compacted: readonly GroupChatMessage[],
  existingSummary: GroupChatSummary | null,
  model: LanguageModel,
  log: Logger,
): Promise<GroupChatSummary> {
  const deterministicBase = buildDeterministicSummary(compacted, existingSummary);

  const messageLines = compacted.map(m =>
    `${m.senderName} (${m.role}): ${m.content.slice(0, 500)}`,
  ).join('\n');

  try {
    const { text } = await generateText({
      model,
      system: SUMMARIZE_SYSTEM,
      prompt: JSON.stringify({
        priorSummary: existingSummary?.summary ?? null,
        olderMessages: messageLines,
      }),
      temperature: 0,
      maxOutputTokens: 1024,
      abortSignal: AbortSignal.timeout(15_000),
    });

    const parsed = JSON.parse(text.trim());
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1600) : deterministicBase.summary,
      latestObjective: typeof parsed.latestObjective === 'string' ? parsed.latestObjective.slice(0, 300) : deterministicBase.latestObjective,
      activeEntities: Array.isArray(parsed.activeEntities) ? parsed.activeEntities.slice(0, 8).map(String) : deterministicBase.activeEntities,
      completedActions: Array.isArray(parsed.completedActions) ? parsed.completedActions.slice(0, 10).map(String) : deterministicBase.completedActions,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.slice(0, 8).map(String) : deterministicBase.constraints,
      userGoals: Array.isArray(parsed.userGoals) ? parsed.userGoals.slice(0, 8).map(String) : deterministicBase.userGoals,
      sourceMessageCount: deterministicBase.sourceMessageCount,
      updatedAt: new Date().toISOString(),
    };
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
      GROUP_CONTEXT_POLICY.TOKEN_BUDGET,
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
