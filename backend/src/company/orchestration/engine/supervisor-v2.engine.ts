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
  calledToolNames: string[];
};

type WorkflowDomain = 'context' | 'google' | 'zoho' | 'lark';

type WorkflowId =
  | 'CONTACT_LOOKUP'
  | 'HISTORY_LOOKUP'
  | 'FILE_LOOKUP'
  | 'WEB_RESEARCH'
  | 'MIXED_LOOKUP'
  | 'SEND_EMAIL'
  | 'CREATE_DRAFT'
  | 'SEARCH_EMAIL'
  | 'BOOKS_READ'
  | 'CRM_READ'
  | 'OVERDUE_REPORT'
  | 'READ_TASKS'
  | 'CREATE_TASK'
  | 'READ_CALENDAR'
  | 'SCHEDULE_MEETING'
  | 'READ_MEETING_DETAILS'
  | 'CREATE_DOC'
  | 'EDIT_DOC'
  | 'SEND_DM';

type WorkflowConfidence = 'high' | 'medium' | 'low';

type WorkflowExecutionStatus =
  | 'SUCCESS'
  | 'MISSING_REQUIRED_FIELDS'
  | 'AMBIGUOUS_REQUEST'
  | 'MISROUTED_INTENT'
  | 'TOOLSET_INSUFFICIENT'
  | 'TOOL_EXECUTION_FAILED';

type ValidationFailureReason =
  | 'missing_required_tool_call'
  | 'wrong_object_type'
  | 'unsupported_claim_without_tool_evidence';

type ClassifierResult = {
  domain: WorkflowDomain;
  workflowId: WorkflowId;
  confidence: WorkflowConfidence;
  canExecuteNow: boolean;
  missingInputs: string[];
  reason: string;
};

type WorkflowExecutionResult = {
  domain: WorkflowDomain;
  workflowId: WorkflowId;
  status: WorkflowExecutionStatus;
  text: string;
  toolResults: VercelToolEnvelope[];
  pendingApproval: PendingApprovalAction | null;
  calledToolNames: string[];
  missingInputs: string[];
  reason?: string;
  rerouteReason?: string;
};

type WorkflowPromptSpec = {
  role: string;
  allowedTools: string[];
  whenToUse: string[];
  missingInputPolicy: string;
  examples: string[];
  negativeExamples: string[];
};

type WorkflowValidationResult =
  | { valid: true }
  | { valid: false; reason: ValidationFailureReason; detail: string };

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

const calledToolNamesFromSteps = (steps: unknown): string[] => {
  const names = new Set<string>();
  for (const step of asArray(steps)) {
    const stepRecord = asRecord(step);
    for (const toolCall of asArray(stepRecord?.toolCalls)) {
      const toolName = asString(asRecord(toolCall)?.toolName);
      if (toolName) {
        names.add(toolName);
      }
    }
  }
  return [...names];
};

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

const containsAny = (text: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => text.includes(pattern));

const containsRegex = (text: string, pattern: RegExp): boolean => pattern.test(text);

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const TIME_HINT_REGEX = /\b(now|today|tomorrow|tonight|\d{1,2}(:\d{2})?\s?(am|pm)|morning|afternoon|evening|ist)\b/i;
const WITH_PERSON_REGEX = /\b(with|to)\s+[a-z]/i;

const buildWorkflowPrompt = (spec: WorkflowPromptSpec, strictToolUse = false): string => [
  `Role: ${spec.role}`,
  `Allowed tools: ${spec.allowedTools.join(', ')}`,
  'When to use each tool:',
  ...spec.whenToUse.map((entry) => `- ${entry}`),
  `Missing-input policy: ${spec.missingInputPolicy}`,
  'Grounding rules:',
  '- Never claim a tool is unavailable, unsupported, or failed unless a real tool call returned that result.',
  '- Never answer an explicit action request without either calling the required tool or returning a structured missing-input/failure outcome.',
  '- Never substitute one object type for another: meeting is not task, doc is not task, email send is not draft.',
  '- Never use prior conversation as an active instruction source unless the latest user message explicitly refers to it.',
  strictToolUse
    ? '- This run is validator-enforced. You must use the relevant allowed tool before answering.'
    : '- If the relevant tool exists for the request, call it before answering.',
  'Failure rules:',
  '- If required fields are missing, respond with a clear request for those exact missing fields.',
  '- If the request does not match the workflow, say clearly that the request appears misrouted.',
  '- If a tool call fails, report the actual failure from the tool result rather than inventing a limitation.',
  'Examples:',
  ...spec.examples.map((entry) => `- ${entry}`),
  'Negative examples:',
  ...spec.negativeExamples.map((entry) => `- ${entry}`),
  LARK_FORMAT_RULES,
].join('\n');

const buildMissingInputsText = (workflowId: WorkflowId, missingInputs: string[]): string => {
  const label = workflowId.replace(/_/g, ' ').toLowerCase();
  return `I need the following to continue with ${label}: ${missingInputs.join(', ')}.`;
};

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
    '  → Example: "what events do I have today in Lark"',
    '    calls: larkAgent({ objective: "list calendar events for today in Lark" })',
    '  → Example: "schedule a meeting with Anish and Vijay tomorrow at 4 PM"',
    '    calls: larkAgent({ objective: "schedule a Lark meeting with Anish and Vijay tomorrow at 4 PM" })',
    '  → For meeting creation, the Lark specialist must use calendar.scheduleMeeting, not task.create.',
    '  → Example: "schedule a meeting for me now with Shivam and Archit"',
    '    calls: larkAgent({ objective: "schedule a Lark meeting with Shivam Bhateja and Archit now" })',
    '  → Example: "create a Lark doc with the summary"',
    '    calls: larkAgent({ objective: "create a Lark doc containing the summary" })',
    '  → If the user asks for a doc, document, page, notes page, markdown report, or written snapshot, that is a doc request, not a task request.',
    '  → Never create a task when the user explicitly asked for a Lark doc or document.',
    `Permissions summary: ${buildPermissionSummary(runtime)}.`,
    'FORMATTING: Use **bold** for emphasis. Use - for bullet lists. For data: use | Col | Col | table format. Never use ### or ## headings — use **Bold:** instead. Be concise and direct.',
  ].join('\n');
};

const buildSubAgentPrompt = (label: string, guidance: string): string =>
  `You are a ${label}. ${guidance} Do not claim a tool is unavailable, unsupported, or failed unless a tool call explicitly returned that result. If the user asked for an action and the relevant tool exists, call it before answering.\n\n${LARK_FORMAT_RULES}`.trim();

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
    toolChoice?: 'auto' | 'required' | { toolName: string };
    runtime: VercelRuntimeRequestContext;
    maxSteps?: number;
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
    toolChoice: input.toolChoice,
    temperature: 0,
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: resolvedModel.includeThoughts,
          thinkingLevel: resolvedModel.thinkingLevel,
        },
      },
    },
    stopWhen: stepCountIs(input.maxSteps ?? 3),
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
    calledToolNames: calledToolNamesFromSteps(result.steps),
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
      calledToolNames: [],
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
      calledToolNames: [],
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
      calledToolNames: [],
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
  const larkTaskReadOperations = new Set([
    'list',
    'listMine',
    'listOpenMine',
    'get',
    'current',
    'listTasklists',
    'listAssignableUsers',
  ]);
  if (!larkTaskTool && !larkMessageTool && !larkCalendarTool && !larkMeetingTool && !larkDocTool) {
    return {
      text: 'Lark tools are not available for this user.',
      toolResults: [],
      pendingApproval: null,
      calledToolNames: [],
    };
  }

  const tools: Record<string, ReturnType<typeof tool>> = {};
  if (larkTaskTool) {
    tools.task = tool({
      description: 'List, read, create, update, assign, complete, or delete Lark tasks. Use only for todos, follow-ups, reminders, and action items. Do not use this tool to create documents, notes, reports, markdown snapshots, calendar events, or meeting placeholders.',
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
          operation: larkTaskReadOperations.has(operation) ? 'read' : 'write',
          taskOperation: operation === 'assign' ? 'reassign' : operation,
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
      description: 'List calendars, list events, inspect event details, check availability, or schedule/update/delete Lark calendar events. Use this tool for meeting scheduling requests.',
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
      description: 'List or inspect Lark meetings and minutes. Do not use for day-scoped discovery like "today" or "tomorrow"; use calendar.listEvents for that.',
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
      description: 'Create, edit, read, or inspect a Lark doc using markdown. Use this for documents, notes, pages, summaries, reports, and markdown snapshots. If the user asks for a doc or document, use this tool instead of task creation.',
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
      [
        'Complete Lark actions as asked.',
        'You can read or update Lark tasks, messages, calendars, meetings, and docs.',
        'For current tasks, current meetings, today\'s calendar, or Lark docs, prefer your Lark tools over context search.',
        'Treat "doc", "document", "page", "markdown report", "notes", and "snapshot" as document requests. Use the doc tool for those.',
        'Tasks are only for action items, todos, reminders, or follow-ups. Never create a task when the user explicitly asked for a Lark doc or document.',
        'For requests like "my tasks", "active tasks", or "open tasks", use task.listOpenMine or task.listMine. Do not use listAssignableUsers unless the user is asking who can be assigned.',
        'For requests like "today\'s events", "calendar events", or "meetings today", use calendar.listEvents. Do not use meeting.list for day-scoped discovery, because the VC meetings API does not support date-scoped listing.',
        'For scheduling requests, use calendar scheduling operations and resolve attendees from teammate names. If attendee names are ambiguous or missing, surface the validation error clearly instead of guessing.',
        'Never create a task as a substitute for a meeting request. For "schedule/set up/book a meeting", call calendar.scheduleMeeting or return the validation error from that attempt.',
        'Use larkMeeting for specific meeting lookup, recent meeting inspection, or minutes. Use calendar operations for date-scoped events, availability, and scheduling.',
        'Examples: "schedule a meeting with Shivam and Archit now" -> calendar.scheduleMeeting. "show my meetings today" -> calendar.listEvents. "create a follow-up task for Vijay" -> task.create. "create a Lark doc with notes" -> doc.create.',
        'Examples: "book a meeting tomorrow at 4 PM with Anish" -> calendar.scheduleMeeting with attendeeNames and time. "who can I assign this task to?" -> task.listAssignableUsers.',
        'When asked to create a Lark doc, call doc.create with a title and markdown body. Do not store report content inside a task title or task summary.',
        'Use markdown when creating or editing Lark docs.',
        'Return what you found or changed clearly.',
      ].join(' '),
    ),
    message: buildSubAgentUserMessage(params.objective, {
      assignee: params.assignee,
    }),
    tools,
    runtime,
    maxSteps: 6,
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

const classifyWorkflow = (latestMessage: string): ClassifierResult => {
  const text = latestMessage.trim().toLowerCase();

  const meetingScheduleIntent =
    (containsAny(text, ['schedule a meeting', 'schedule meeting', 'book a meeting', 'set up a meeting', 'set up meeting'])
      || (containsAny(text, ['schedule', 'book', 'set up']) && text.includes('meeting')))
    && (containsRegex(text, WITH_PERSON_REGEX) || containsRegex(text, EMAIL_REGEX) || containsAny(text, ['anish', 'shivam', 'archit', 'vijay']));
  if (meetingScheduleIntent) {
    const missingInputs: string[] = [];
    if (!(containsRegex(text, WITH_PERSON_REGEX) || containsRegex(text, EMAIL_REGEX))) {
      missingInputs.push('attendee names or emails');
    }
    if (!containsRegex(text, TIME_HINT_REGEX)) {
      missingInputs.push('meeting time or date');
    }
    return {
      domain: 'lark',
      workflowId: 'SCHEDULE_MEETING',
      confidence: 'high',
      canExecuteNow: missingInputs.length === 0,
      missingInputs,
      reason: 'explicit Lark meeting scheduling intent',
    };
  }

  if ((containsAny(text, ['create a lark doc', 'create doc', 'create document', 'notes page', 'markdown report', 'snapshot'])
      || (containsAny(text, ['doc', 'document', 'page', 'notes', 'snapshot', 'report']) && containsAny(text, ['create', 'make', 'write'])))) {
    return {
      domain: 'lark',
      workflowId: containsAny(text, ['edit doc', 'update doc', 'append to doc']) ? 'EDIT_DOC' : 'CREATE_DOC',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit Lark doc intent',
    };
  }

  if (containsAny(text, ['active tasks', 'open tasks', 'my tasks', 'current active tasks'])) {
    return {
      domain: 'lark',
      workflowId: 'READ_TASKS',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit Lark task read intent',
    };
  }

  if ((containsAny(text, ['create task', 'create a task', 'todo', 'follow-up task', 'reminder']) && !containsAny(text, ['doc', 'document', 'page']))) {
    return {
      domain: 'lark',
      workflowId: 'CREATE_TASK',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit task creation intent',
    };
  }

  if (containsAny(text, ['calendar events', 'today’s calendar', "today's calendar", 'lark calendars', 'meetings today', 'events today'])) {
    return {
      domain: 'lark',
      workflowId: containsAny(text, ['minute', 'minutes', 'meeting details', 'recent meeting']) ? 'READ_MEETING_DETAILS' : 'READ_CALENDAR',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit calendar or meeting read intent',
    };
  }

  if (containsAny(text, ['message on lark', 'send dm', 'dm ', 'ping on lark'])) {
    const missingInputs: string[] = [];
    if (!containsRegex(text, WITH_PERSON_REGEX)) {
      missingInputs.push('recipient name');
    }
    return {
      domain: 'lark',
      workflowId: 'SEND_DM',
      confidence: 'medium',
      canExecuteNow: missingInputs.length === 0,
      missingInputs,
      reason: 'explicit Lark messaging intent',
    };
  }

  const sendEmailIntent = containsAny(text, ['send email', 'send an email', 'mail this', 'email this']);
  if (sendEmailIntent) {
    const missingInputs: string[] = [];
    if (!(containsRegex(text, EMAIL_REGEX) || containsRegex(text, WITH_PERSON_REGEX))) {
      missingInputs.push('recipient');
    }
    return {
      domain: 'google',
      workflowId: 'SEND_EMAIL',
      confidence: 'high',
      canExecuteNow: missingInputs.length === 0,
      missingInputs,
      reason: 'explicit send-email intent',
    };
  }

  if (containsAny(text, ['create draft', 'draft email', 'draft a mail'])) {
    return {
      domain: 'google',
      workflowId: 'CREATE_DRAFT',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit draft intent',
    };
  }

  if (containsAny(text, ['search gmail', 'search email', 'find email thread', 'find email in gmail', 'inbox'])) {
    return {
      domain: 'google',
      workflowId: 'SEARCH_EMAIL',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit Gmail search intent',
    };
  }

  if (containsAny(text, ['overdue invoice', 'overdue invoices', 'overdue report', 'review overdue'])) {
    return {
      domain: 'zoho',
      workflowId: 'OVERDUE_REPORT',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'explicit overdue invoice/report intent',
    };
  }

  if (containsAny(text, ['crm', 'lead', 'deal', 'contact in crm'])) {
    return {
      domain: 'zoho',
      workflowId: 'CRM_READ',
      confidence: 'medium',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'Zoho CRM read intent',
    };
  }

  if (containsAny(text, ['invoice', 'payment', 'zoho books', 'books record'])) {
    return {
      domain: 'zoho',
      workflowId: 'BOOKS_READ',
      confidence: 'medium',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'Zoho Books read intent',
    };
  }

  if (containsAny(text, ['email for', 'phone for', 'contact details', 'email address for', 'contact for'])) {
    return {
      domain: 'context',
      workflowId: 'CONTACT_LOOKUP',
      confidence: 'high',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'contact lookup intent',
    };
  }

  if (containsAny(text, ['what did we', 'earlier', 'previous', 'last draft', 'last message', 'discussed'])) {
    return {
      domain: 'context',
      workflowId: 'HISTORY_LOOKUP',
      confidence: 'medium',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'history lookup intent',
    };
  }

  if (containsAny(text, ['contract', 'pdf', 'document', 'uploaded file', 'attachment', 'file'])) {
    return {
      domain: 'context',
      workflowId: 'FILE_LOOKUP',
      confidence: 'medium',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'file lookup intent',
    };
  }

  if (containsAny(text, ['latest', 'news', 'research', 'look up', 'search', 'web'])) {
    return {
      domain: 'context',
      workflowId: 'WEB_RESEARCH',
      confidence: 'medium',
      canExecuteNow: true,
      missingInputs: [],
      reason: 'web research intent',
    };
  }

  return {
    domain: 'context',
    workflowId: 'MIXED_LOOKUP',
    confidence: 'low',
    canExecuteNow: true,
    missingInputs: [],
    reason: 'default mixed lookup fallback',
  };
};

const buildWorkflowFailureResult = (
  classifier: ClassifierResult,
  status: WorkflowExecutionStatus,
  text: string,
  reason?: string,
): WorkflowExecutionResult => ({
  domain: classifier.domain,
  workflowId: classifier.workflowId,
  status,
  text,
  toolResults: [],
  pendingApproval: null,
  calledToolNames: [],
  missingInputs: classifier.missingInputs,
  ...(reason ? { reason } : {}),
});

const normalizeWorkflowResult = (
  classifier: ClassifierResult,
  result: SubAgentTextResult,
  overrides?: Partial<Pick<WorkflowExecutionResult, 'status' | 'reason' | 'rerouteReason' | 'missingInputs'>>,
): WorkflowExecutionResult => {
  const failedTool = result.toolResults.find((entry) => !entry.success && !entry.pendingApprovalAction);
  return {
    domain: classifier.domain,
    workflowId: classifier.workflowId,
    status: overrides?.status ?? (failedTool ? 'TOOL_EXECUTION_FAILED' : 'SUCCESS'),
    text: result.text,
    toolResults: result.toolResults,
    pendingApproval: result.pendingApproval,
    calledToolNames: result.calledToolNames,
    missingInputs: overrides?.missingInputs ?? classifier.missingInputs,
    ...(overrides?.reason ? { reason: overrides.reason } : failedTool?.error ? { reason: failedTool.error } : {}),
    ...(overrides?.rerouteReason ? { rerouteReason: overrides.rerouteReason } : {}),
  };
};

const validateWorkflowExecution = (
  classifier: ClassifierResult,
  result: WorkflowExecutionResult,
): WorkflowValidationResult => {
  const normalizedText = result.text.toLowerCase();
  const hasToolFailureEvidence = result.toolResults.some((entry) => !entry.success || Boolean(entry.error));
  const hasUnsupportedClaim = /(unable|unavailable|unsupported|do not have access|can't|cannot)/i.test(normalizedText);
  const usedTaskTool = result.calledToolNames.includes('task');
  const usedDocTool = result.calledToolNames.includes('doc');
  const usedCalendarTool = result.calledToolNames.includes('calendar');
  const usedSendEmailTool = result.calledToolNames.includes('sendEmail');

  if (classifier.workflowId === 'SCHEDULE_MEETING' && !usedCalendarTool) {
    return {
      valid: false,
      reason: 'missing_required_tool_call',
      detail: 'meeting scheduling workflow completed without calendar tool usage',
    };
  }
  if (classifier.workflowId === 'CREATE_DOC' && usedTaskTool && !usedDocTool) {
    return {
      valid: false,
      reason: 'wrong_object_type',
      detail: 'doc creation workflow used task tool instead of doc tool',
    };
  }
  if (classifier.workflowId === 'SEND_EMAIL' && !usedSendEmailTool) {
    return {
      valid: false,
      reason: 'missing_required_tool_call',
      detail: 'email send workflow completed without sendEmail tool usage',
    };
  }
  if (hasUnsupportedClaim && !hasToolFailureEvidence) {
    return {
      valid: false,
      reason: 'unsupported_claim_without_tool_evidence',
      detail: 'final text reported unsupported or unavailable without matching tool failure evidence',
    };
  }
  return { valid: true };
};

const buildContextSourcesForWorkflow = (
  workflowId: Extract<WorkflowId, 'CONTACT_LOOKUP' | 'HISTORY_LOOKUP' | 'FILE_LOOKUP' | 'WEB_RESEARCH' | 'MIXED_LOOKUP'>,
) => {
  if (workflowId === 'CONTACT_LOOKUP') {
    return { web: false, larkContacts: true, personalHistory: true, files: false, zohoCrmContext: true, skills: false };
  }
  if (workflowId === 'HISTORY_LOOKUP') {
    return { web: false, larkContacts: false, personalHistory: true, files: false, zohoCrmContext: false, skills: false };
  }
  if (workflowId === 'FILE_LOOKUP') {
    return { web: false, larkContacts: false, personalHistory: false, files: true, zohoCrmContext: false, skills: false };
  }
  if (workflowId === 'WEB_RESEARCH') {
    return { web: true, larkContacts: false, personalHistory: false, files: false, zohoCrmContext: false, skills: false };
  }
  return { web: false, larkContacts: true, personalHistory: true, files: true, zohoCrmContext: true, skills: false };
};

const buildContextWorkflowPromptSpec = (
  workflowId: Extract<WorkflowId, 'CONTACT_LOOKUP' | 'HISTORY_LOOKUP' | 'FILE_LOOKUP' | 'WEB_RESEARCH' | 'MIXED_LOOKUP'>,
): WorkflowPromptSpec => ({
  role: 'retrieval specialist focused on grounded lookup',
  allowedTools: ['contextSearch'],
  whenToUse: [
    'Use contextSearch with the fixed source profile for this workflow.',
    'Search first. Only use fetch if you already have a chunkRef and need full content.',
    'Return exactly what you found and what sources were checked.',
  ],
  missingInputPolicy: 'If the request is too vague to search, ask for the missing entity, document, or topic.',
  examples: workflowId === 'CONTACT_LOOKUP'
    ? ['"find email for Vijay" -> use contextSearch with contact-focused sources.']
    : workflowId === 'HISTORY_LOOKUP'
      ? ['"what did we decide earlier about the invoice?" -> use contextSearch with personal history only.']
      : workflowId === 'FILE_LOOKUP'
        ? ['"find the pricing clause in the contract" -> use contextSearch with files only.']
        : workflowId === 'WEB_RESEARCH'
          ? ['"search latest AI agent prompting repos" -> use contextSearch with web only.']
          : ['"find Anish contact details and our earlier draft" -> use contextSearch with mixed sources.'],
  negativeExamples: [
    'Do not claim nothing is available unless you actually searched.',
    'Do not silently include unrelated sources for a narrow workflow.',
  ],
});

const runContextWorkflow = async (
  classifier: ClassifierResult,
  runtime: VercelRuntimeRequestContext,
  objective: string,
  abortSignal?: AbortSignal,
): Promise<WorkflowExecutionResult> => {
  const workflowId = classifier.workflowId as Extract<WorkflowId, 'CONTACT_LOOKUP' | 'HISTORY_LOOKUP' | 'FILE_LOOKUP' | 'WEB_RESEARCH' | 'MIXED_LOOKUP'>;
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: `context-${workflowId.toLowerCase()}`,
  });
  const contextSearchTool = legacyTools.contextSearch;
  if (!contextSearchTool) {
    return buildWorkflowFailureResult(
      classifier,
      'TOOLSET_INSUFFICIENT',
      'Context search is not available for this user.',
      'context search tool missing',
    );
  }

  const result = await runSubAgent({
    label: 'retrieval specialist',
    prompt: buildWorkflowPrompt(buildContextWorkflowPromptSpec(workflowId), classifier.confidence !== 'low'),
    message: buildSubAgentUserMessage(objective),
    tools: {
      contextSearch: tool({
        description: 'Search context using the fixed source profile for this workflow.',
        inputSchema: z.object({
          query: z.string(),
          operation: z.enum(['search', 'fetch']),
          limit: z.number().optional(),
          chunkRef: z.string().optional(),
        }),
        execute: async ({ query, operation, limit, chunkRef }) =>
          contextSearchTool.execute({
            query,
            operation,
            sources: buildContextSourcesForWorkflow(workflowId),
            scopes: ['all'] as const,
            limit: limit ?? 8,
            ...(chunkRef ? { chunkRef } : {}),
          }),
      }),
    },
    toolChoice: 'required',
    runtime,
    maxSteps: workflowId === 'MIXED_LOOKUP' ? 6 : 4,
    abortSignal,
  });

  return normalizeWorkflowResult(classifier, result);
};

const runGoogleWorkflow = async (
  classifier: ClassifierResult,
  runtime: VercelRuntimeRequestContext,
  params: { objective: string; recipientEmail?: string; subject?: string; body?: string },
  abortSignal?: AbortSignal,
  strictRetry = false,
): Promise<WorkflowExecutionResult> => {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: `google-${classifier.workflowId.toLowerCase()}`,
  });
  const googleWorkspaceTool = legacyTools.googleWorkspace;
  const contextSearchTool = legacyTools.contextSearch;
  if (!googleWorkspaceTool) {
    return buildWorkflowFailureResult(
      classifier,
      'TOOLSET_INSUFFICIENT',
      'Google Workspace tools are not available for this user.',
      'google workspace tool missing',
    );
  }

  const tools: Record<string, ReturnType<typeof tool>> = {};
  let toolChoice: 'required' | { toolName: string } = 'required';

  if (classifier.workflowId === 'SEND_EMAIL') {
    if (contextSearchTool) {
      tools.resolveRecipient = tool({
        description: 'Resolve a recipient name to contact details. Use only if the user named a person instead of an email address.',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) =>
          contextSearchTool.execute({
            query,
            operation: 'search',
            sources: buildContextSourcesForWorkflow('CONTACT_LOOKUP'),
            scopes: ['all'] as const,
            limit: 5,
          }),
      });
    }
    tools.sendEmail = tool({
      description: 'Send an email. Use this workflow only for actual sending, not drafts.',
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
    });
  } else if (classifier.workflowId === 'CREATE_DRAFT') {
    tools.createDraft = tool({
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
    });
    toolChoice = { toolName: 'createDraft' };
  } else {
    tools.searchEmail = tool({
      description: 'Search Gmail messages.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) =>
        googleWorkspaceTool.execute({
          operation: 'searchMessages',
          query,
        }),
    });
    toolChoice = { toolName: 'searchEmail' };
  }

  const promptSpec: WorkflowPromptSpec = {
    role: 'Google Workspace specialist for a single workflow',
    allowedTools: Object.keys(tools),
    whenToUse: classifier.workflowId === 'SEND_EMAIL'
      ? [
          'If the user gave a person name instead of an email address, resolve the recipient first.',
          'Use sendEmail only for actual sending.',
          'If send approval is required, return the grounded pending-approval result.',
        ]
      : classifier.workflowId === 'CREATE_DRAFT'
        ? ['Use createDraft for draft requests only.']
        : ['Use searchEmail for inbox or Gmail search requests only.'],
    missingInputPolicy:
      'If required fields such as recipient, subject, or body are missing, ask only for those exact missing fields.',
    examples: classifier.workflowId === 'SEND_EMAIL'
      ? ['"send email to anish with the findings" -> resolve recipient if needed, then sendEmail.']
      : classifier.workflowId === 'CREATE_DRAFT'
        ? ['"create a draft to Vijay about the invoice" -> createDraft.']
        : ['"search Gmail for the last mail from Anish" -> searchEmail.'],
    negativeExamples: classifier.workflowId === 'SEND_EMAIL'
      ? ['Do not create a draft when the user asked to send.', 'Do not say email sending is unavailable unless the tool call failed.']
      : ['Do not send an email from a read-only or draft workflow.'],
  };

  const result = await runSubAgent({
    label: 'Google Workspace specialist',
    prompt: buildWorkflowPrompt(promptSpec, strictRetry || classifier.workflowId !== 'SEARCH_EMAIL'),
    message: buildSubAgentUserMessage(params.objective, {
      recipientEmail: params.recipientEmail,
      subject: params.subject,
      body: params.body,
    }),
    tools,
    toolChoice,
    runtime,
    maxSteps: 6,
    abortSignal,
  });

  return normalizeWorkflowResult(classifier, result, strictRetry ? { rerouteReason: 'strict_google_retry' } : undefined);
};

const runZohoWorkflow = async (
  classifier: ClassifierResult,
  runtime: VercelRuntimeRequestContext,
  objective: string,
  abortSignal?: AbortSignal,
): Promise<WorkflowExecutionResult> => {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: `zoho-${classifier.workflowId.toLowerCase()}`,
  });
  const zohoBooksTool = legacyTools.zohoBooks;
  const zohoCrmTool = legacyTools.zohoCrm;

  if (classifier.workflowId === 'OVERDUE_REPORT' || classifier.workflowId === 'BOOKS_READ') {
    if (!zohoBooksTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Zoho Books tools are not available for this user.', 'zoho books tool missing');
    }
  }
  if (classifier.workflowId === 'CRM_READ' && !zohoCrmTool) {
    return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Zoho CRM tools are not available for this user.', 'zoho crm tool missing');
  }

  const tools: Record<string, ReturnType<typeof tool>> = {};
  let toolChoice: { toolName: string } | 'required' = 'required';
  const promptSpec: WorkflowPromptSpec = {
    role: 'Zoho specialist for grounded financial and CRM reads',
    allowedTools: [],
    whenToUse: [],
    missingInputPolicy: 'If a record identifier or report name is required and missing, ask for that exact missing value.',
    examples: [],
    negativeExamples: ['Do not use context search for Zoho workflows unless the request explicitly asks for non-Zoho context.'],
  };

  if (classifier.workflowId === 'OVERDUE_REPORT') {
    tools.readBooks = tool({
      description: 'Build or fetch overdue invoice reports from Zoho Books.',
      inputSchema: z.object({
        operation: z.enum(['buildOverdueReport', 'getReport', 'listRecords', 'getRecord']),
        recordType: z.string().optional(),
        filters: z.record(z.string()).optional(),
        recordId: z.string().optional(),
        reportName: z.string().optional(),
      }),
      execute: async ({ operation, recordType, filters, recordId, reportName }) =>
        zohoBooksTool!.execute({
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
    toolChoice = { toolName: 'readBooks' };
    promptSpec.allowedTools = ['readBooks'];
    promptSpec.whenToUse = ['Use readBooks for overdue reports and invoice-overdue reads only.'];
    promptSpec.examples = ['"review overdue invoices" -> readBooks with buildOverdueReport.'];
  } else if (classifier.workflowId === 'CRM_READ') {
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
        zohoCrmTool!.execute({
          operation,
          ...(module ? { module } : {}),
          ...(query ? { query } : {}),
          ...(recordId ? { recordId } : {}),
          ...(filters ? { filters } : {}),
        }),
    });
    toolChoice = { toolName: 'readCRM' };
    promptSpec.allowedTools = ['readCRM'];
    promptSpec.whenToUse = ['Use readCRM for deals, leads, contacts, and CRM record reads.'];
    promptSpec.examples = ['"find CRM details for a customer" -> readCRM.'];
  } else {
    tools.readBooks = tool({
      description: 'Read Zoho Books records.',
      inputSchema: z.object({
        operation: z.enum(['listRecords', 'getRecord', 'getReport']),
        recordType: z.string().optional(),
        filters: z.record(z.string()).optional(),
        recordId: z.string().optional(),
        reportName: z.string().optional(),
      }),
      execute: async ({ operation, recordType, filters, recordId, reportName }) =>
        zohoBooksTool!.execute({
          operation: 'read',
          ...(recordType ? { module: recordType } : {}),
          ...(filters ? { filters } : {}),
          ...(recordId ? { recordId } : {}),
          ...(reportName ? { reportName } : {}),
          ...(operation === 'getRecord' ? { readOperation: 'getRecord' } : {}),
          ...(operation === 'listRecords' ? { readOperation: 'listRecords' } : {}),
          ...(operation === 'getReport' ? { readOperation: 'getReport' } : {}),
        }),
    });
    toolChoice = { toolName: 'readBooks' };
    promptSpec.allowedTools = ['readBooks'];
    promptSpec.whenToUse = ['Use readBooks for standard Books record reads.'];
    promptSpec.examples = ['"show the invoice record" -> readBooks.'];
  }

  const result = await runSubAgent({
    label: 'Zoho specialist',
    prompt: buildWorkflowPrompt(promptSpec, true),
    message: buildSubAgentUserMessage(objective),
    tools,
    toolChoice,
    runtime,
    maxSteps: 4,
    abortSignal,
  });

  return normalizeWorkflowResult(classifier, result);
};

const runLarkWorkflow = async (
  classifier: ClassifierResult,
  runtime: VercelRuntimeRequestContext,
  params: { objective: string; assignee?: string },
  abortSignal?: AbortSignal,
  strictRetry = false,
): Promise<WorkflowExecutionResult> => {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: `lark-${classifier.workflowId.toLowerCase()}`,
  });
  const larkTaskTool = legacyTools.larkTask;
  const larkMessageTool = legacyTools.larkMessage;
  const larkCalendarTool = legacyTools.larkCalendar;
  const larkMeetingTool = legacyTools.larkMeeting;
  const larkDocTool = legacyTools.larkDoc;
  const tools: Record<string, ReturnType<typeof tool>> = {};
  let toolChoice: 'required' | { toolName: string } = 'required';

  const promptSpec: WorkflowPromptSpec = {
    role: 'Lark workflow specialist',
    allowedTools: [],
    whenToUse: [],
    missingInputPolicy: 'If required attendee, recipient, title, or content fields are missing, ask only for those exact missing fields.',
    examples: [],
    negativeExamples: [],
  };

  if (classifier.workflowId === 'READ_TASKS') {
    if (!larkTaskTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark task tools are not available for this user.', 'lark task tool missing');
    }
    tools.task = tool({
      description: 'Read current Lark tasks.',
      inputSchema: z.object({
        operation: z.enum(['listMine', 'listOpenMine', 'current', 'listTasklists']),
      }),
      execute: async ({ operation }) =>
        larkTaskTool.execute({
          operation: 'read',
          taskOperation: operation,
        }),
    });
    toolChoice = { toolName: 'task' };
    promptSpec.allowedTools = ['task'];
    promptSpec.whenToUse = ['Use task for task reads only.'];
    promptSpec.examples = ['"show my active tasks" -> task.listOpenMine.'];
    promptSpec.negativeExamples = ['Do not use listAssignableUsers for "my tasks".'];
  } else if (classifier.workflowId === 'CREATE_TASK') {
    if (!larkTaskTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark task tools are not available for this user.', 'lark task tool missing');
    }
    tools.task = tool({
      description: 'Create or assign a Lark task. Use only for todos, reminders, or follow-ups.',
      inputSchema: z.object({
        operation: z.enum(['create', 'reassign']),
        summary: z.string().optional(),
        description: z.string().optional(),
        dueTs: z.string().optional(),
        assigneeName: z.string().optional(),
      }),
      execute: async ({ operation, summary, description, dueTs, assigneeName }) =>
        larkTaskTool.execute({
          operation: 'write',
          taskOperation: operation,
          ...(summary ? { summary } : {}),
          ...(description ? { description } : {}),
          ...(dueTs ? { dueTs } : {}),
          ...(assigneeName ? { assigneeMode: 'named_people', assigneeNames: [assigneeName] } : {}),
        }),
    });
    toolChoice = { toolName: 'task' };
    promptSpec.allowedTools = ['task'];
    promptSpec.whenToUse = ['Use task only for true action items.'];
    promptSpec.examples = ['"create a follow-up task for Vijay" -> task.create.'];
    promptSpec.negativeExamples = ['Do not create tasks for meeting requests.', 'Do not create tasks for document requests.'];
  } else if (classifier.workflowId === 'READ_CALENDAR') {
    if (!larkCalendarTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark calendar tools are not available for this user.', 'lark calendar tool missing');
    }
    tools.calendar = tool({
      description: 'Read Lark calendars and events.',
      inputSchema: z.object({
        operation: z.enum(['listCalendars', 'listEvents', 'getEvent']),
        calendarId: z.string().optional(),
        eventId: z.string().optional(),
        dateScope: z.string().optional(),
      }),
      execute: async ({ operation, calendarId, eventId, dateScope }) =>
        larkCalendarTool.execute({
          operation,
          ...(calendarId ? { calendarId } : {}),
          ...(eventId ? { eventId } : {}),
          ...(dateScope ? { dateScope } : {}),
        }),
    });
    toolChoice = { toolName: 'calendar' };
    promptSpec.allowedTools = ['calendar'];
    promptSpec.whenToUse = ['Use calendar.listEvents for day-scoped event and meeting discovery.', 'Use calendar.listCalendars only when the user asked about calendars.'];
    promptSpec.examples = ['"show my meetings today" -> calendar.listEvents.'];
    promptSpec.negativeExamples = ['Do not use task or meeting detail tools for simple day-scoped calendar reads.'];
  } else if (classifier.workflowId === 'SCHEDULE_MEETING') {
    if (!larkCalendarTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark calendar tools are not available for this user.', 'lark calendar tool missing');
    }
    tools.calendar = tool({
      description: 'Schedule a Lark meeting. This is the required tool for meeting scheduling requests.',
      inputSchema: z.object({
        operation: z.enum(['scheduleMeeting', 'listAvailability']).default('scheduleMeeting'),
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
      execute: async ({ operation, startTime, endTime, searchStartTime, searchEndTime, durationMinutes, summary, description, attendeeName, attendeeNames, includeMe, needNotification }) =>
        larkCalendarTool.execute({
          operation,
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
    toolChoice = { toolName: 'calendar' };
    promptSpec.allowedTools = ['calendar'];
    promptSpec.whenToUse = ['Use calendar.scheduleMeeting directly for schedule, set up, or book meeting requests.', 'Use attendee names directly; do not preflight with task or assignee listing.'];
    promptSpec.examples = ['"schedule a meeting with Shivam and Archit now" -> calendar.scheduleMeeting.'];
    promptSpec.negativeExamples = ['Do not create a task as a meeting placeholder.', 'Do not say the calendar tool is unavailable unless the tool call failed.'];
  } else if (classifier.workflowId === 'READ_MEETING_DETAILS') {
    if (!larkMeetingTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark meeting tools are not available for this user.', 'lark meeting tool missing');
    }
    tools.meeting = tool({
      description: 'Read specific meeting details or minutes.',
      inputSchema: z.object({
        operation: z.enum(['list', 'get', 'getMinute']),
        meetingId: z.string().optional(),
        meetingNo: z.string().optional(),
        minuteToken: z.string().optional(),
        query: z.string().optional(),
      }),
      execute: async ({ operation, meetingId, meetingNo, minuteToken, query }) =>
        larkMeetingTool.execute({
          operation,
          ...(meetingId ? { meetingId } : {}),
          ...(meetingNo ? { meetingNo } : {}),
          ...(minuteToken ? { minuteToken } : {}),
          ...(query ? { query } : {}),
        }),
    });
    toolChoice = { toolName: 'meeting' };
    promptSpec.allowedTools = ['meeting'];
    promptSpec.whenToUse = ['Use meeting only for specific meeting inspection, meeting lookup, or minutes.'];
    promptSpec.examples = ['"show the minutes for this meeting" -> meeting.getMinute.'];
    promptSpec.negativeExamples = ['Do not use meeting tool for day-scoped event discovery.'];
  } else if (classifier.workflowId === 'CREATE_DOC' || classifier.workflowId === 'EDIT_DOC') {
    if (!larkDocTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark doc tools are not available for this user.', 'lark doc tool missing');
    }
    tools.doc = tool({
      description: 'Create or edit a Lark doc using markdown.',
      inputSchema: z.object({
        operation: classifier.workflowId === 'CREATE_DOC'
          ? z.enum(['create'] as const)
          : z.enum(['edit', 'inspect', 'read'] as const),
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
    toolChoice = { toolName: 'doc' };
    promptSpec.allowedTools = ['doc'];
    promptSpec.whenToUse = ['Use doc for documents, notes, pages, reports, and markdown snapshots only.'];
    promptSpec.examples = classifier.workflowId === 'CREATE_DOC'
      ? ['"create a Lark doc titled Daily Lark Snapshot" -> doc.create.']
      : ['"append these notes to the existing doc" -> doc.edit.'];
    promptSpec.negativeExamples = ['Do not store report content inside a task title or task summary.', 'Do not create a task when the user asked for a doc.'];
  } else if (classifier.workflowId === 'SEND_DM') {
    if (!larkMessageTool) {
      return buildWorkflowFailureResult(classifier, 'TOOLSET_INSUFFICIENT', 'Lark message tools are not available for this user.', 'lark message tool missing');
    }
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
    toolChoice = { toolName: 'sendMessage' };
    promptSpec.allowedTools = ['sendMessage'];
    promptSpec.whenToUse = ['Use sendMessage only for direct message requests.'];
    promptSpec.examples = ['"send a DM to Anish" -> sendMessage.'];
    promptSpec.negativeExamples = ['Do not create a task or doc for a DM request.'];
  }

  const result = await runSubAgent({
    label: 'Lark specialist',
    prompt: buildWorkflowPrompt(promptSpec, strictRetry || classifier.workflowId !== 'READ_TASKS'),
    message: buildSubAgentUserMessage(params.objective, {
      assignee: params.assignee,
    }),
    tools,
    toolChoice,
    runtime,
    maxSteps: classifier.workflowId === 'SCHEDULE_MEETING' ? 8 : 6,
    abortSignal,
  });

  return normalizeWorkflowResult(classifier, result, strictRetry ? { rerouteReason: 'strict_lark_retry' } : undefined);
};

const executeWorkflow = async (
  classifier: ClassifierResult,
  runtime: VercelRuntimeRequestContext,
  message: NormalizedIncomingMessageDTO,
  abortSignal?: AbortSignal,
  strictRetry = false,
): Promise<WorkflowExecutionResult> => {
  if (!classifier.canExecuteNow && classifier.missingInputs.length > 0) {
    return buildWorkflowFailureResult(
      classifier,
      'MISSING_REQUIRED_FIELDS',
      buildMissingInputsText(classifier.workflowId, classifier.missingInputs),
      classifier.reason,
    );
  }

  if (classifier.domain === 'context') {
    return runContextWorkflow(classifier, runtime, message.text, abortSignal);
  }
  if (classifier.domain === 'google') {
    return runGoogleWorkflow(
      classifier,
      runtime,
      { objective: message.text },
      abortSignal,
      strictRetry,
    );
  }
  if (classifier.domain === 'zoho') {
    return runZohoWorkflow(classifier, runtime, message.text, abortSignal);
  }
  return runLarkWorkflow(classifier, runtime, { objective: message.text }, abortSignal, strictRetry);
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

    const updateLiveStatus = async (text: string): Promise<void> => {
      void text;
    };
    const classifier = classifyWorkflow(message.text);
    await appendExecutionEventSafe({
      executionId,
      phase: 'planning',
      eventType: 'workflow.classified',
      actorType: 'system',
      actorKey: 'supervisor',
      title: 'Workflow classified',
      status: 'done',
      payload: classifier,
    });

    await updateLiveStatus(buildAgentStartStatus(`${classifier.domain}:${classifier.workflowId}`, message.text));
    let workflowResult = await executeWorkflow(classifier, runtime, message, abortSignal);
    await updateLiveStatus(`I completed the routed workflow ${classifier.workflowId}.`);

    let validation = workflowResult.status === 'SUCCESS'
      ? validateWorkflowExecution(classifier, workflowResult)
      : { valid: true as const };

    if (!validation.valid) {
      await appendExecutionEventSafe({
        executionId,
        phase: 'tools',
        eventType: 'workflow.validation.failed',
        actorType: 'system',
        actorKey: 'supervisor',
        title: 'Workflow validation failed',
        summary: validation.detail,
        status: 'failed',
        payload: {
          classifier,
          validation,
          toolResults: workflowResult.toolResults.map((entry) => ({
            toolId: entry.toolId,
            summary: entry.summary,
            success: entry.success,
          })),
        },
      });

      workflowResult = await executeWorkflow(classifier, runtime, message, abortSignal, true);
      validation = workflowResult.status === 'SUCCESS'
        ? validateWorkflowExecution(classifier, workflowResult)
        : { valid: true as const };

      if (!validation.valid) {
        workflowResult = {
          ...workflowResult,
          status: 'TOOLSET_INSUFFICIENT',
          text: `I could not complete this through the routed ${classifier.workflowId.toLowerCase()} workflow after validating the tool path. Please restate the request with explicit details.`,
          reason: validation.detail,
          rerouteReason: validation.reason,
        };
      }
    }

    await appendExecutionEventSafe({
      executionId,
      phase: 'tools',
      eventType: 'workflow.completed',
      actorType: 'agent',
      actorKey: 'supervisor',
      title: 'Workflow completed',
      status: workflowResult.status === 'SUCCESS' ? 'done' : workflowResult.status === 'MISSING_REQUIRED_FIELDS' ? 'pending' : 'failed',
      payload: {
        classifier,
        workflowResult: {
          status: workflowResult.status,
          reason: workflowResult.reason ?? null,
          rerouteReason: workflowResult.rerouteReason ?? null,
          calledToolNames: workflowResult.calledToolNames,
          pendingApproval: Boolean(workflowResult.pendingApproval),
        },
        validator: validation,
      },
    });

    const toolResults = workflowResult.toolResults;
    const pendingApproval = workflowResult.pendingApproval ?? extractPendingApproval(toolResults);
    const rawText = workflowResult.text?.trim()
      || toolResults.map((entry) => entry.summary).filter(Boolean).join('\n\n')
      || 'Completed the request.';
    const finalText = rawText.length > 50_000
      ? `${rawText.slice(0, 50_000)}\n\n*(Response truncated — showing first portion)*`
      : rawText;
    const hasToolResults = toolResults.length > 0 || workflowResult.calledToolNames.length > 0;
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
        stepHistory: ['supervisor_v2.classify', 'supervisor_v2.executeWorkflow'],
        routeIntent: runtime.canonicalIntent
          ? `${runtime.canonicalIntent.domain}:${runtime.canonicalIntent.operationClass}`
          : undefined,
        canonicalIntent: runtime.canonicalIntent,
        supervisorWaveCount: 1,
        workflowDomain: classifier.domain,
        workflowId: classifier.workflowId,
        workflowConfidence: classifier.confidence,
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
