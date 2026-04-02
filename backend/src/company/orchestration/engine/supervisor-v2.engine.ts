import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

import { resolveChannelAdapter } from '../../channels';
import { larkChatContextService } from '../../channels/lark/lark-chat-context.service';
import {
  type AgentResultDTO,
  type HITLActionDTO,
  type NormalizedIncomingMessageDTO,
  type OrchestrationTaskDTO,
} from '../../contracts';
import { departmentPreferenceService } from '../../departments/department-preference.service';
import { departmentService } from '../../departments/department.service';
import {
  executionService,
} from '../../observability';
import { conversationMemoryStore } from '../../state/conversation';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { DOMAIN_TO_TOOL_IDS } from '../../tools/tool-registry';
import { resolveCanonicalIntent } from '../intent/canonical-intent';
import type { OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';
import { LarkStatusCoordinator } from './lark-status.coordinator';
import { createVercelDesktopTools } from '../vercel/legacy-tools';
import { resolveVercelLanguageModel } from '../vercel/model-factory';
import type {
  PendingApprovalAction,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
  VercelRuntimeToolHooks,
} from '../vercel/types';
import { desktopThreadsService } from '../../../modules/desktop-threads/desktop-threads.service';
import { logger } from '../../../utils/logger';

type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type LegacyExecutableTool = {
  execute: (input: unknown, options?: unknown) => Promise<unknown>;
};

type SubAgentTextResult = {
  text: string;
  toolResults: VercelToolEnvelope[];
  pendingApproval: PendingApprovalAction | null;
};

export type SupervisorV2ExecutionOutput = OrchestrationExecutionResult & {
  finalText: string;
  toolResults: VercelToolEnvelope[];
  pendingApproval: PendingApprovalAction | null;
  statusMessageId?: string;
  hasToolResults: boolean;
  isSensitiveContent: boolean;
};

type ConversationContextSnapshot = {
  linkedUserId?: string;
  isSharedGroupChat: boolean;
  sharedChatContextId?: string;
  persistentThreadId?: string;
  recentTurns: ChatTurn[];
};

const LARK_V2_MODE: VercelRuntimeRequestContext['mode'] = 'high';
const SUPERVISOR_MAX_TURNS = 8;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const summarizeText = (value: string | null | undefined, limit = 240): string => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const stripMarkdownDecorators = (value: string): string =>
  value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();

const compactWhitespace = (value: string): string => value.replace(/\n{3,}/g, '\n\n').trim();

const isMarkdownTableLine = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.startsWith('|') && trimmed.endsWith('|');
};

const isMarkdownTableDivider = (line: string): boolean =>
  /^[\s|:-]+$/.test(line.trim());

const splitTableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripMarkdownDecorators(cell.trim()))
    .filter((cell) => cell.length > 0);

const rewriteMarkdownTables = (value: string, maxRows = 10): string => {
  const lines = value.split('\n');
  const rewritten: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!isMarkdownTableLine(line)) {
      rewritten.push(line);
      continue;
    }

    const header = splitTableCells(line);
    const divider = lines[index + 1] ?? '';
    if (header.length === 0 || !isMarkdownTableDivider(divider)) {
      rewritten.push(line);
      continue;
    }

    const rows: string[] = [];
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableLine(lines[cursor] ?? '')) {
      const cells = splitTableCells(lines[cursor] ?? '');
      if (cells.length > 0) {
        const summary = header
          .map((column, cellIndex) => `${column}: ${cells[cellIndex] ?? '-'}`)
          .join(' | ');
        rows.push(`- ${summary}`);
      }
      cursor += 1;
    }

    rewritten.push(rows.slice(0, maxRows).join('\n'));
    if (rows.length > maxRows) {
      rewritten.push(`- ...and ${rows.length - maxRows} more rows.`);
    }
    index = cursor - 1;
  }

  return rewritten.join('\n');
};

const compactBulletLists = (value: string, maxItems = 12): string => {
  const lines = value.split('\n');
  const rewritten: string[] = [];
  let bufferedBullets: string[] = [];

  const flushBullets = () => {
    if (bufferedBullets.length === 0) {
      return;
    }
    rewritten.push(...bufferedBullets.slice(0, maxItems));
    if (bufferedBullets.length > maxItems) {
      rewritten.push(`- ...and ${bufferedBullets.length - maxItems} more items.`);
    }
    bufferedBullets = [];
  };

  for (const line of lines) {
    if (/^\s*[-*•]\s+/.test(line)) {
      bufferedBullets.push(line.replace(/^\s*[•*]\s+/, '- ').trimEnd());
      continue;
    }
    flushBullets();
    rewritten.push(line);
  }
  flushBullets();

  return rewritten.join('\n');
};

const truncateForLark = (value: string, maxChars = 2600): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const boundary = Math.max(
    trimmed.lastIndexOf('\n\n', maxChars),
    trimmed.lastIndexOf('\n', maxChars),
    trimmed.lastIndexOf('. ', maxChars),
  );
  const cutAt = boundary > 400 ? boundary : maxChars;
  return `${trimmed.slice(0, cutAt).trim()}\n\nReply with "continue" if you want the remaining items.`;
};

const buildActionAwareSummary = (
  toolResults: VercelToolEnvelope[],
  pendingApproval: PendingApprovalAction | null,
): string | null => {
  const approvalRecord = pendingApproval?.kind === 'tool_action'
    ? asRecord(pendingApproval.payload)
    : undefined;
  if (pendingApproval?.kind === 'tool_action' && pendingApproval.operation === 'sendMessage' && approvalRecord) {
    const to = asString(approvalRecord.to) ?? 'the recipient';
    const subject = asString(approvalRecord.subject) ?? 'No subject';
    const body = summarizeText(asString(approvalRecord.body), 180);
    return [
      `I prepared an email to ${to}.`,
      `Subject: ${subject}`,
      body ? `Preview: ${body}` : '',
    ].filter(Boolean).join('\n');
  }
  if (pendingApproval?.kind === 'tool_action' && pendingApproval.operation === 'createDraft' && approvalRecord) {
    const to = asString(approvalRecord.to) ?? 'the recipient';
    const subject = asString(approvalRecord.subject) ?? 'No subject';
    return `I prepared a draft for ${to} with subject "${subject}".`;
  }
  if (pendingApproval?.kind === 'tool_action' && pendingApproval.operation === 'sendDm' && approvalRecord) {
    const recipients = asArray(approvalRecord.recipientLabels)
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join(', ');
    const preview = summarizeText(asString(approvalRecord.message), 180);
    return [
      `I prepared a Lark message for ${recipients || 'the selected recipients'}.`,
      preview ? `Preview: ${preview}` : '',
    ].filter(Boolean).join('\n');
  }
  const firstAction = toolResults.find((entry) => entry.confirmedAction || entry.pendingApprovalAction);
  if (!firstAction) {
    return null;
  }
  return firstAction.summary;
};

const formatFinalTextForLark = (
  text: string,
  toolResults: VercelToolEnvelope[],
  pendingApproval: PendingApprovalAction | null,
): string => {
  const preferredLead = buildActionAwareSummary(toolResults, pendingApproval);
  let formatted = stripMarkdownDecorators(text);
  formatted = rewriteMarkdownTables(formatted);
  formatted = compactBulletLists(formatted);
  formatted = compactWhitespace(formatted);

  if (preferredLead && !formatted.toLowerCase().includes(preferredLead.toLowerCase())) {
    formatted = `${preferredLead}\n\n${formatted}`.trim();
  }

  return truncateForLark(formatted);
};

const buildConversationKey = (message: NormalizedIncomingMessageDTO): string =>
  `${message.channel}:${message.chatId}`;

const buildPersistentLarkConversationKey = (threadId: string): string => `lark-thread:${threadId}`;

const buildSharedLarkConversationKey = (chatId: string): string => `lark-chat:${chatId}`;

const noOpToolHooks: VercelRuntimeToolHooks = {
  onToolStart: async () => undefined,
  onToolFinish: async () => undefined,
};

const appendExecutionEventSafe = async (
  input: Parameters<typeof executionService.appendEvent>[0],
): Promise<void> => {
  try {
    await executionService.appendEvent(input);
  } catch (error) {
    logger.warn('supervisor_v2.execution.event.failed', {
      executionId: input.executionId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
};

const resolveCanonicalExecutionId = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
): string => message.trace?.requestId?.trim() || task.taskId;

const normalizeTurns = (
  entries: Array<{ role?: string | null; content?: string | null }>,
): ChatTurn[] =>
  entries.flatMap((entry) => {
    const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null;
    const content = entry.content?.trim();
    if (!role || !content) {
      return [];
    }
    return [{ role, content }];
  });

const dedupeTrailingCurrentMessage = (
  turns: ChatTurn[],
  latestMessage: string,
): ChatTurn[] => {
  const trimmedLatest = latestMessage.trim();
  if (!trimmedLatest) {
    return turns;
  }
  const last = turns[turns.length - 1];
  if (last?.role === 'user' && last.content.trim() === trimmedLatest) {
    return turns.slice(0, -1);
  }
  return turns;
};

const buildPermissionSummary = (runtime: VercelRuntimeRequestContext): string => {
  const preferredTools = ['contextSearch', 'googleWorkspace', 'zohoBooks', 'zohoCrm', 'larkTask', 'larkMessage'];
  const entries = preferredTools.flatMap((toolId) => {
    const actions = runtime.allowedActionsByTool?.[toolId];
    if (!actions?.length) {
      return [];
    }
    return [`${toolId}:${actions.join('/')}`];
  });
  return entries.length > 0 ? entries.join(', ') : 'Use only tools permitted by the runtime.';
};

const buildSupervisorSystemPrompt = (runtime: VercelRuntimeRequestContext): string => {
  const today = new Date().toISOString().slice(0, 10);
  const departmentLabel = runtime.departmentName?.trim() || 'no specific department';
  const requesterLabel = runtime.requesterName?.trim() || runtime.requesterEmail?.trim() || 'the current user';
  return [
    `You are Divo, the orchestration supervisor for company ${runtime.companyId} and department ${departmentLabel}.`,
    `You are helping ${requesterLabel}. Today is ${today}.`,
    'Available agents:',
    '- contextAgent: search contacts, documents, web, or prior conversation facts before acting.',
    '- googleWorkspaceAgent: Gmail, drafts, search, and Google actions. Sending email needs human approval.',
    '- zohoAgent: invoices, overdue reports, payments, and CRM/Books records.',
    '- larkAgent: create Lark tasks or send Lark messages for internal follow-up.',
    'Rules:',
    '1. Only act on the latest user message.',
    '2. Prior conversation shows completed work and context. Never redo completed actions unless the latest message clearly asks for it.',
    '3. If an agent returns an error, read it, fix the objective or arguments, and retry.',
    '4. Be concise in the final response.',
    '5. Never hallucinate tool names. Use only the 4 agents listed above.',
    '6. If you send, draft, or prepare a message, say what was sent or prepared with recipient plus a short content preview, not only that it happened.',
    `Permissions summary: ${buildPermissionSummary(runtime)}.`,
  ].join('\n');
};

const buildSubAgentPrompt = (label: string, guidance: string): string =>
  `You are a ${label}. ${guidance}`.trim();

const buildSubAgentUserMessage = (
  objective: string,
  extra?: Record<string, string | boolean | undefined>,
): string => {
  const lines = [`Objective: ${objective}`];
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined || value === '') {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines.join('\n');
};

const extractToolEnvelopes = (steps: unknown): VercelToolEnvelope[] => {
  const envelopes: VercelToolEnvelope[] = [];
  for (const step of asArray(steps)) {
    const stepRecord = asRecord(step);
    for (const toolResult of asArray(stepRecord?.toolResults)) {
      const output = asRecord(asRecord(toolResult)?.output);
      if (!output) {
        continue;
      }
      const success = asBoolean(output.success);
      const summary = asString(output.summary);
      const toolId = asString(output.toolId);
      const status = asString(output.status);
      if (success === undefined || !summary || !toolId || !status) {
        continue;
      }
      envelopes.push(output as VercelToolEnvelope);
    }
  }
  return envelopes;
};

const extractPendingApproval = (toolResults: VercelToolEnvelope[]): PendingApprovalAction | null => {
  for (const toolResult of toolResults) {
    if (toolResult.pendingApprovalAction) {
      return toolResult.pendingApprovalAction;
    }
    if (toolResult.mutationResult?.pendingApproval) {
      return toolResult.pendingApprovalAction ?? null;
    }
  }
  return null;
};

const buildHitlAction = (
  task: OrchestrationTaskDTO,
  pendingApproval: PendingApprovalAction | null,
  channel: 'desktop' | 'lark' | undefined,
): HITLActionDTO | undefined => {
  if (!pendingApproval) {
    return undefined;
  }
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const actionType: HITLActionDTO['actionType'] =
    pendingApproval.kind === 'delete_path'
      ? 'delete'
      : pendingApproval.kind === 'run_command'
        ? 'execute'
        : pendingApproval.kind === 'write_file' || pendingApproval.kind === 'create_directory'
          ? 'write'
          : pendingApproval.actionGroup === 'delete'
            ? 'delete'
            : pendingApproval.actionGroup === 'update'
              ? 'update'
              : pendingApproval.actionGroup === 'execute'
                ? 'execute'
                : 'write';
  return {
    taskId: task.taskId,
    actionId:
      pendingApproval.kind === 'tool_action'
        ? pendingApproval.approvalId
        : `${task.taskId}:${pendingApproval.kind}`,
    actionType,
    summary:
      pendingApproval.kind === 'tool_action'
        ? pendingApproval.summary
        : pendingApproval.explanation ?? pendingApproval.title ?? 'Approval required',
    toolId: pendingApproval.kind === 'tool_action' ? pendingApproval.toolId : undefined,
    actionGroup: pendingApproval.kind === 'tool_action' ? pendingApproval.actionGroup : undefined,
    channel,
    subject: pendingApproval.kind === 'tool_action' ? pendingApproval.subject : pendingApproval.title,
    requestedAt,
    expiresAt,
    status: 'pending',
  };
};

const resolveWorkspaceUserIdForLarkMessage = async (
  message: NormalizedIncomingMessageDTO,
): Promise<string | undefined> => {
  const linkedUserId = message.trace?.linkedUserId;
  if (linkedUserId) {
    return linkedUserId;
  }
  const companyId = message.trace?.companyId;
  const channelIdentityId = message.trace?.channelIdentityId;
  if (!companyId || !channelIdentityId) {
    return undefined;
  }
  try {
    const mapped = await departmentService.resolveWorkspaceMemberFromChannelIdentity({
      companyId,
      channelIdentityId,
    });
    return mapped.userId;
  } catch (error) {
    logger.info('supervisor_v2.channel_identity_unresolved', {
      companyId,
      channelIdentityId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return undefined;
  }
};

const resolveConversationContext = async (
  input: OrchestrationExecutionInput,
): Promise<ConversationContextSnapshot> => {
  const { task, message } = input;
  const companyId = message.trace?.companyId;
  const linkedUserId = await resolveWorkspaceUserIdForLarkMessage(message);
  const isSharedGroupChat = Boolean(companyId && message.chatType === 'group' && message.chatId);

  if (isSharedGroupChat && companyId) {
    const shared = await larkChatContextService.load({
      companyId,
      chatId: message.chatId,
      chatType: message.chatType,
    });
    return {
      linkedUserId,
      isSharedGroupChat,
      sharedChatContextId: shared.id,
      recentTurns: dedupeTrailingCurrentMessage(
        normalizeTurns(shared.recentMessages).slice(-SUPERVISOR_MAX_TURNS),
        message.text,
      ),
    };
  }

  if (companyId && linkedUserId) {
    const thread = await desktopThreadsService.findOrCreateLarkLifetimeThread(linkedUserId, companyId);
    const cached = await desktopThreadsService.getCachedOwnedThreadContext(
      thread.id,
      linkedUserId,
      24,
    );
    return {
      linkedUserId,
      isSharedGroupChat: false,
      persistentThreadId: thread.id,
      recentTurns: dedupeTrailingCurrentMessage(
        normalizeTurns(
          cached.messages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
        ).slice(-SUPERVISOR_MAX_TURNS),
        message.text,
      ),
    };
  }

  const conversationKey = buildConversationKey(message);
  return {
    linkedUserId,
    isSharedGroupChat: false,
    recentTurns: dedupeTrailingCurrentMessage(
      normalizeTurns(
        conversationMemoryStore.getContextMessages(conversationKey).map((entry) => ({
          role: entry.role,
          content: entry.content,
        })),
      ).slice(-SUPERVISOR_MAX_TURNS),
      message.text,
    ),
  };
};

const resolveRuntimeContext = async (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  contextStorageId: string | undefined,
): Promise<VercelRuntimeRequestContext> => {
  const companyId = message.trace?.companyId;
  if (!companyId) {
    throw new Error('Missing companyId for supervisor-v2 runtime.');
  }

  const canonicalIntent = task.canonicalIntent ?? await resolveCanonicalIntent({
    message: message.text,
  });
  const requesterAiRole = message.trace?.userRole ?? 'MEMBER';
  const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(companyId, requesterAiRole);
  const linkedUserId = await resolveWorkspaceUserIdForLarkMessage(message);

  let departmentId: string | undefined;
  let departmentName: string | undefined;
  let departmentRoleId: string | undefined;
  let departmentRoleSlug: string | undefined;
  let departmentZohoReadScope: 'personalized' | 'show_all' | undefined;
  let departmentZohoRateLimitConfig: VercelRuntimeRequestContext['departmentZohoRateLimitConfig'];
  let departmentManagerApprovalConfig: VercelRuntimeRequestContext['departmentManagerApprovalConfig'];
  let departmentSystemPrompt: string | undefined;
  let departmentSkillsMarkdown: string | undefined;
  let allowedToolIds = fallbackAllowedToolIds;
  let allowedActionsByTool = await toolPermissionService.getAllowedActionsByTool(
    companyId,
    requesterAiRole,
    fallbackAllowedToolIds,
  );

  if (linkedUserId) {
    const departments = await departmentService.listUserDepartments(linkedUserId, companyId);
    const preferredDepartment = await departmentPreferenceService.resolveForRuntime(
      companyId,
      linkedUserId,
      departments,
    );
    if (preferredDepartment.reason !== 'needs_selection') {
      const resolved = await departmentService.resolveRuntimeContext({
        userId: linkedUserId,
        companyId,
        departmentId: preferredDepartment.departmentId,
        fallbackAllowedToolIds,
        requesterAiRole,
      });
      departmentId = resolved.departmentId;
      departmentName = resolved.departmentName;
      departmentRoleId = resolved.departmentRoleId;
      departmentRoleSlug = resolved.departmentRoleSlug;
      departmentZohoReadScope = resolved.departmentZohoReadScope;
      departmentZohoRateLimitConfig = resolved.departmentZohoRateLimitConfig;
      departmentManagerApprovalConfig = resolved.departmentManagerApprovalConfig;
      departmentSystemPrompt = resolved.systemPrompt;
      departmentSkillsMarkdown = resolved.skillsMarkdown;
      allowedToolIds = resolved.allowedToolIds;
      allowedActionsByTool = resolved.allowedActionsByTool;
    }
  }

  if (!allowedToolIds.includes('contextSearch')) {
    allowedToolIds = [...allowedToolIds, 'contextSearch'];
  }
  for (const toolId of DOMAIN_TO_TOOL_IDS[canonicalIntent.domain] ?? []) {
    if (!allowedToolIds.includes(toolId)) {
      allowedToolIds = [...allowedToolIds, toolId];
    }
  }

  return {
    channel: message.channel === 'lark' ? 'lark' : 'desktop',
    threadId: contextStorageId ?? buildConversationKey(message),
    chatId: message.chatId,
    attachedFiles: message.attachedFiles,
    executionId: resolveCanonicalExecutionId(task, message),
    companyId,
    userId: linkedUserId ?? message.userId,
    requesterAiRole,
    requesterChannelIdentityId: message.trace?.channelIdentityId,
    requesterName: message.trace?.requesterName,
    requesterEmail: message.trace?.requesterEmail,
    sourceMessageId: message.messageId,
    sourceReplyToMessageId: message.trace?.replyToMessageId ?? message.messageId,
    sourceStatusMessageId: message.trace?.statusMessageId,
    sourceStatusReplyModeHint: message.trace?.statusReplyModeHint,
    sourceChatType: message.chatType,
    sourceChannelUserId: message.userId,
    latestUserMessage: message.text,
    departmentId,
    departmentName,
    departmentRoleId,
    departmentRoleSlug,
    departmentZohoReadScope,
    departmentZohoRateLimitConfig,
    departmentManagerApprovalConfig,
    larkTenantKey: message.trace?.larkTenantKey,
    larkOpenId: message.trace?.larkOpenId,
    larkUserId: message.trace?.larkUserId,
    authProvider: message.channel === 'lark' ? 'lark' : message.trace?.authProvider,
    mode: LARK_V2_MODE,
    allowedToolIds,
    allowedActionsByTool,
    departmentSystemPrompt,
    departmentSkillsMarkdown,
    canonicalIntent,
  };
};

const getLegacyTools = (runtime: VercelRuntimeRequestContext): Record<string, LegacyExecutableTool> =>
  createVercelDesktopTools(runtime, noOpToolHooks) as unknown as Record<string, LegacyExecutableTool>;

const runSubAgent = async (
  input: {
    label: string;
    prompt: string;
    message: string;
    tools: Record<string, ReturnType<typeof tool>>;
    runtime: VercelRuntimeRequestContext;
    abortSignal?: AbortSignal;
    onStepFinish?: (step: unknown) => Promise<void>;
  },
): Promise<SubAgentTextResult> => {
  const resolvedModel = await resolveVercelLanguageModel(input.runtime.mode);
  const result = await generateText({
    model: resolvedModel.model,
    system: input.prompt,
    messages: [{ role: 'user', content: input.message }],
    tools: input.tools,
    temperature: 0,
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: resolvedModel.includeThoughts,
          thinkingLevel: resolvedModel.thinkingLevel,
        },
      },
    },
    stopWhen: stepCountIs(3),
    abortSignal: input.abortSignal,
    onStepFinish: input.onStepFinish,
  });

  const toolResults = extractToolEnvelopes(result.steps);
  const pendingApproval = extractPendingApproval(toolResults);
  const fallbackText =
    summarizeText(result.text, 800)
    || toolResults.map((entry) => entry.summary).filter(Boolean).join('\n')
    || `${input.label} completed without a textual summary.`;

  return {
    text: fallbackText,
    toolResults,
    pendingApproval,
  };
};

async function runContextAgent(
  params: { objective: string; webSearch?: boolean; contactSearch?: boolean },
  runtime: VercelRuntimeRequestContext,
  abortSignal?: AbortSignal,
  onStepFinish?: (step: unknown) => Promise<void>,
): Promise<SubAgentTextResult> {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: 'context-agent',
  });
  const contextSearchTool = legacyTools.contextSearch;
  if (!contextSearchTool) {
    return {
      text: 'Context search is not available for this user.',
      toolResults: [],
      pendingApproval: null,
    };
  }

  return runSubAgent({
    label: 'retrieval specialist',
    prompt: buildSubAgentPrompt(
      'retrieval specialist',
      'Search for what is asked and return a clear summary of what you found. If nothing found, say so.',
    ),
    message: buildSubAgentUserMessage(params.objective, {
      webSearch: params.webSearch,
      contactSearch: params.contactSearch,
    }),
    tools: {
      contextSearch: tool({
        description: 'Search memory, files, contacts, or the web.',
        inputSchema: z.object({
          query: z.string(),
          operation: z.enum(['search', 'fetch']),
          sources: z.object({
            web: z.boolean().optional(),
            larkContacts: z.boolean().optional(),
            personalHistory: z.boolean().optional(),
            files: z.boolean().optional(),
          }).optional(),
          limit: z.number().optional(),
          chunkRef: z.string().optional(),
        }),
        execute: async ({ query, operation, sources, limit, chunkRef }) =>
          contextSearchTool.execute({
            query,
            operation,
            sources,
            limit,
            ...(chunkRef ? { chunkRef } : {}),
          }),
      }),
    },
    runtime,
    abortSignal,
    onStepFinish,
  });
}

async function runGoogleWorkspaceAgent(
  params: { objective: string; recipientEmail?: string; subject?: string; body?: string },
  runtime: VercelRuntimeRequestContext,
  abortSignal?: AbortSignal,
  onStepFinish?: (step: unknown) => Promise<void>,
): Promise<SubAgentTextResult> {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: 'google-workspace-agent',
  });
  const googleWorkspaceTool = legacyTools.googleWorkspace;
  if (!googleWorkspaceTool) {
    return {
      text: 'Google Workspace tools are not available for this user.',
      toolResults: [],
      pendingApproval: null,
    };
  }

  return runSubAgent({
    label: 'Google Workspace specialist',
    prompt: buildSubAgentPrompt(
      'Google Workspace specialist',
      'Complete the objective using your tools. If a tool fails, read the error and fix your input. Return what happened clearly.',
    ),
    message: buildSubAgentUserMessage(params.objective, {
      recipientEmail: params.recipientEmail,
      subject: params.subject,
      body: params.body,
    }),
    tools: {
      sendEmail: tool({
        description: 'Send an email.',
        inputSchema: z.object({
          to: z.string(),
          subject: z.string(),
          body: z.string(),
          cc: z.string().optional(),
        }),
        execute: async ({ to, subject, body, cc }) =>
          googleWorkspaceTool.execute({
            operation: 'sendMessage',
            to,
            subject,
            body,
            ...(cc ? { cc } : {}),
          }),
      }),
      searchEmail: tool({
        description: 'Search Gmail messages.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) =>
          googleWorkspaceTool.execute({
            operation: 'searchMessages',
            query,
          }),
      }),
      createDraft: tool({
        description: 'Create an email draft.',
        inputSchema: z.object({
          to: z.string(),
          subject: z.string(),
          body: z.string(),
        }),
        execute: async ({ to, subject, body }) =>
          googleWorkspaceTool.execute({
            operation: 'createDraft',
            to,
            subject,
            body,
          }),
      }),
    },
    runtime,
    abortSignal,
    onStepFinish,
  });
}

async function runZohoAgent(
  objective: string,
  runtime: VercelRuntimeRequestContext,
  abortSignal?: AbortSignal,
  onStepFinish?: (step: unknown) => Promise<void>,
): Promise<SubAgentTextResult> {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: 'zoho-ops-agent',
  });
  const zohoBooksTool = legacyTools.zohoBooks;
  const zohoCrmTool = legacyTools.zohoCrm;
  if (!zohoBooksTool && !zohoCrmTool) {
    return {
      text: 'Zoho tools are not available for this user.',
      toolResults: [],
      pendingApproval: null,
    };
  }

  const tools: Record<string, ReturnType<typeof tool>> = {};
  if (zohoBooksTool) {
    tools.readBooks = tool({
      description: 'Read Zoho Books data or build overdue reports.',
      inputSchema: z.object({
        operation: z.enum(['listRecords', 'getRecord', 'buildOverdueReport', 'getReport']),
        recordType: z.string().optional(),
        filters: z.record(z.string()).optional(),
        recordId: z.string().optional(),
        reportName: z.string().optional(),
      }),
      execute: async ({ operation, recordType, filters, recordId, reportName }) =>
        zohoBooksTool.execute({
          operation: operation === 'buildOverdueReport' ? 'buildOverdueReport' : 'read',
          ...(recordType ? { module: recordType } : {}),
          ...(filters ? { filters } : {}),
          ...(recordId ? { recordId } : {}),
          ...(reportName ? { reportName } : {}),
          ...(operation === 'getRecord' ? { readOperation: 'getRecord' } : {}),
          ...(operation === 'listRecords' ? { readOperation: 'listRecords' } : {}),
          ...(operation === 'getReport' ? { readOperation: 'getReport' } : {}),
        }),
    });
  }
  if (zohoCrmTool) {
    tools.readCRM = tool({
      description: 'Read Zoho CRM data.',
      inputSchema: z.object({
        operation: z.enum(['search', 'read']),
        module: z.string().optional(),
        query: z.string().optional(),
        recordId: z.string().optional(),
        filters: z.record(z.string()).optional(),
      }),
      execute: async ({ operation, module, query, recordId, filters }) =>
        zohoCrmTool.execute({
          operation,
          ...(module ? { module } : {}),
          ...(query ? { query } : {}),
          ...(recordId ? { recordId } : {}),
          ...(filters ? { filters } : {}),
        }),
    });
  }

  return runSubAgent({
    label: 'Zoho specialist',
    prompt: buildSubAgentPrompt(
      'Zoho specialist',
      'Fetch or update Zoho data as asked. Return a clear summary of what you found or did.',
    ),
    message: buildSubAgentUserMessage(objective),
    tools,
    runtime,
    abortSignal,
    onStepFinish,
  });
}

async function runLarkAgent(
  params: { objective: string; assignee?: string },
  runtime: VercelRuntimeRequestContext,
  abortSignal?: AbortSignal,
  onStepFinish?: (step: unknown) => Promise<void>,
): Promise<SubAgentTextResult> {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: 'lark-ops-agent',
  });
  const larkTaskTool = legacyTools.larkTask;
  const larkMessageTool = legacyTools.larkMessage;
  if (!larkTaskTool && !larkMessageTool) {
    return {
      text: 'Lark tools are not available for this user.',
      toolResults: [],
      pendingApproval: null,
    };
  }

  const tools: Record<string, ReturnType<typeof tool>> = {};
  if (larkTaskTool) {
    tools.createTask = tool({
      description: 'Create a Lark task.',
      inputSchema: z.object({
        summary: z.string(),
        assigneeOpenId: z.string().optional(),
        dueDate: z.string().optional(),
      }),
      execute: async ({ summary, assigneeOpenId, dueDate }) =>
        larkTaskTool.execute({
          operation: 'write',
          taskOperation: 'create',
          summary,
          ...(assigneeOpenId
            ? { assigneeMode: 'canonical_ids', assigneeIds: [assigneeOpenId] }
            : {}),
          ...(dueDate ? { dueTs: dueDate } : {}),
        }),
    });
  }
  if (larkMessageTool) {
    tools.sendMessage = tool({
      description: 'Send a Lark DM.',
      inputSchema: z.object({
        message: z.string(),
        recipientOpenId: z.string().optional(),
        recipientName: z.string().optional(),
      }),
      execute: async ({ message, recipientOpenId, recipientName }) =>
        larkMessageTool.execute({
          operation: 'sendDm',
          message,
          ...(recipientOpenId ? { recipientOpenIds: [recipientOpenId] } : {}),
          ...(recipientName ? { recipientNames: [recipientName] } : {}),
        }),
    });
  }

  return runSubAgent({
    label: 'Lark specialist',
    prompt: buildSubAgentPrompt(
      'Lark specialist',
      'Complete Lark actions as asked. Return what you did clearly.',
    ),
    message: buildSubAgentUserMessage(params.objective, {
      assignee: params.assignee,
    }),
    tools,
    runtime,
    abortSignal,
    onStepFinish,
  });
}

const extractSupervisorToolOutputs = (steps: unknown): Array<Record<string, unknown>> => {
  const outputs: Array<Record<string, unknown>> = [];
  for (const step of asArray(steps)) {
    const stepRecord = asRecord(step);
    for (const toolResult of asArray(stepRecord?.toolResults)) {
      const output = asRecord(asRecord(toolResult)?.output);
      if (output) {
        outputs.push(output);
      }
    }
  }
  return outputs;
};

const extractNestedToolResults = (steps: unknown): VercelToolEnvelope[] => {
  const flattened: VercelToolEnvelope[] = [];
  for (const output of extractSupervisorToolOutputs(steps)) {
    for (const entry of asArray(output.toolResults)) {
      const record = asRecord(entry);
      const success = asBoolean(record?.success);
      const summary = asString(record?.summary);
      const toolId = asString(record?.toolId);
      const status = asString(record?.status);
      if (success === undefined || !summary || !toolId || !status) {
        continue;
      }
      flattened.push(record as VercelToolEnvelope);
    }
  }
  return flattened;
};

const extractNestedPendingApproval = (steps: unknown): PendingApprovalAction | null => {
  for (const output of extractSupervisorToolOutputs(steps)) {
    const pending = asRecord(output.pendingApproval);
    if (pending) {
      return pending as PendingApprovalAction;
    }
    for (const entry of asArray(output.toolResults)) {
      const toolResult = asRecord(entry) as VercelToolEnvelope | undefined;
      if (toolResult?.pendingApprovalAction) {
        return toolResult.pendingApprovalAction;
      }
    }
  }
  return null;
};

const buildStepProgressText = (step: unknown): string => {
  const stepRecord = asRecord(step);
  const toolCalls = asArray(stepRecord?.toolCalls)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const toolResults = asArray(stepRecord?.toolResults)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const called = toolCalls.map((entry) => asString(entry.toolName)).filter((entry): entry is string => Boolean(entry));
  const summaries = toolResults
    .map((entry) => asString(asRecord(entry.output)?.text) ?? asString(asRecord(entry.output)?.summary))
    .filter((entry): entry is string => Boolean(entry));
  if (summaries.length > 0) {
    return summarizeText(summaries.join(' | '), 220);
  }
  if (called.length > 0) {
    return `Used ${called.join(', ')}.`;
  }
  return summarizeText(asString(stepRecord?.text), 220) || 'Working on the request.';
};

const buildAgentStartStatus = (label: string, objective: string): string =>
  `I understand the request. Now I am using ${label} for: ${summarizeText(stripMarkdownDecorators(objective), 180)}`;

const buildAgentStepStatus = (label: string, step: unknown): string => {
  const stepRecord = asRecord(step);
  const toolCalls = asArray(stepRecord?.toolCalls)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const toolResults = asArray(stepRecord?.toolResults)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));

  const callNames = toolCalls
    .map((entry) => asString(entry.toolName))
    .filter((entry): entry is string => Boolean(entry));
  const resultSummaries = toolResults
    .map((entry) => {
      const output = asRecord(entry.output);
      return asString(output?.summary) ?? asString(output?.text);
    })
    .filter((entry): entry is string => Boolean(entry));

  if (resultSummaries.length > 0) {
    return `I got a result from ${label}: ${summarizeText(stripMarkdownDecorators(resultSummaries.join(' | ')), 200)}`;
  }
  if (callNames.length > 0) {
    return `I am working with ${label} using ${callNames.join(', ')}.`;
  }
  return `I am still working with ${label}.`;
};

const buildAgentFinishStatus = (label: string, result: SubAgentTextResult): string => {
  if (result.pendingApproval) {
    return `I prepared the ${label} action and it now needs approval.`;
  }
  return `I got what I needed from ${label}. Now I am preparing the next step.`;
};

const toSupervisorAgentResults = (toolResults: VercelToolEnvelope[], taskId: string): AgentResultDTO[] => {
  if (toolResults.length === 0) {
    return [];
  }
  return toolResults.map((toolResult) => ({
    taskId,
    agentKey: toolResult.toolId,
    status: toolResult.success ? 'success' : toolResult.pendingApprovalAction ? 'hitl_paused' : 'failed',
    message: toolResult.summary,
    result: toolResult.keyData,
    ...(toolResult.error
      ? {
          error: {
            type: 'TOOL_ERROR',
            classifiedReason: toolResult.errorKind ?? 'tool_error',
            rawMessage: toolResult.error,
            retriable: Boolean(toolResult.retryable),
          },
        }
      : {}),
  }));
};

const executeTask = async (
  input: OrchestrationExecutionInput,
): Promise<SupervisorV2ExecutionOutput> => {
  const { task, message, abortSignal } = input;
  const executionId = resolveCanonicalExecutionId(task, message);
  const adapter = message.channel === 'lark' ? resolveChannelAdapter('lark') : null;
  let statusCoordinator: LarkStatusCoordinator | null = null;

  try {
    const conversation = await resolveConversationContext(input);
    const contextStorageId = conversation.persistentThreadId ?? conversation.sharedChatContextId;
    const runtime = await resolveRuntimeContext(task, message, contextStorageId);
    const resolvedModel = await resolveVercelLanguageModel(runtime.mode);

    if (adapter && message.channel === 'lark') {
      statusCoordinator = new LarkStatusCoordinator({
        adapter,
        chatId: message.chatId,
        correlationId: task.taskId,
        initialStatusMessageId: message.trace?.statusMessageId ?? message.trace?.ackMessageId,
        replyToMessageId: message.trace?.replyToMessageId ?? message.messageId,
        replyInThread: message.chatType === 'group',
      });
      await statusCoordinator.update({
        text: 'Planning the next action.',
        actions: [],
      }, { force: true });
      statusCoordinator.startHeartbeat(() => ({
        text: 'Execution complete. Preparing the final response.',
        actions: [],
      }));
    }

    const updateLiveStatus = async (text: string): Promise<void> => {
      if (!statusCoordinator) {
        return;
      }
      await statusCoordinator.update({
        text,
        actions: [],
      });
    };

    const supervisorTools = {
      contextAgent: tool({
        description:
          'Search for contacts, web information, documents, conversation history. Use when you need to find information before acting.',
        inputSchema: z.object({
          objective: z.string().describe('What you need found or retrieved'),
          webSearch: z.boolean().optional().describe('Include web results'),
          contactSearch: z.boolean().optional().describe('Search for contact details'),
        }),
        execute: async ({ objective, webSearch, contactSearch }) => {
          await updateLiveStatus(buildAgentStartStatus('context', objective));
          const result = await runContextAgent(
            { objective, webSearch, contactSearch },
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('context', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('context', result));
          return result;
        },
      }),
      googleWorkspaceAgent: tool({
        description:
          'Send emails, search Gmail, create drafts, manage calendar. Use when you need to send email or access Google services. Email sending requires human approval.',
        inputSchema: z.object({
          objective: z.string().describe('What Google action to perform'),
          recipientEmail: z.string().optional(),
          subject: z.string().optional(),
          body: z.string().optional(),
        }),
        execute: async (params) => {
          await updateLiveStatus(buildAgentStartStatus('Google Workspace', params.objective));
          const result = await runGoogleWorkspaceAgent(
            params,
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Google Workspace', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Google Workspace', result));
          return result;
        },
      }),
      zohoAgent: tool({
        description:
          'Read invoices, payments, overdue reports, CRM records from Zoho. Use when you need financial or CRM data.',
        inputSchema: z.object({
          objective: z.string().describe('What Zoho data to fetch or action to perform'),
        }),
        execute: async ({ objective }) => {
          await updateLiveStatus(buildAgentStartStatus('Zoho', objective));
          const result = await runZohoAgent(
            objective,
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Zoho', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Zoho', result));
          return result;
        },
      }),
      larkAgent: tool({
        description:
          'Create tasks, send Lark messages, manage calendar in Lark. Use for internal team actions in Lark.',
        inputSchema: z.object({
          objective: z.string().describe('What Lark action to perform'),
          assignee: z.string().optional().describe('Who to assign task to'),
        }),
        execute: async (params) => {
          await updateLiveStatus(buildAgentStartStatus('Lark', params.objective));
          const result = await runLarkAgent(
            params,
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Lark', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Lark', result));
          return result;
        },
      }),
    };

    const supervisorResult = await generateText({
      model: resolvedModel.model,
      system: buildSupervisorSystemPrompt(runtime),
      messages: [
        ...conversation.recentTurns,
        { role: 'user', content: message.text },
      ],
      tools: supervisorTools,
      temperature: 0,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: resolvedModel.includeThoughts,
            thinkingLevel: resolvedModel.thinkingLevel,
          },
        },
      },
      stopWhen: stepCountIs(10),
      abortSignal,
      onStepFinish: async (step) => {
        const stepRecord = asRecord(step) ?? {};
        const toolCalls = asArray(stepRecord.toolCalls)
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry));
        const toolResults = asArray(stepRecord.toolResults)
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry));
        const usage = asRecord(stepRecord.usage);
        await appendExecutionEventSafe({
          executionId,
          phase: 'tools',
          eventType: 'agent.step.io',
          actorType: 'agent',
          actorKey: 'supervisor',
          title: 'Supervisor step',
          status: 'done',
          payload: {
            input: {
              toolCallsMade: toolCalls.map((toolCall) => ({
                tool: asString(toolCall.toolName) ?? 'unknown',
                args: asRecord(toolCall.input) ?? {},
              })),
            },
            output: {
              toolResults: toolResults.map((toolResult) => {
                const output = asRecord(toolResult.output);
                return {
                  tool: asString(toolResult.toolName) ?? 'unknown',
                  success: asBoolean(output?.success) ?? true,
                  summary:
                    asString(output?.text)
                    ?? asString(output?.summary)
                    ?? summarizeText(JSON.stringify(output ?? {}), 180),
                  error: asString(output?.error) ?? null,
                };
              }),
              text: summarizeText(asString(stepRecord.text), 300),
            },
            processing: {
              inputTokens: asNumber(usage?.inputTokens) ?? 0,
              outputTokens: asNumber(usage?.outputTokens) ?? 0,
            },
          },
        });

        if (statusCoordinator) {
          await statusCoordinator.update({
            text: buildStepProgressText(step),
            actions: [],
          });
        }
      },
    });

    const toolResults = extractNestedToolResults(supervisorResult.steps);
    const pendingApproval =
      extractNestedPendingApproval(supervisorResult.steps) ?? extractPendingApproval(toolResults);
    const finalText =
      formatFinalTextForLark(
        supervisorResult.text
        || toolResults.map((entry) => entry.summary).filter(Boolean).join('\n')
        || 'Completed the request.',
        toolResults,
        pendingApproval,
      )
      ;
    const hasToolResults =
      toolResults.length > 0
      || asArray(supervisorResult.steps).some((step) => asArray(asRecord(step)?.toolCalls).length > 0);
    const statusMessageId = statusCoordinator?.getStatusMessageId();
    const agentResults = toSupervisorAgentResults(toolResults, task.taskId);

    return {
      task,
      status: pendingApproval ? 'hitl' : 'done',
      currentStep: 'supervisor_v2.complete',
      latestSynthesis: finalText,
      agentResults,
      hitlAction: buildHitlAction(task, pendingApproval, runtime.channel),
      runtimeMeta: {
        engine: 'vercel',
        threadId: runtime.threadId,
        node: 'supervisor_v2',
        stepHistory: ['supervisor_v2.executeTask'],
        routeIntent: runtime.canonicalIntent
          ? `${runtime.canonicalIntent.domain}:${runtime.canonicalIntent.operationClass}`
          : undefined,
        canonicalIntent: runtime.canonicalIntent,
        supervisorWaveCount: asArray(supervisorResult.steps).length,
      },
      finalText,
      toolResults,
      pendingApproval,
      statusMessageId,
      hasToolResults,
      isSensitiveContent: false,
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Supervisor v2 execution failed.';
    await appendExecutionEventSafe({
      executionId,
      phase: 'tools',
      eventType: 'supervisor_v2.failed',
      actorType: 'system',
      actorKey: 'supervisor',
      title: 'Supervisor v2 failed',
      summary: summarizeText(messageText, 300),
      status: 'failed',
      payload: {
        error: messageText,
      },
    });
    return {
      task,
      status: 'failed',
      currentStep: 'supervisor_v2.failed',
      latestSynthesis: messageText,
      errors: [
        {
          type: 'MODEL_ERROR',
          classifiedReason: 'supervisor_v2_execution_failed',
          rawMessage: messageText,
          retriable: false,
        },
      ],
      runtimeMeta: {
        engine: 'vercel',
        node: 'supervisor_v2',
        stepHistory: ['supervisor_v2.executeTask'],
      },
      finalText: messageText,
      toolResults: [],
      pendingApproval: null,
      statusMessageId: statusCoordinator?.getStatusMessageId(),
      hasToolResults: false,
      isSensitiveContent: false,
    };
  } finally {
    await statusCoordinator?.close();
  }
};

export const supervisorV2Engine = { executeTask };
