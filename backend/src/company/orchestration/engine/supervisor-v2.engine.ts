import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

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
import { redDebug } from '../../../utils/red-debug';

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

const LARK_FORMAT_RULES = `
FORMATTING RULES (Lark chat — follow exactly):
- Use **bold** for emphasis and labels
- Use bullet points (- item) for lists
- For data tables: use | Col1 | Col2 | Col3 | format with a header separator row
- Do NOT use ### or ## headings — use **Bold Label:** instead
- Do NOT use # heading — use **Title** on its own line instead
- Keep responses concise — no filler text
- Numbers and amounts: use commas for thousands (42,495,664.40)
`.trim();

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
  const preferredTools = [
    'contextSearch',
    'googleWorkspace',
    'zohoBooks',
    'zohoCrm',
    'larkTask',
    'larkMessage',
    'lark-calendar-agent',
    'lark-meeting-agent',
    'lark-doc-agent',
    'lark-base-agent',
  ];
  const entries = preferredTools.flatMap((toolId) => {
    const actions = runtime.allowedActionsByTool?.[toolId];
    if (!actions?.length) {
      return [];
    }
    return [`${toolId}:${actions.join('/')}`];
  });
  return entries.length > 0 ? entries.join(', ') : 'Use only tools permitted by the runtime.';
};

export const buildSupervisorSystemPrompt = (runtime: VercelRuntimeRequestContext): string => {
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
    '- larkAgent: read or create Lark tasks, messages, calendar events, meetings, docs, and Base records.',
    'Rules:',
    '1. Only act on the latest user message.',
    '2. Prior conversation shows completed work and context. Never redo completed actions unless the latest message clearly asks for it.',
    '3. If an agent returns an error, read it, fix the objective or arguments, and retry.',
    '4. Be concise in the final response.',
    '5. Never hallucinate tool names. Use only the 4 agents listed above.',
    '6. If you send, draft, or prepare a message, say what was sent or prepared with recipient plus a short content preview, not only that it happened.',
    '7. Treat earlier messages as non-actionable background unless the latest user message explicitly refers to them.',
    '8. Do not continue, resume, or elaborate on any earlier request unless the latest user message clearly asks you to do that.',
    '9. If the latest user message is a new request, ignore unfinished-looking prior context.',
    '10. Never infer that a previous request is incomplete from conversation history alone.',
    '11. Rendered UI truncation is not evidence of incomplete work.',
    '12. Do not combine multiple requests into one answer unless the latest user message explicitly asks for both.',
    'COMMON PATTERNS — follow these exactly:',
    "Contact/people lookup (anytime user asks for someone's email, phone, details):",
    '  → call contextAgent with contactSearch: true',
    '  → objective should list all names being searched',
    '  → Example: "find email for Vijay Sir, Anish, Dushayant"',
    '    calls: contextAgent({ objective: "find contact details for Vijay, Anish, Dushayant", contactSearch: true })',
    'Financial/invoice data (overdue, payments, reports):',
    '  → call zohoAgent directly, never contextAgent',
    '  → Example: "overdue invoices this year with invoice numbers"',
    '    calls: zohoAgent({ objective: "get all overdue invoices for 2026 with invoice numbers and balances" })',
    'Web research (latest news, external information):',
    '  → call contextAgent with webSearch: true',
    '  → Example: "search best AI platforms 2026"',
    '    calls: contextAgent({ objective: "search best AI platforms 2026", webSearch: true })',
    'Send email:',
    '  → call googleWorkspaceAgent directly',
    '  → always include recipientEmail, subject, body if known',
    '  → Example: "send findings to anish"',
    '    calls: googleWorkspaceAgent({ objective: "send email with findings", recipientEmail: "anishsuman2305@gmail.com", subject: "Research Findings", body: "..." })',
    'Lark tasks, calendar, meetings, or docs:',
    '  → call larkAgent directly',
    '  → use task/calendar/meeting/doc operations instead of contextAgent when the user wants current Lark data or Lark updates',
    '  → Example: "show my open Lark tasks"',
    '    calls: larkAgent({ objective: "list my open Lark tasks" })',
    '  → Example: "what meetings do I have today in Lark"',
    '    calls: larkAgent({ objective: "list meetings and calendar events for today in Lark" })',
    '  → Example: "create a Lark doc with the summary"',
    '    calls: larkAgent({ objective: "create a Lark doc containing the summary" })',
    `Permissions summary: ${buildPermissionSummary(runtime)}.`,
    'FORMATTING: Use **bold** for emphasis. Use - for bullet lists. For data: use | Col | Col | table format. Never use ### or ## headings — use **Bold:** instead. Be concise and direct.',
  ].join('\n');
};

const buildSubAgentPrompt = (label: string, guidance: string): string =>
  `You are a ${label}. ${guidance}\n\n${LARK_FORMAT_RULES}`.trim();

const buildContextAgentPrompt = (): string => [
  'You are a retrieval specialist.',
  'Use contextSearch carefully and choose arguments that match the retrieval task.',
  'Always search first. Use fetch only when you already have a chunkRef and need the full content.',
  'Return a clear summary of what you found. If nothing relevant is found, say that clearly.',
  'Prefer the narrowest useful retrieval shape, but do not drop an important source when the request clearly needs it.',
  'PATTERNS:',
  '1. Contact lookup:',
  '   - Use when the user asks for email, phone, contact details, recipient details, or who someone is.',
  '   - Query should list the names cleanly.',
  '   - Keep larkContacts=true.',
  '   - Usually keep zohoCrmContext=true too.',
  '   - Example: contextSearch({ operation: "search", query: "find contact details for Vijay, Anish, Dushayant", sources: { larkContacts: true, zohoCrmContext: true, personalHistory: true, files: true, web: false }, limit: 8 })',
  '2. Conversation/history recall:',
  '   - Use when the user asks what we discussed earlier, previous attempt, last draft, past message, prior decision, or something from this thread.',
  '   - Keep personalHistory=true.',
  '   - Example: contextSearch({ operation: "search", query: "what did we decide earlier about the invoice follow-up", sources: { personalHistory: true, files: false, larkContacts: false, zohoCrmContext: false, web: false }, limit: 5 })',
  '3. Document or file lookup:',
  '   - Use when the user asks for information from documents, uploaded files, notes, or internal file content.',
  '   - Keep files=true.',
  '   - Example: contextSearch({ operation: "search", query: "find the pricing terms in the uploaded contract", sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false, web: false }, limit: 5 })',
  '4. CRM or business-record lookup:',
  '   - Use when the user wants company/contact/business info that may exist in CRM context.',
  '   - Keep zohoCrmContext=true.',
  '   - Example: contextSearch({ operation: "search", query: "find CRM details for Puretech Internet Private Limited", sources: { zohoCrmContext: true, larkContacts: false, personalHistory: false, files: false, web: false }, limit: 5 })',
  '5. Web research:',
  '   - Use when the user asks for latest public information, news, external research, or web findings.',
  '   - Keep web=true.',
  '   - Example: contextSearch({ operation: "search", query: "best AI platforms in 2026", sources: { web: true, personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false }, limit: 5 })',
  '6. Mixed lookup:',
  '   - If the request combines contact lookup plus prior context, keep both larkContacts and personalHistory enabled.',
  '   - Example: contextSearch({ operation: "search", query: "find Anish contact details and the email draft we discussed earlier", sources: { larkContacts: true, personalHistory: true, files: true, zohoCrmContext: true, web: false }, limit: 8 })',
  'If you search and get no useful result, explain what sources were checked and what was still missing.',
].join('\n');

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
    prompt: buildContextAgentPrompt(),
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
            zohoCrmContext: z.boolean().optional(),
            skills: z.boolean().optional(),
          }).optional(),
          limit: z.number().optional(),
          chunkRef: z.string().optional(),
        }),
        execute: async ({ query, operation, sources, limit, chunkRef }) =>
          (async () => {
            const effectivePayload = {
              query,
              operation,
              sources: {
                web: sources?.web ?? (params.webSearch ?? false),
                larkContacts: sources?.larkContacts ?? (params.contactSearch ?? true),
                personalHistory: sources?.personalHistory ?? true,
                files: sources?.files ?? true,
                zohoCrmContext: sources?.zohoCrmContext ?? true,
                skills: false,
              },
              scopes: ['all'] as const,
              limit: limit ?? 8,
              ...(chunkRef ? { chunkRef } : {}),
            };
            redDebug('supervisor_v2.context_agent.context_search.execute', {
              objective: params.objective,
              contactSearch: params.contactSearch ?? null,
              webSearch: params.webSearch ?? null,
              rawToolArgs: {
                query,
                operation,
                sources: sources ?? null,
                limit: limit ?? null,
                chunkRef: chunkRef ?? null,
              },
              effectivePayload,
            });
            return contextSearchTool.execute(effectivePayload);
          })(),
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
  const larkCalendarTool = legacyTools.larkCalendar;
  const larkMeetingTool = legacyTools.larkMeeting;
  const larkDocTool = legacyTools.larkDoc;
  if (!larkTaskTool && !larkMessageTool && !larkCalendarTool && !larkMeetingTool && !larkDocTool) {
    return {
      text: 'Lark tools are not available for this user.',
      toolResults: [],
      pendingApproval: null,
    };
  }

  const tools: Record<string, ReturnType<typeof tool>> = {};
  if (larkTaskTool) {
    tools.task = tool({
      description: 'List, read, create, update, assign, complete, or delete Lark tasks.',
      inputSchema: z.object({
        operation: z.enum([
          'list',
          'listMine',
          'listOpenMine',
          'get',
          'current',
          'listTasklists',
          'listAssignableUsers',
          'create',
          'update',
          'delete',
          'complete',
          'reassign',
          'assign',
        ]),
        taskId: z.string().optional(),
        tasklistId: z.string().optional(),
        query: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        dueTs: z.string().optional(),
        assigneeOpenId: z.string().optional(),
        assigneeName: z.string().optional(),
        assignToMe: z.boolean().optional(),
      }),
      execute: async ({
        operation,
        taskId,
        tasklistId,
        query,
        summary,
        description,
        dueTs,
        assigneeOpenId,
        assigneeName,
        assignToMe,
      }) =>
        larkTaskTool.execute({
          operation,
          ...(taskId ? { taskId } : {}),
          ...(tasklistId ? { tasklistId } : {}),
          ...(query ? { query } : {}),
          ...(summary ? { summary } : {}),
          ...(description ? { description } : {}),
          ...(dueTs ? { dueTs } : {}),
          ...(assigneeOpenId
            ? { assigneeMode: 'canonical_ids', assigneeIds: [assigneeOpenId] }
            : {}),
          ...(assigneeName
            ? { assigneeMode: 'named_people', assigneeNames: [assigneeName] }
            : {}),
          ...(assignToMe !== undefined ? { assignToMe } : {}),
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
  if (larkCalendarTool) {
    tools.calendar = tool({
      description: 'List calendars, list events, inspect event details, check availability, or schedule/update/delete Lark calendar events.',
      inputSchema: z.object({
        operation: z.enum([
          'listCalendars',
          'listEvents',
          'getEvent',
          'createEvent',
          'updateEvent',
          'deleteEvent',
          'listAvailability',
          'scheduleMeeting',
        ]),
        calendarId: z.string().optional(),
        calendarName: z.string().optional(),
        eventId: z.string().optional(),
        dateScope: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        searchStartTime: z.string().optional(),
        searchEndTime: z.string().optional(),
        durationMinutes: z.number().int().positive().max(1440).optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        attendeeName: z.string().optional(),
        attendeeNames: z.array(z.string()).optional(),
        includeMe: z.boolean().optional(),
        needNotification: z.boolean().optional(),
      }),
      execute: async ({
        operation,
        calendarId,
        calendarName,
        eventId,
        dateScope,
        startTime,
        endTime,
        searchStartTime,
        searchEndTime,
        durationMinutes,
        summary,
        description,
        attendeeName,
        attendeeNames,
        includeMe,
        needNotification,
      }) =>
        larkCalendarTool.execute({
          operation,
          ...(calendarId ? { calendarId } : {}),
          ...(calendarName ? { calendarName } : {}),
          ...(eventId ? { eventId } : {}),
          ...(dateScope ? { dateScope } : {}),
          ...(startTime ? { startTime } : {}),
          ...(endTime ? { endTime } : {}),
          ...(searchStartTime ? { searchStartTime } : {}),
          ...(searchEndTime ? { searchEndTime } : {}),
          ...(durationMinutes ? { durationMinutes } : {}),
          ...(summary ? { summary } : {}),
          ...(description ? { description } : {}),
          ...((attendeeNames?.length || attendeeName)
            ? { attendeeNames: attendeeNames?.length ? attendeeNames : [attendeeName as string] }
            : {}),
          ...(includeMe !== undefined ? { includeMe } : {}),
          ...(needNotification !== undefined ? { needNotification } : {}),
        }),
    });
  }
  if (larkMeetingTool) {
    tools.meeting = tool({
      description: 'List or inspect Lark meetings and minutes.',
      inputSchema: z.object({
        operation: z.enum(['list', 'get', 'getMinute']),
        meetingId: z.string().optional(),
        meetingNo: z.string().optional(),
        minuteToken: z.string().optional(),
        query: z.string().optional(),
        dateScope: z.string().optional(),
      }),
      execute: async ({ operation, meetingId, meetingNo, minuteToken, query, dateScope }) =>
        larkMeetingTool.execute({
          operation,
          ...(meetingId ? { meetingId } : {}),
          ...(meetingNo ? { meetingNo } : {}),
          ...(minuteToken ? { minuteToken } : {}),
          ...(query ? { query } : {}),
          ...(dateScope ? { dateScope } : {}),
        }),
    });
  }
  if (larkDocTool) {
    tools.doc = tool({
      description: 'Create, edit, read, or inspect a Lark doc using markdown.',
      inputSchema: z.object({
        operation: z.enum(['create', 'edit', 'read', 'inspect']),
        documentId: z.string().optional(),
        title: z.string().optional(),
        markdown: z.string().optional(),
        instruction: z.string().optional(),
        strategy: z.enum(['replace', 'append', 'patch', 'delete']).optional(),
        query: z.string().optional(),
      }),
      execute: async ({ operation, documentId, title, markdown, instruction, strategy, query }) =>
        larkDocTool.execute({
          operation,
          ...(documentId ? { documentId } : {}),
          ...(title ? { title } : {}),
          ...(markdown ? { markdown } : {}),
          ...(instruction ? { instruction } : {}),
          ...(strategy ? { strategy } : {}),
          ...(query ? { query } : {}),
        }),
    });
  }

  return runSubAgent({
    label: 'Lark specialist',
    prompt: buildSubAgentPrompt(
      'Lark specialist',
      'Complete Lark actions as asked. You can read or update Lark tasks, messages, calendars, meetings, and docs. Use markdown when creating or editing Lark docs. Return what you did clearly.',
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

  try {
    const conversation = await resolveConversationContext(input);
    const contextStorageId = conversation.persistentThreadId ?? conversation.sharedChatContextId;
    const runtime = await resolveRuntimeContext(task, message, contextStorageId);
    const resolvedModel = await resolveVercelLanguageModel(runtime.mode);

    const updateLiveStatus = async (text: string): Promise<void> => {
      void text;
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
          'Read or update Lark tasks, messages, calendars, meetings, docs, and Base records. Use for internal team actions and current Lark data.',
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

        void step;
      },
    });

    const toolResults = extractNestedToolResults(supervisorResult.steps);
    const pendingApproval =
      extractNestedPendingApproval(supervisorResult.steps) ?? extractPendingApproval(toolResults);
    const rawText = supervisorResult.text?.trim()
      || toolResults.map((entry) => entry.summary).filter(Boolean).join('\n\n')
      || 'Completed the request.';
    const finalText = rawText.length > 50_000
      ? `${rawText.slice(0, 50_000)}\n\n*(Response truncated — showing first portion)*`
      : rawText;
    const hasToolResults =
      toolResults.length > 0
      || asArray(supervisorResult.steps).some((step) => asArray(asRecord(step)?.toolCalls).length > 0);
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
      hasToolResults: false,
      isSensitiveContent: false,
    };
  }
};

export const supervisorV2Engine = { executeTask };
