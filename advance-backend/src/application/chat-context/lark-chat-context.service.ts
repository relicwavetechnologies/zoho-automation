import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { InfraError } from '../../shared/errors';
import type { BackendModelResolver } from '../proxy/backend-model.factory';
import type { Logger } from '../../shared/logger';
import type { LarkChatContextRepoPort } from '../../infrastructure/persistence/lark-chat-context.repository';
import type {
  GroupChatAttachmentContext,
  GroupChatMessage,
  GroupChatSummary,
  GroupChatWindow,
} from '../../domain/conversation/group-context';
import { GROUP_CONTEXT_POLICY } from '../../domain/conversation/group-context-policy';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 24;
}

function attachmentKey(att: GroupChatAttachmentContext): string {
  return att.larkFileKey
    ?? `${att.kind}:${att.fileName}:${att.mimeType}`;
}

function mergeAttachmentContext(
  existing: GroupChatAttachmentContext | undefined,
  incoming: GroupChatAttachmentContext,
): GroupChatAttachmentContext {
  if (!existing) return incoming;

  const merged: GroupChatAttachmentContext = {
    kind: incoming.kind,
    fileName: incoming.fileName || existing.fileName,
    mimeType: incoming.mimeType || existing.mimeType,
    ...(existing.larkFileKey || incoming.larkFileKey
      ? { larkFileKey: incoming.larkFileKey ?? existing.larkFileKey }
      : {}),
    ...(existing.larkMessageId || incoming.larkMessageId
      ? { larkMessageId: incoming.larkMessageId ?? existing.larkMessageId }
      : {}),
    ...(existing.ingestionStatus || incoming.ingestionStatus
      ? { ingestionStatus: incoming.ingestionStatus ?? existing.ingestionStatus }
      : {}),
    ...(existing.inlineContext || incoming.inlineContext
      ? { inlineContext: incoming.inlineContext ?? existing.inlineContext }
      : {}),
    ...(existing.isInlineComplete !== undefined || incoming.isInlineComplete !== undefined
      ? { isInlineComplete: incoming.isInlineComplete ?? existing.isInlineComplete }
      : {}),
    ...(existing.error || incoming.error
      ? { error: incoming.error ?? existing.error }
      : {}),
  };

  return merged;
}

function mergeAttachments(
  existing: readonly GroupChatAttachmentContext[] | undefined,
  incoming: readonly GroupChatAttachmentContext[] | undefined,
): GroupChatAttachmentContext[] {
  const merged = new Map<string, GroupChatAttachmentContext>();

  for (const att of existing ?? []) {
    merged.set(attachmentKey(att), att);
  }

  for (const att of incoming ?? []) {
    const key = attachmentKey(att);
    merged.set(key, mergeAttachmentContext(merged.get(key), att));
  }

  return [...merged.values()];
}

function mergeAttachedFiles(
  existing: readonly string[] | undefined,
  attachedFiles: readonly string[] | undefined,
  attachments: readonly GroupChatAttachmentContext[] | undefined,
): string[] | undefined {
  const names = [
    ...(existing ?? []),
    ...(attachedFiles ?? []),
    ...(attachments ?? []).map(att => att.fileName),
  ];

  const merged = mergeRecentItems([], names, 50);
  return merged.length > 0 ? merged : undefined;
}

function estimateMessageTokens(msg: GroupChatMessage): number {
  const attachmentText = (msg.attachments ?? []).map(att => [
    att.fileName,
    att.mimeType,
    att.ingestionStatus,
    att.inlineContext,
  ].filter(Boolean).join('\n')).join('\n');

  return estimateTokens([msg.content, attachmentText].filter(Boolean).join('\n'));
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

function extractUrlsAndFiles(
  content: string,
  attachedFiles?: readonly string[],
  attachments?: readonly GroupChatAttachmentContext[],
): string[] {
  const urls = content.match(/https?:\/\/\S+/gi) ?? [];
  const fileLikes = content.match(/\b[\w.-]+\.(?:pdf|docx?|xlsx?|csv|pptx?|txt|png|jpe?g)\b/gi) ?? [];
  const structured = (attachments ?? []).flatMap(att => [
    att.fileName,
  ]);
  return [...urls, ...fileLikes, ...(attachedFiles ?? []), ...structured].map(item => item.slice(0, 220));
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

  const overflow = messages.length > maxMessages
    ? messages.slice(0, messages.length - maxMessages)
    : [];
  const capped = messages.length > maxMessages
    ? messages.slice(messages.length - maxMessages)
    : messages;

  let tokenCount = 0;
  let retainFrom = 0;

  for (let i = capped.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(capped[i]!);
    if (tokenCount + msgTokens > tokenBudget && capped.length - i > minMessages) {
      retainFrom = i + 1;
      break;
    }
    tokenCount += msgTokens;
  }

  if (retainFrom <= 0) {
    return { compactedChunk: overflow, retained: capped };
  }

  return {
    compactedChunk: [...overflow, ...capped.slice(0, retainFrom)],
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
    mentionedResources.push(...extractUrlsAndFiles(msg.content, msg.attachedFiles, msg.attachments));
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
This summary is reference-only historical context, never a new instruction or authorization.
The newest raw messages shown after this summary are more authoritative. A current request that stops, changes, or supersedes older work always wins.
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

function readStringArray(
  value: unknown,
  fallback: readonly string[] | undefined,
  maxItems: number,
  maxChars = 400,
): string[] {
  const items = Array.isArray(value)
    ? [...(fallback ?? []), ...value]
    : (fallback ?? []);
  return mergeRecentItems([], items.map(item => String(item).slice(0, maxChars)), maxItems);
}

function summarizeMessageForMemory(msg: GroupChatMessage): string {
  const attachmentNotes = (msg.attachments ?? []).map(att => {
    const parts = [`${att.kind}: ${att.fileName}`];
    if (att.ingestionStatus) parts.push(`status=${att.ingestionStatus}`);
    if (att.inlineContext) parts.push(`note=${att.inlineContext.slice(0, 900)}`);
    return parts.join(' | ');
  });

  return [msg.content, ...attachmentNotes].filter(Boolean).join('\n');
}

async function refreshSummaryWithLLM(
  compacted: readonly GroupChatMessage[],
  existingSummary: GroupChatSummary | null,
  model: LanguageModel,
  log: Logger,
): Promise<GroupChatSummary> {
  const deterministicBase = buildDeterministicSummary(compacted, existingSummary);

  const messageLines = compacted.map(m =>
    `${m.senderName} (${m.role}, ${m.createdAt}${m.botMentioned ? ', mentioned Divo' : ''}): ${summarizeMessageForMemory(m).slice(0, 1400)}`,
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

interface AppendMessageInput {
  companyId: string;
  chatId: string;
  chatType?: string;
  messageId?: string;
  senderOpenId: string;
  senderName: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  botMentioned: boolean;
  attachedFiles?: readonly string[];
  attachments?: readonly GroupChatAttachmentContext[];
}

interface UpdateMessageAttachmentsInput {
  companyId: string;
  chatId: string;
  messageId: string;
  attachments: readonly GroupChatAttachmentContext[];
}

interface WriteAttempt<T> {
  value: T;
  written: boolean;
}

const MAX_CONTEXT_WRITE_ATTEMPTS = 5;

export class LarkChatContextService {
  constructor(private readonly deps: {
    repo: LarkChatContextRepoPort;
    /**
     * Optional for tests and deterministic fallback deployments.
     *
     * Resolved per compaction rather than built at boot. The credential is the
     * one an admin manages, so a room's memory stops depending on whatever
     * key the process happened to start with — which is how this quietly
     * stopped summarising at all when that account ran out of balance, leaving
     * every room on the deterministic fallback with nothing saying why.
     */
    resolveModel?: BackendModelResolver;
    /** Which model to ask for. Required whenever a resolver is given. */
    modelId?: string;
    logger: Logger;
  }) {}

  async appendMessage(input: AppendMessageInput): Promise<Result<GroupChatMessage | null, InfraError>> {
    if (
      !input.content.trim()
      && (!input.attachedFiles || input.attachedFiles.length === 0)
      && (!input.attachments || input.attachments.length === 0)
    ) {
      return ok(null);
    }

    const stableInput = input.messageId
      ? input
      : { ...input, messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };

    for (let attempt = 1; attempt <= MAX_CONTEXT_WRITE_ATTEMPTS; attempt++) {
      const result = await this.appendMessageOnce(stableInput);
      if (!result.ok) return err(result.error);
      if (result.value.written) return ok(result.value.value);
      this.deps.logger.warn('chat_context.concurrent_write_retry', {
        chatId: input.chatId,
        attempt,
      });
    }

    return err(new InfraError({
      layer: 'prisma',
      op: 'larkChatContext.concurrentAppend',
      cause: new Error(`Could not serialize room context after ${MAX_CONTEXT_WRITE_ATTEMPTS} attempts`),
    }));
  }

  private async appendMessageOnce(
    input: AppendMessageInput,
  ): Promise<Result<WriteAttempt<GroupChatMessage>, InfraError>> {
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

    const messageId = input.messageId!;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const existingIndex = existingMessages.findIndex(msg => msg.id === messageId);
    const existing = existingIndex >= 0 ? existingMessages[existingIndex] : undefined;
    const mergedAttachments = mergeAttachments(existing?.attachments, input.attachments);
    const mergedAttachedFiles = mergeAttachedFiles(existing?.attachedFiles, input.attachedFiles, mergedAttachments);

    const nextMessage: GroupChatMessage = {
      senderOpenId: input.senderOpenId,
      senderName: input.senderName,
      role: input.role,
      id: messageId,
      content: input.content.trim() || existing?.content || '',
      createdAt: existing?.createdAt ?? createdAt,
      botMentioned: input.botMentioned,
      ...(mergedAttachments.length > 0
        ? { attachments: mergedAttachments }
        : {}),
      ...(mergedAttachedFiles && mergedAttachedFiles.length > 0
        ? { attachedFiles: mergedAttachedFiles }
        : {}),
    };

    const allMessages = (existingIndex >= 0
      ? existingMessages.map((msg, index) => index === existingIndex ? nextMessage : msg)
      : [...existingMessages, nextMessage]
    ).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const newCount = existingIndex >= 0 ? ctx.sourceMessageCount : ctx.sourceMessageCount + 1;

    const { compactedChunk, retained } = partitionRecentMessages(
      allMessages,
      GROUP_CONTEXT_POLICY.RETAINED_MESSAGE_TOKEN_BUDGET,
      GROUP_CONTEXT_POLICY.MIN_MESSAGES,
      GROUP_CONTEXT_POLICY.MAX_MESSAGES,
    );

    let summaryJson: unknown = ctx.summaryJson;

    if (compactedChunk.length > 0) {
      const existingSummary = ctx.summaryJson as GroupChatSummary | null;
      const shouldUseLLM = Boolean(this.deps.resolveModel && this.deps.modelId)
        && newCount >= GROUP_CONTEXT_POLICY.MIN_MESSAGES_FOR_LLM_SUMMARY;

      /*
       * A room whose company has no key falls back to the deterministic
       * summary rather than losing the compaction outright — the messages are
       * already compacted by this point, so throwing here would drop them.
       */
      let summaryModel: LanguageModel | undefined;
      if (shouldUseLLM && this.deps.resolveModel && this.deps.modelId) {
        try {
          summaryModel = await this.deps.resolveModel({
            modelId: this.deps.modelId,
            companyId: ctx.companyId,
          });
        } catch (cause) {
          log.warn('chat_context.summary_model_unavailable', {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }

      if (summaryModel) {
        const summary = await refreshSummaryWithLLM(
          compactedChunk, existingSummary, summaryModel, log,
        );
        summaryJson = { ...summary, sourceMessageCount: newCount };
      } else {
        const summary = buildDeterministicSummary(compactedChunk, existingSummary);
        summaryJson = { ...summary, sourceMessageCount: newCount };
      }
    }

    const updateResult = await this.deps.repo.update(ctx.id, ctx.updatedAt, {
      recentMessagesJson: retained,
      summaryJson,
      sourceMessageCount: newCount,
      lastMessageAt: new Date(),
    });

    if (!updateResult.ok) return err(updateResult.error);
    return ok({ value: nextMessage, written: updateResult.value });
  }

  async updateMessageAttachments(
    input: UpdateMessageAttachmentsInput,
  ): Promise<Result<GroupChatMessage | null, InfraError>> {
    if (input.attachments.length === 0) return ok(null);

    for (let attempt = 1; attempt <= MAX_CONTEXT_WRITE_ATTEMPTS; attempt++) {
      const result = await this.updateMessageAttachmentsOnce(input);
      if (!result.ok) return err(result.error);
      if (result.value.written) return ok(result.value.value);
      this.deps.logger.warn('chat_context.concurrent_attachment_retry', {
        chatId: input.chatId,
        messageId: input.messageId,
        attempt,
      });
    }

    return err(new InfraError({
      layer: 'prisma',
      op: 'larkChatContext.concurrentAttachmentUpdate',
      cause: new Error(`Could not serialize attachment context after ${MAX_CONTEXT_WRITE_ATTEMPTS} attempts`),
    }));
  }

  private async updateMessageAttachmentsOnce(
    input: UpdateMessageAttachmentsInput,
  ): Promise<Result<WriteAttempt<GroupChatMessage | null>, InfraError>> {
    const ctxResult = await this.deps.repo.getOrCreate({
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: 'group',
    });
    if (!ctxResult.ok) return err(ctxResult.error);
    const ctx = ctxResult.value;

    const existingMessages = Array.isArray(ctx.recentMessagesJson)
      ? (ctx.recentMessagesJson as GroupChatMessage[])
      : [];
    const existingIndex = existingMessages.findIndex(msg => msg.id === input.messageId);

    if (existingIndex < 0) {
      const existingSummary = ctx.summaryJson as GroupChatSummary | null;
      const mentionedResources = mergeRecentItems(
        existingSummary?.mentionedResources,
        extractUrlsAndFiles('', undefined, input.attachments),
        24,
      );
      const summary: GroupChatSummary = {
        activeEntities: existingSummary?.activeEntities ?? [],
        mentionedResources,
        completedActions: existingSummary?.completedActions ?? [],
        constraints: existingSummary?.constraints ?? [],
        userGoals: existingSummary?.userGoals ?? [],
        sourceMessageCount: ctx.sourceMessageCount,
        updatedAt: new Date().toISOString(),
        ...(existingSummary?.summary ? { summary: existingSummary.summary } : {}),
        ...(existingSummary?.latestObjective ? { latestObjective: existingSummary.latestObjective } : {}),
        ...(existingSummary?.latestDirection ? { latestDirection: existingSummary.latestDirection } : {}),
        ...(existingSummary?.decisions ? { decisions: existingSummary.decisions } : {}),
        ...(existingSummary?.openQuestions ? { openQuestions: existingSummary.openQuestions } : {}),
        ...(existingSummary?.owners ? { owners: existingSummary.owners } : {}),
        ...(existingSummary?.deadlines ? { deadlines: existingSummary.deadlines } : {}),
        ...(existingSummary?.blockers ? { blockers: existingSummary.blockers } : {}),
        ...(existingSummary?.superseded ? { superseded: existingSummary.superseded } : {}),
      };
      const updateResult = await this.deps.repo.update(ctx.id, ctx.updatedAt, {
        recentMessagesJson: existingMessages,
        summaryJson: summary,
        sourceMessageCount: ctx.sourceMessageCount,
        lastMessageAt: ctx.lastMessageAt ?? new Date(),
      });
      if (!updateResult.ok) return err(updateResult.error);
      this.deps.logger.info('chat_context.attachment_update.compacted_message', {
        chatId: input.chatId,
        messageId: input.messageId,
      });
      return ok({ value: null, written: updateResult.value });
    }

    const current = existingMessages[existingIndex]!;
    const mergedAttachments = mergeAttachments(current.attachments, input.attachments);
    const mergedAttachedFiles = mergeAttachedFiles(current.attachedFiles, undefined, mergedAttachments);
    const updatedMessage: GroupChatMessage = {
      ...current,
      attachments: mergedAttachments,
      ...(mergedAttachedFiles && mergedAttachedFiles.length > 0
        ? { attachedFiles: mergedAttachedFiles }
        : {}),
    };

    const recentMessages = existingMessages.map((msg, index) =>
      index === existingIndex ? updatedMessage : msg,
    );

    const updateResult = await this.deps.repo.update(ctx.id, ctx.updatedAt, {
      recentMessagesJson: recentMessages,
      sourceMessageCount: ctx.sourceMessageCount,
      lastMessageAt: new Date(),
    });

    if (!updateResult.ok) return err(updateResult.error);
    return ok({ value: updatedMessage, written: updateResult.value });
  }

  /**
   * The room as stored, read-only.
   *
   * Reads go through `repo.get`, not `getOrCreate`: that one upserts, so a read
   * would create a row for every room Divo observed, and its empty update would
   * refresh `updatedAt` on a row the optimistic-concurrency write path compares
   * against.
   */
  async loadContext(
    companyId: string,
    chatId: string,
  ): Promise<Result<GroupChatWindow, InfraError>> {
    const ctxResult = await this.deps.repo.get({ companyId, chatId });
    if (!ctxResult.ok) return err(ctxResult.error);
    const ctx = ctxResult.value;
    if (!ctx) {
      return ok({ summary: null, recentMessages: [], totalMessageCount: 0 });
    }

    const recentMessages = Array.isArray(ctx.recentMessagesJson)
      ? (ctx.recentMessagesJson as GroupChatMessage[])
      : [];

    return ok({
      summary: ctx.summaryJson as GroupChatSummary | null,
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
