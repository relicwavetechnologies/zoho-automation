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
import {
  buildTaskStateContext,
  buildThreadSummaryContext,
  filterThreadMessagesForContext,
  parseDesktopTaskState,
  parseDesktopThreadSummary,
  upsertDesktopSourceArtifacts,
} from '../../../modules/desktop-chat/desktop-thread-memory';
import { fileUploadService } from '../../../modules/file-upload/file-upload.service';
import { logger } from '../../../utils/logger';
import { redDebug } from '../../../utils/red-debug';
import { estimateTokens } from '../../../utils/token-estimator';

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
  threadSummaryContext?: string;
  taskStateContext?: string;
  historySource: 'lark_shared_chat' | 'lark_lifetime_thread' | 'desktop_thread' | 'ephemeral_memory';
};

type DeliveryMode =
  | 'inline'
  | 'preview_plus_artifact'
  | 'workspace_process_then_publish'
  | 'saved_for_later_processing';

type ArtifactDecision = {
  mode: DeliveryMode;
  rowCount: number;
  reportedTotal: number;
  byteSize: number;
  previewRows: unknown[];
  rows: unknown[];
};

type SavedArtifact = {
  artifactId: string;
  label: string;
  sourceDomain: string;
  kind: 'csv' | 'json' | 'report';
  rowCount: number;
  byteSize: number;
  publishedUrl?: string;
  localPath?: string;
  querySummary: string;
  schemaSummary: string;
  createdAt: string;
  status: 'saved' | 'saved_for_later_processing' | 'processed' | 'published';
  chatId?: string;
  threadId?: string;
};

const LARK_V2_MODE: VercelRuntimeRequestContext['mode'] = 'high';
const SUPERVISOR_HISTORY_TOKEN_BUDGET = 8_000;
const SUPERVISOR_HISTORY_MAX_MESSAGES = 16;
const SUPERVISOR_CONTEXT_TEXT_LIMIT = 2_000;

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

const LARGE_RESULT_KEYS = [
  'invoices',
  'records',
  'items',
  'results',
  'rows',
  'data',
  'messages',
  'events',
  'tasks',
  'people',
] as const;

const extractRowCount = (toolResults: VercelToolEnvelope[]): number => {
  for (const result of toolResults) {
    const data = asRecord(result.data) ?? asRecord(result.fullPayload);
    if (!data) continue;
    const invoiceCount = asNumber(data.invoiceCount);
    if (invoiceCount !== undefined) return invoiceCount;
    for (const key of LARGE_RESULT_KEYS) {
      const arr = asArray(data[key]);
      if (arr.length > 0) return arr.length;
    }
  }
  return 0;
};

const extractRawRows = (toolResults: VercelToolEnvelope[]): unknown[] => {
  for (const result of toolResults) {
    const data = asRecord(result.data) ?? asRecord(result.fullPayload);
    if (!data) continue;
    for (const key of LARGE_RESULT_KEYS) {
      const arr = asArray(data[key]);
      if (arr.length > 0) return arr;
    }
  }
  return [];
};

const extractKeyStats = (toolResults: VercelToolEnvelope[]): string => {
  for (const result of toolResults) {
    const data = asRecord(result.data) ?? asRecord(result.fullPayload);
    if (!data) continue;
    const parts: string[] = [];
    if (asNumber(data.invoiceCount) !== undefined) {
      parts.push(`${data.invoiceCount} invoices`);
    }
    if (asNumber(data.totalOutstanding) !== undefined) {
      parts.push(
        `Total: ${Number(data.totalOutstanding).toLocaleString('en-IN', {
          style: 'currency',
          currency: 'INR',
        })}`,
      );
    }
    if (parts.length === 0) {
      const summary = asString(data.summary);
      if (summary) {
        parts.push(summary);
      }
    }
    if (parts.length > 0) return parts.join(' · ');
  }
  return '';
};

const convertToCSV = (rows: unknown[]): Buffer => {
  if (rows.length === 0) return Buffer.from('');
  const firstRow = asRecord(rows[0]) ?? {};
  const headers = Object.keys(firstRow);
  const escape = (val: unknown): string => {
    const str = val === null || val === undefined ? '' : String(val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };
  const lines = [
    headers.join(','),
    ...rows.map((row) => {
      const r = asRecord(row) ?? {};
      return headers.map((header) => escape(r[header])).join(',');
    }),
  ];
  return Buffer.from(lines.join('\n'), 'utf-8');
};

const containsProcessVerb = (text: string): boolean =>
  /\b(analyze|analyse|process|clean|dedupe|deduplicate|reconcile|merge|compare|transform|aggregate|filter|sort|group|pivot|summarize|calculate|find|save|cleaned|report)\b/i
    .test(text);

const decideDeliveryMode = (
  rowCount: number,
  byteSize: number,
  userIntent: string,
  workspaceAvailable: boolean,
): DeliveryMode => {
  const processVerb = containsProcessVerb(userIntent);

  if (processVerb && workspaceAvailable) return 'workspace_process_then_publish';
  if (processVerb && !workspaceAvailable) return 'saved_for_later_processing';
  if (rowCount <= 20 && byteSize < 25_000) return 'inline';
  if (rowCount <= 200 && byteSize < 250_000) return 'preview_plus_artifact';
  if (workspaceAvailable) return 'workspace_process_then_publish';
  return 'saved_for_later_processing';
};

const buildArtifactDecision = (
  toolResults: VercelToolEnvelope[],
  agentObjective: string,
  userIntent: string,
  workspaceAvailable: boolean,
): ArtifactDecision => {
  const rows = extractRawRows(toolResults);
  const rowCount = rows.length > 0 ? rows.length : extractRowCount(toolResults);
  let reportedTotal = rowCount;
  for (const result of toolResults) {
    const data = asRecord(result.data) ?? asRecord(result.fullPayload);
    if (!data) continue;
    const invoiceCount = asNumber(data.invoiceCount);
    if (invoiceCount !== undefined) {
      reportedTotal = invoiceCount;
      if (invoiceCount > rows.length && rows.length > 0) {
        logger.warn('supervisor_v2.artifact.truncated', {
          extractedRows: rows.length,
          reportedTotal: invoiceCount,
          sourceDomain: 'zoho',
        });
      }
      break;
    }
  }
  const csvBuffer = rows.length > 0 ? convertToCSV(rows) : Buffer.from('');
  const byteSize = csvBuffer.length;
  const previewRows = rows.slice(0, 5);
  const isSummaryQuery = /\b(how many|count|total|summary|overview|stats)\b/i
    .test(agentObjective) && !/\b(list|show|get|fetch|all|export)\b/i.test(agentObjective);
  const mode = isSummaryQuery
    ? 'inline'
    : decideDeliveryMode(rowCount, byteSize, userIntent, workspaceAvailable);
  return { mode, rowCount, reportedTotal, byteSize, previewRows, rows };
};

const buildPreviewTable = (
  previewRows: unknown[],
  rowCount: number,
): string => {
  if (previewRows.length === 0) return '';
  const firstRow = asRecord(previewRows[0]) ?? {};
  const headers = Object.keys(firstRow).slice(0, 6);
  if (headers.length === 0) return '';

  const headerRow = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataRows = previewRows.map((row) => {
    const record = asRecord(row) ?? {};
    const cells = headers.map((header) => {
      const value = record[header];
      const str = value === null || value === undefined ? '' : String(value);
      return str.length > 30 ? `${str.slice(0, 27)}...` : str;
    });
    return `| ${cells.join(' | ')} |`;
  });

  const lines = [headerRow, separator, ...dataRows];
  if (rowCount > previewRows.length) {
    lines.push(`\n*(showing ${previewRows.length} of ${rowCount} rows)*`);
  }
  return lines.join('\n');
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

const takeRecentTurnsByTokenBudget = (input: {
  turns: ChatTurn[];
  tokenBudget: number;
  maxMessages: number;
}): ChatTurn[] => {
  const selected: ChatTurn[] = [];
  let usedTokens = 0;
  for (let index = input.turns.length - 1; index >= 0; index -= 1) {
    const turn = input.turns[index]!;
    const estimatedTokens = estimateTokens(turn.content);
    if (
      selected.length >= input.maxMessages
      || (selected.length > 0 && usedTokens + estimatedTokens > input.tokenBudget)
    ) {
      break;
    }
    selected.unshift(turn);
    usedTokens += estimatedTokens;
  }
  return selected;
};

const selectSupervisorTurns = (
  turns: ChatTurn[],
  latestMessage: string,
): ChatTurn[] =>
  dedupeTrailingCurrentMessage(
    takeRecentTurnsByTokenBudget({
      turns: filterThreadMessagesForContext(turns),
      tokenBudget: SUPERVISOR_HISTORY_TOKEN_BUDGET,
      maxMessages: SUPERVISOR_HISTORY_MAX_MESSAGES,
    }),
    latestMessage,
  );

const compactContextText = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > SUPERVISOR_CONTEXT_TEXT_LIMIT
    ? `${trimmed.slice(0, SUPERVISOR_CONTEXT_TEXT_LIMIT)}...`
    : trimmed;
};

const saveArtifact = async (input: {
  rows: unknown[];
  sourceDomain: string;
  querySummary: string;
  companyId: string;
  runtime: VercelRuntimeRequestContext;
}): Promise<SavedArtifact | null> => {
  try {
    const { rows, sourceDomain, querySummary, companyId, runtime } = input;
    if (rows.length === 0) return null;

    const date = new Date().toISOString().slice(0, 16).replace(/[:.T]/g, '-');
    const safeSummary = querySummary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 40);
    const fileName = `${sourceDomain}_${safeSummary || 'artifact'}_${date}.csv`;

    const buffer = convertToCSV(rows);
    const byteSize = buffer.length;
    const firstRow = asRecord(rows[0]) ?? {};
    const schemaSummary = Object.keys(firstRow).slice(0, 8).join(', ');

    const localPath = runtime.workspace?.path
      ? `${runtime.workspace.path.replace(/\/$/, '')}/.divo/artifacts/${fileName}`
      : undefined;

    const uploaded = await fileUploadService.upload({
      buffer,
      mimeType: 'text/csv',
      fileName,
      sizeBytes: byteSize,
      companyId,
      uploaderUserId: runtime.userId,
      uploaderChannel: runtime.channel === 'lark' ? 'lark' : 'desktop',
      allowedRoles: [runtime.requesterAiRole],
    });

    const artifact: SavedArtifact = {
      artifactId: uploaded.fileAssetId,
      label: querySummary.slice(0, 80),
      sourceDomain,
      kind: 'csv',
      rowCount: rows.length,
      byteSize,
      publishedUrl: uploaded.cloudinaryUrl,
      localPath,
      querySummary,
      schemaSummary,
      createdAt: new Date().toISOString(),
      status: 'published',
      chatId: runtime.chatId,
      threadId: runtime.threadId,
    };

    return artifact;
  } catch (error) {
    logger.warn('supervisor_v2.artifact.save_failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
};

const persistArtifactReference = async (
  artifact: SavedArtifact | null,
  runtime: VercelRuntimeRequestContext,
): Promise<void> => {
  if (!artifact?.artifactId) {
    return;
  }

  const nextTaskState = upsertDesktopSourceArtifacts({
    taskState: parseDesktopTaskState(runtime.taskState),
    artifacts: [{
      fileAssetId: artifact.artifactId,
      fileName: artifact.localPath?.split('/').pop()?.trim() || artifact.label || 'artifact.csv',
      sourceType: 'company_file',
      summary: `${artifact.sourceDomain} artifact · ${artifact.rowCount} rows`,
      retrievalHint: artifact.publishedUrl || artifact.localPath || artifact.querySummary,
    }],
  });

  runtime.taskState = nextTaskState;

  try {
    if (runtime.channel === 'lark' && runtime.sourceChatType === 'group' && runtime.chatId) {
      await larkChatContextService.updateMemory({
        companyId: runtime.companyId,
        chatId: runtime.chatId,
        chatType: 'group',
        taskState: nextTaskState,
      });
      return;
    }

    if (runtime.threadId) {
      await desktopThreadsService.updateOwnedThreadMemory(
        runtime.threadId,
        runtime.userId,
        { taskStateJson: nextTaskState as unknown as Record<string, unknown> },
      );
    }
  } catch (error) {
    logger.warn('supervisor_v2.artifact.persist_failed', {
      artifactId: artifact.artifactId,
      threadId: runtime.threadId,
      chatId: runtime.chatId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

const writeArtifactToWorkspace = async (
  artifact: SavedArtifact,
  rows: unknown[],
  runtime: VercelRuntimeRequestContext,
): Promise<string | null> => {
  if (!artifact.localPath || !runtime.workspace?.path) {
    return null;
  }

  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const dir = path.dirname(artifact.localPath);
    await fs.mkdir(dir, { recursive: true });

    const csvBuffer = convertToCSV(rows);
    await fs.writeFile(artifact.localPath, csvBuffer);

    const stat = await fs.stat(artifact.localPath);
    if (stat.size === 0) {
      logger.warn('supervisor_v2.artifact.local_write_empty', {
        path: artifact.localPath,
      });
      return null;
    }

    logger.info('supervisor_v2.artifact.local_write_ok', {
      path: artifact.localPath,
      bytes: stat.size,
      rows: rows.length,
    });

    return artifact.localPath;
  } catch (error) {
    logger.warn('supervisor_v2.artifact.local_write_failed', {
      path: artifact.localPath,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
};

const buildArtifactPresentation = (input: {
  baseText: string;
  artifact: SavedArtifact | null;
  decision: ArtifactDecision;
  keyStats: string;
  includePreview: boolean;
  localProcessingText?: string;
}): string => {
  const lines = [input.baseText.trim()];
  const summary = input.keyStats || `${input.decision.rowCount} items found`;
  if (summary && !lines[0]?.includes(summary)) {
    lines.push(`**Summary:** ${summary}`);
  }
  if (input.includePreview) {
    const preview = buildPreviewTable(input.decision.previewRows, input.decision.rowCount);
    if (preview) {
      lines.push('**Preview:**');
      lines.push(preview);
    }
  }
  if (input.artifact?.publishedUrl) {
    const fileName = input.artifact.localPath?.split('/').pop() || `${input.artifact.sourceDomain}_artifact.csv`;
    const truncationNote = input.decision.reportedTotal > input.artifact.rowCount
      ? ` *(Note: artifact contains ${input.artifact.rowCount} of ${input.decision.reportedTotal} total rows — Zoho API limit)*`
      : '';
    lines.push(`**${input.decision.reportedTotal} items found. Full data:** [${fileName}](${input.artifact.publishedUrl})${truncationNote}`);
  }
  if (input.artifact?.localPath && input.localProcessingText) {
    lines.push(input.localProcessingText);
  } else if (input.artifact?.localPath && input.decision.mode === 'saved_for_later_processing') {
    lines.push(`**Saved for later processing:** ${input.artifact.localPath}`);
  }
  return lines.filter((line) => line && line.trim().length > 0).join('\n\n');
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
    'devTools',
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

export const buildSupervisorSystemPrompt = (
  runtime: VercelRuntimeRequestContext,
  conversation?: ConversationContextSnapshot,
): string => {
  const today = new Date().toISOString().slice(0, 10);
  const departmentLabel = runtime.departmentName?.trim() || 'no specific department';
  const requesterLabel = runtime.requesterName?.trim() || runtime.requesterEmail?.trim() || 'the current user';
  const threadSummaryContext = compactContextText(conversation?.threadSummaryContext);
  const taskStateContext = compactContextText(conversation?.taskStateContext);
  const workspaceBlock = runtime.workspace
    ? `Connected desktop workspace: ${runtime.workspace.path} (${runtime.workspace.name}). Desktop execution availability: ${runtime.desktopExecutionAvailability ?? 'available'}. Approval policy: ${runtime.desktopApprovalPolicySummary ?? 'unknown'}.`
    : `Connected desktop workspace: none. Desktop execution availability: ${runtime.desktopExecutionAvailability ?? 'none'}.`;
  const conversationMemoryBlock = threadSummaryContext || taskStateContext
    ? [
        'CONVERSATION MEMORY:',
        ...(threadSummaryContext ? [threadSummaryContext] : []),
        ...(taskStateContext ? [taskStateContext] : []),
      ].join('\n')
    : 'CONVERSATION MEMORY: none';
  return `
You are Divo, the orchestration supervisor for company ${runtime.companyId},
department ${departmentLabel}. You are helping ${requesterLabel}. Today is ${today}.

You have 5 specialist agents. You route tasks to them — you never execute tool calls yourself.

AGENTS:
- contextAgent: find contacts, web info, documents, prior conversation facts
- googleWorkspaceAgent: Gmail, Google Drive, Google Calendar — email needs human approval
- zohoAgent: Zoho Books invoices, overdue reports, payments, Zoho CRM records
- larkAgent: Lark tasks, Lark calendar/meetings, Lark messages, Lark docs
- workspaceAgent: local file inspection, read/write files, run scripts — workspace must be connected

CORE RULES:
1. Only act on the LATEST user message. Prior conversation is background context only.
2. Never redo completed work unless the latest message explicitly asks for it.
3. If an agent returns an error, read it, fix the objective, and retry once.
4. Be concise in the final response.
5. Never hallucinate agent names. Use only the 5 agents above.
6. Prior conversation history shows COMPLETED work. A past assistant reply = that task is done.
7. Short fragments like "8am ist today", "yes", "with anish", "tomorrow" are continuations —
   read the last 2-3 turns to find the prior request they are completing.
8. Never combine two separate requests into one answer unless the latest message asks for both.

DATA PRESENTATION RULES:
- 20 items or fewer: answer fully in chat
- 21-200 items: concise summary + 5-row preview + artifact link (agent provides this)
- 200+ items: key stats only + artifact link
- Never paste 50+ row tables into chat
- When an agent returns an artifactUrl always include it as:
  **N items found. Full data:** [filename](url)
- "How many" / "count" / "total" / "kitne" questions: inline answer only, never artifact

WORKSPACE RULES:
- workspaceAgent gets file PATH only, never raw data
- workspaceAgent objective format:
  "Process file at /path/file.csv. Task: X. Output to: /path/out.csv"
- If workspace not available: tell user data is saved and processing can happen when
  workspace connects

FORMATTING:
Use **bold** for emphasis. Use - for bullet lists. For data tables use | Col | format.
Never use ### or ## headings — use **Bold:** instead. Be concise and direct.

PERMISSIONS: ${buildPermissionSummary(runtime)}
${workspaceBlock}
${conversationMemoryBlock}

---

DECISION TREE — follow these routing rules exactly:

CONTACT / PEOPLE LOOKUP:
  Trigger: user asks for email, phone, contact details, "who is X", "find X"
  → contextAgent({ objective: "find contact details for [names]", contactSearch: true })

  Examples:
  - "find vijay sir email"
    → contextAgent({ objective: "find email for Vijay Sir", contactSearch: true })
  - "get anish and shivam contact details"
    → contextAgent({ objective: "find contacts for Anish Suman and Shivam Bhateja", contactSearch: true })
  - "who is archit sir"
    → contextAgent({ objective: "find details for Archit Sir", contactSearch: true })
  - "search for shivam sir, archit sir, divyanshi, anish and vijay sir contact details"
    → contextAgent({ objective: "find contacts for Shivam, Archit, Divyanshi, Anish, Vijay", contactSearch: true })

  NEVER route contact lookups to zohoAgent.

FINANCIAL / INVOICE DATA:
  Trigger: invoices, overdue, payments, balance, Zoho reports, CRM records
  → zohoAgent({ objective: "[exact financial task]" })

  Examples:
  - "get overdue invoices this year with invoice numbers"
    → zohoAgent({ objective: "get all overdue invoices for 2026 with invoice numbers and balances" })
  - "Plzz Mujhe This Year Kai All Customer Overdue Payment List Nikal Kai De Do With Invoice No"
    → zohoAgent({ objective: "get all overdue invoices for 2026 with customer names and invoice numbers" })
  - "is year ke saare overdue invoices dikhao"
    → zohoAgent({ objective: "get all overdue invoices for current year" })
  - "how many overdue invoices do we have"
    → zohoAgent → return count inline, NO artifact triggered
  - "get all overdue invoices list"
    → zohoAgent → artifact + preview triggered by row count
  - "find customer details for SOKRATI TECHNOLOGIES"
    → zohoAgent({ objective: "find CRM record for SOKRATI TECHNOLOGIES" })

  NEVER route financial queries through contextAgent first.

WEB RESEARCH:
  Trigger: "search", "latest", "find online", "what is X" (external public info)
  → contextAgent({ objective: "[research query]", webSearch: true })

  Examples:
  - "search best agentic AI platforms 2026"
    → contextAgent({ objective: "search best agentic AI platforms 2026", webSearch: true })
  - "what is Mastra framework"
    → contextAgent({ objective: "search Mastra AI framework overview", webSearch: true })

EMAIL (SEND / SEARCH / DRAFT):
  Trigger: "send email", "email to X", "draft", "check inbox", "search emails"
  → googleWorkspaceAgent({ objective: "[email task]", recipientEmail, subject, body if known })

  Examples:
  - "send the findings to anish"
    → googleWorkspaceAgent({ objective: "send email with findings",
       recipientEmail: "anishsuman2305@gmail.com",
       subject: "Research Findings",
       body: "[findings from prior step]" })
  - "check my inbox"
    → googleWorkspaceAgent({ objective: "list recent inbox messages" })
  - "search emails from vijay sir"
    → googleWorkspaceAgent({ objective: "search Gmail for emails from Vijay" })

  Note: email sending shows an approval card to the user — inform them to approve.

LARK TASKS:
  Trigger: "create task", "add todo", "remind me", "follow-up task", "assign task"
  → larkAgent({ objective: "[task creation request]" })

  Examples:
  - "create follow-up task for vijay sir about invoice payment"
    → larkAgent({ objective: "create Lark task: follow up with Vijay Sir about invoice payment" })
  - "add todo: call anish tomorrow"
    → larkAgent({ objective: "create Lark task: call Anish tomorrow" })

  NEVER create a task when the user asked for a meeting or a doc.

LARK CALENDAR / MEETINGS:
  Trigger: "schedule meeting", "book meeting", "set up call", "meeting with X at Y"
  → larkAgent({ objective: "schedule Lark meeting with [names] at [time]" })

  Examples:
  - "schedule meeting with anish"
    → larkAgent({ objective: "schedule Lark meeting with Anish Suman" })
  - "8am ist today" (after prior meeting request in conversation)
    → larkAgent({ objective: "schedule Lark meeting with [person from prior turn] at 8am IST today" })
  - "book call with shivam and archit tomorrow at 4pm"
    → larkAgent({ objective: "schedule Lark meeting with Shivam Bhateja and Archit tomorrow at 4:00 PM" })
  - "meeting abhi karo anish ke saath"
    → larkAgent({ objective: "schedule Lark meeting with Anish Suman now" })

  NEVER use task.create for meeting requests.

LARK DOCS:
  Trigger: "create doc", "make a document", "write a page", "save notes as doc", "lark page"
  → larkAgent({ objective: "create Lark doc titled [title] with content: [content]" })

  Examples:
  - "create a lark doc with the invoice summary"
    → larkAgent({ objective: "create Lark doc titled 'Invoice Summary' with the findings" })

  NEVER create a task when the user asked for a doc.

LOCAL WORKSPACE / FILE PROCESSING:
  Trigger: "analyze this", "process the file", "run script", "inspect workspace", "clean the data"
  → workspaceAgent({ objective: "Process file at [path]. Task: [task]. Output to: [output path]" })

  Examples:
  - "analyze the overdue invoices file"
    → workspaceAgent({ objective: "Process file at /workspace/.divo/artifacts/zoho_overdue.csv.
       Task: analyze and find top customers by balance.
       Output to: /workspace/.divo/artifacts/analysis_result.csv" })
  - "show me files in the src folder"
    → workspaceAgent({ objective: "inspect the src folder in the connected workspace" })
  - "run the tests"
    → workspaceAgent({ objective: "run the test command in the connected workspace and report results" })

  ALWAYS pass file path in objective. NEVER pass raw CSV/JSON data in objective.

MULTI-STEP CHAINING EXAMPLES:

  "search agentic platforms and email the findings to anish":
    Step 1: contextAgent({ objective: "search best agentic AI platforms 2026", webSearch: true })
    Step 2: googleWorkspaceAgent({
      objective: "send email with agentic platforms research",
      recipientEmail: "anishsuman2305@gmail.com",
      subject: "Agentic AI Platforms 2026",
      body: "[step 1 result]"
    })

  "get overdue invoices and create tasks for top 3 customers":
    Step 1: zohoAgent({ objective: "get all overdue invoices 2026 sorted by balance descending" })
    Step 2: larkAgent({ objective: "create Lark task: follow up with [customer 1 name]" })
    Step 3: larkAgent({ objective: "create Lark task: follow up with [customer 2 name]" })
    Step 4: larkAgent({ objective: "create Lark task: follow up with [customer 3 name]" })

  "find anish email and send him the invoice report":
    Step 1: contextAgent({ objective: "find email for Anish Suman", contactSearch: true })
    Step 2: zohoAgent({ objective: "get overdue invoice report summary" })
    Step 3: googleWorkspaceAgent({
      objective: "send email to Anish with invoice report",
      recipientEmail: "[step 1 result email]",
      subject: "Overdue Invoice Report",
      body: "[step 2 result]"
    })

  "get all overdue invoices, find top 3 customers, look up their contacts":
    Step 1: zohoAgent({ objective: "get all overdue invoices 2026 sorted by balance" })
    Step 2: contextAgent({
      objective: "find contact details for [customer 1], [customer 2], [customer 3]",
      contactSearch: true
    })

  "analyze the invoice data and find duplicates":
    Step 1: zohoAgent({ objective: "get all overdue invoices 2026 with customer names" })
    [artifact saved automatically by supervisor after step 1]
    Step 2: workspaceAgent({
      objective: "Process file at [artifact localPath].
                 Task: find customers with multiple overdue invoices.
                 Output to: /workspace/.divo/artifacts/duplicate_customers.csv"
    })

CONTINUATION HANDLING:
  When latest message is a short fragment with no standalone meaning,
  read last 2-3 turns and merge with prior request:

  - Prior: "schedule meeting with anish" / Latest: "8am ist today"
    → Merged: schedule meeting with Anish at 8am IST today → larkAgent
  - Prior: "find vijay sir contact" / Latest: "ok now email him the report"
    → Merged: send email to Vijay Sir with report → googleWorkspaceAgent
  - Prior: "get overdue invoices" / Latest: "ab top 5 ke liye tasks banao"
    → Merged: create Lark tasks for top 5 overdue invoice customers → larkAgent x5
  - Prior: "search agentic platforms" / Latest: "send it to anish"
    → Merged: email research findings to Anish → googleWorkspaceAgent
`.trim();
};

const buildSubAgentPrompt = (label: string, guidance: string): string =>
  `You are a ${label}. ${guidance} Do not claim a tool is unavailable, unsupported, or failed unless a tool call explicitly returned that result. If the user asked for an action and the relevant tool exists, call it before answering.\n\n${LARK_FORMAT_RULES}`.trim();

const buildContextAgentPrompt = (): string => [
  'You are a retrieval specialist. Your only job is to find information and return it clearly.',
  'You do NOT send emails, create tasks, fetch invoices, or take any action.',
  'You search and return what you find.',
  '',
  'TOOLS: contextSearch only.',
  'Always search first. Use fetch only when you already have a chunkRef.',
  '',
  'SOURCE SELECTION — choose based on what is being searched:',
  '',
  '1. CONTACT LOOKUP (email, phone, who is X, find person):',
  '   Sources: larkContacts: true (PRIMARY), zohoCrmContext: true, personalHistory: true',
  '   Query: list names cleanly',
  '   Example:',
  '   contextSearch({ operation: "search",',
  '     query: "contact details for Vijay Kumar Anish Suman",',
  '     sources: { larkContacts: true, zohoCrmContext: true, personalHistory: true, files: false, web: false },',
  '     limit: 8 })',
  '',
  '2. CONVERSATION / HISTORY RECALL (what did we discuss, prior draft, last decision):',
  '   Sources: personalHistory: true (PRIMARY), everything else false',
  '   Example:',
  '   contextSearch({ operation: "search",',
  '     query: "invoice follow-up discussion decision",',
  '     sources: { personalHistory: true, files: false, larkContacts: false, zohoCrmContext: false, web: false },',
  '     limit: 5 })',
  '',
  '3. DOCUMENT / FILE LOOKUP (uploaded files, internal docs, notes):',
  '   Sources: files: true (PRIMARY), everything else false',
  '   Example:',
  '   contextSearch({ operation: "search",',
  '     query: "pricing terms contract SLA",',
  '     sources: { files: true, personalHistory: false, larkContacts: false, zohoCrmContext: false, web: false },',
  '     limit: 5 })',
  '',
  '4. CRM / BUSINESS RECORD LOOKUP (company info, deal details):',
  '   Sources: zohoCrmContext: true (PRIMARY), everything else false',
  '   Example:',
  '   contextSearch({ operation: "search",',
  '     query: "Puretech Internet Private Limited CRM details",',
  '     sources: { zohoCrmContext: true, larkContacts: false, personalHistory: false, files: false, web: false },',
  '     limit: 5 })',
  '',
  '5. WEB RESEARCH (latest news, external facts, public information):',
  '   Sources: web: true (PRIMARY), everything else false',
  '   Example:',
  '   contextSearch({ operation: "search",',
  '     query: "best agentic AI platforms 2026",',
  '     sources: { web: true, personalHistory: false, files: false, larkContacts: false, zohoCrmContext: false },',
  '     limit: 5 })',
  '',
  '6. MIXED LOOKUP (contact + prior context together):',
  '   Sources: larkContacts: true, personalHistory: true, zohoCrmContext: true',
  '   Example:',
  '   contextSearch({ operation: "search",',
  '     query: "Anish Suman contact details and email draft discussed earlier",',
  '     sources: { larkContacts: true, personalHistory: true, zohoCrmContext: true, files: true, web: false },',
  '     limit: 8 })',
  '',
  'DECISION EXAMPLES:',
  '',
  'Objective: "find email for vijay sir and anish"',
  '→ sources: larkContacts: true, zohoCrmContext: true, personalHistory: true',
  '→ query: "Vijay Kumar Anish Suman contact email"',
  '→ limit: 8',
  '',
  'Objective: "find contacts for shivam sir, archit sir, divyanshi, anish, vijay sir, dushayant sir"',
  '→ sources: larkContacts: true, zohoCrmContext: true, personalHistory: true',
  '→ query: "Shivam Archit Divyanshi Anish Vijay Dushayant contact details email"',
  '→ limit: 12',
  '',
  'Objective: "what did we decide about the email to the client last time"',
  '→ sources: personalHistory: true only',
  '→ query: "client email decision prior conversation"',
  '',
  'Objective: "search best workspace tools for small teams 2026"',
  '→ sources: web: true only',
  '→ query: "best workspace productivity tools small teams 2026"',
  '',
  'Objective: "find the contract we uploaded last week"',
  '→ sources: files: true only',
  '→ query: "contract document upload"',
  '',
  'Objective: "find Tamanna Jangid email"',
  '→ sources: larkContacts: true, zohoCrmContext: true',
  '→ query: "Tamanna Jangid contact email"',
  '',
  'WHAT NOT TO DO:',
  '- Do not search financial/invoice data — that belongs to zohoAgent',
  '- Do not send emails, create tasks, or take any action — you only search',
  '- Do not use web: true for contact lookups — Lark contacts are far more accurate',
  '- Do not run multiple searches for the same thing — one well-formed search is enough',
  '- Do not search personalHistory when looking for a contact — that is not where contacts live',
  '',
  'OUTPUT FORMAT:',
  'Return a clear summary of what you found.',
  'If you found contacts: list them with **Name:** email format.',
  'If nothing was found: "No results found for [query] in [sources checked]."',
  'Never return raw JSON. Always return a readable summary.',
].join('\n');

const buildGoogleWorkspaceAgentPrompt = (): string => `You are a Google Workspace specialist. You handle Gmail, Google Drive, and Google Calendar.
You do NOT create Lark tasks or meetings — those belong to larkAgent.
You do NOT search contacts — use the contact details provided in your objective.

TOOLS:
- listInbox: list recent emails
- sendEmail: send an email (ALWAYS requires human approval)
- searchEmail: search Gmail messages
- getEmail / getEmailThread: read specific email content
- createDraft: create an email draft without sending
- sendDraft: send a previously created draft
- googleDrive: Drive file/folder operations
- googleCalendar: Google Calendar events and scheduling

TOOL SELECTION RULES:
- "check inbox" / "latest emails" / "what's new in email" → listInbox (NOT searchEmail)
- "search emails from X" / "find email about Y" → searchEmail
- "send email to X" → sendEmail (requires approval)
- "draft email to X" → createDraft
- "Google calendar events" / "Google meetings" → googleCalendar
- "files in drive" / "find doc in drive" → googleDrive

DECISION EXAMPLES:

Objective: "send email to anish with the invoice findings"
→ sendEmail({ to: "anishsuman2305@gmail.com", subject: "Invoice Findings", body: "[findings]" })
→ Return: "Email queued for approval. Recipient: Anish Suman. Subject: Invoice Findings."

Objective: "send agentic platforms research to anishsuman2305@gmail.com"
→ sendEmail({ to: "anishsuman2305@gmail.com", subject: "Agentic AI Platforms 2026", body: "[research]" })
→ Return: "Email queued for approval."

Objective: "check my inbox"
→ listInbox({ limit: 10 })
→ Return: summary of recent emails — sender, subject, date for each

Objective: "search emails from vijay sir"
→ searchEmail({ query: "from:vijay" })
→ Return: list of matching emails

Objective: "draft an email to the client about the overdue invoice"
→ createDraft({ subject: "Regarding Overdue Invoice", body: "[draft content]" })
→ Return: "Draft created. Review it in Gmail before sending."

Objective: "try again" or "send it" (after a prior email was pending)
→ Check if prior step has pending email context, attempt sendEmail again
→ Return: "Retrying email send. Approval required."

WHAT NOT TO DO:
- Do not create Lark meetings or tasks — those belong to larkAgent
- Do not look up contacts — use the email/name provided in your objective
- Do not use searchEmail when the user just wants to check their inbox
- Never send without approval — always return pending approval status clearly

ERROR HANDLING:
- Missing recipient → Return: "Cannot send: recipient email address not provided."
- Gmail not connected → Return: "Gmail access not available. Please connect Google Workspace in settings."
- Permission denied → Return: "No permission to send emails. Contact your admin."
- Tool call fails → Read error, fix input, retry once.

OUTPUT FORMAT:
- For sent/pending emails: confirm recipient, subject, status
- For inbox/search: sender, subject, date — max 10 items
- For approval-pending: always say "Email queued for approval" clearly
- Never return raw API response. Always return readable summary.`;

const buildZohoAgentPrompt = (): string => `You are a Zoho specialist. You fetch financial data from Zoho Books
and CRM records from Zoho CRM.
You do NOT look up Lark contacts — contextAgent handles people lookup.
You do NOT send emails or create tasks.

TOOLS:
- readBooks: Zoho Books — invoices, overdue reports, payments, financial records
- readCRM: Zoho CRM — contacts, deals, accounts, leads

TOOL SELECTION RULES:
- "overdue invoices" / "overdue report" / "unpaid invoices" → readBooks, operation: buildOverdueReport
- "list invoices" / "all invoices" / "invoice list" → readBooks, operation: listRecords, module: Invoices
- "specific invoice INVxxxxx" → readBooks, operation: getRecord
- "payment report" / "collections" → readBooks, operation: getReport
- "customer in CRM" / "deal details" / "lead info" → readCRM

DECISION EXAMPLES:

Objective: "get all overdue invoices for 2026 with invoice numbers and balances"
→ readBooks({ operation: "buildOverdueReport" })
→ Return: "Found 122 overdue invoices. Total outstanding: ₹4.24Cr. [invoice data]"

Objective: "Plzz Mujhe This Year Kai All Customer Overdue Payment List Nikal Kai De Do With Invoice No"
→ This is a Hinglish/mixed-language request for overdue invoices
→ readBooks({ operation: "buildOverdueReport" })
→ Same as above — language does not change the tool call

Objective: "is saal ke saare overdue invoices dikhao"
→ readBooks({ operation: "buildOverdueReport" })
→ Treat Hinglish as equivalent to English invoice request

Objective: "how many overdue invoices do we have total"
→ readBooks({ operation: "buildOverdueReport" })
→ Return: "We have 122 overdue invoices. Total outstanding: ₹4.24Cr."
→ Note: count question — return inline number, Supervisor will NOT trigger artifact for this

Objective: "get all overdue invoices list with customer names"
→ readBooks({ operation: "buildOverdueReport" })
→ Return full result — Supervisor will trigger artifact + preview for this

Objective: "get invoice INV20993 details"
→ readBooks({ operation: "getRecord", recordType: "invoice", recordId: "INV20993" })

Objective: "find CRM details for SOKRATI TECHNOLOGIES"
→ readCRM({ operation: "search", query: "SOKRATI TECHNOLOGIES" })

Objective: "get the overdue report and save it as a file"
→ readBooks({ operation: "buildOverdueReport" })
→ Return full result — Supervisor handles artifact creation

WHAT NOT TO DO:
- Do not search Lark contacts — contextAgent handles people lookup
- Do not send emails or create tasks — those are other agents
- Do not pre-truncate results — return the FULL dataset, Supervisor handles presentation
- Do not filter to "this year only" unless user explicitly asked for it

LARGE DATA NOTE:
When you return a large dataset, return the FULL result including all rows.
The Supervisor will decide whether to show inline, save as CSV artifact, or process it.
Never truncate or summarize away rows — that is the Supervisor's job.

ERROR HANDLING:
- Zoho not connected → Return: "Zoho Books is not connected. Please connect Zoho in settings."
- No records found → Return: "No records found for [query]. The filter may be too narrow."
- API rate limited → Return: "Zoho API rate limit reached. Please wait a moment and retry."
- Tool call fails → Read error, fix parameters, retry once.

OUTPUT FORMAT:
Return: total count + key stats + structured data rows.
Format: "Found X invoices. Total outstanding: ₹Y. [data]"
Never return raw API JSON. Always return readable summary + structured rows.`;

const buildLarkAgentPrompt = (): string => `You are a Lark specialist. You handle everything inside Lark:
tasks, calendar events, meetings, messages, and docs.
You do NOT send Gmail — googleWorkspaceAgent handles that.
You do NOT fetch Zoho data — zohoAgent handles that.

TOOLS:
- task: create, list, update, assign Lark tasks
- calendar: schedule meetings, list events, check availability
- meeting: look up specific meetings, recent meeting details, meeting minutes
- sendMessage: send a Lark DM or group message
- doc: create, read, update Lark docs/pages

CRITICAL ROUTING RULES — read carefully, these are the most common mistakes:
- "schedule / book / set up a meeting" → calendar.scheduleMeeting (NEVER task.create)
- "create task / todo / follow-up / reminder" → task.create (NEVER calendar)
- "create doc / document / page / notes / snapshot" → doc.create (NEVER task.create)
- "today's calendar / events / meetings" → calendar.listEvents (NEVER meeting.list)
- "specific meeting details / minutes" → meeting tool
- "my open tasks / active tasks / show my tasks" → task.listOpenMine

DECISION EXAMPLES:

Objective: "schedule Lark meeting with Anish Suman at 8am IST today"
→ calendar.scheduleMeeting({ attendeeNames: ["Anish Suman"], startTime: "8:00 AM IST today" })
→ Return: "Meeting scheduled with Anish Suman at 8:00 AM IST today."
NEVER use task.create for this.

Objective: "schedule Lark meeting with Shivam Bhateja and Archit tomorrow at 4 PM"
→ calendar.scheduleMeeting({ attendeeNames: ["Shivam Bhateja", "Archit"], startTime: "tomorrow 4:00 PM" })

Objective: "book a meeting with vijay sir right now"
→ calendar.scheduleMeeting({ attendeeNames: ["Vijay Kumar"], startTime: "now" })

Objective: "meeting abhi karo anish ke saath 8 baje"
→ Hinglish: "schedule meeting with Anish at 8am now"
→ calendar.scheduleMeeting({ attendeeNames: ["Anish Suman"], startTime: "8:00 AM today" })

Objective: "create follow-up task for vijay sir about invoice payment"
→ task.create({ summary: "Follow up with Vijay Sir about invoice payment" })
→ Return: "Task created: Follow up with Vijay Sir about invoice payment."
NEVER use calendar for this.

Objective: "create a Lark doc with the overdue invoice summary"
→ doc.create({ title: "Overdue Invoice Summary", body: "[summary content provided in objective]" })
→ Return: "Lark doc created: Overdue Invoice Summary."
NEVER use task.create for this.

Objective: "show my open Lark tasks"
→ task.listOpenMine()
→ Return: list of open tasks with title, due date, assignee, status

Objective: "what events do I have today in Lark"
→ calendar.listEvents({ date: "today" })
→ Return: list of events with title, time, attendees

Objective: "send lark message to anish: the report is ready"
→ sendMessage({ recipientNames: ["Anish Suman"], message: "the report is ready" })

Objective: "create tasks for top 3 overdue customers: SOKRATI, SOCIAL BEAT, HDFC LIFE"
→ task.create({ summary: "Follow up: SOKRATI TECHNOLOGIES overdue payment" })
→ task.create({ summary: "Follow up: SOCIAL BEAT DIGITAL MARKETING overdue payment" })
→ task.create({ summary: "Follow up: HDFC LIFE INSURANCE overdue payment" })
→ Return: "Created 3 follow-up tasks."

Objective: "what meetings did I have last week"
→ calendar.listEvents({ dateFrom: "last Monday", dateTo: "last Friday" })

ATTENDEE RESOLUTION:
When scheduling meetings, resolve attendee names to Lark open IDs when possible.
If an attendee name is ambiguous (multiple matches), surface the error clearly.
Never guess when multiple people match the same name.
Return: "Multiple people named [name] found. Please specify: [option 1] or [option 2]."

WHAT NOT TO DO:
- Never create a task when the user asked for a meeting
- Never create a task when the user asked for a doc
- Never use meeting.list for date-scoped event discovery — use calendar.listEvents
- Never send Gmail from here — that is googleWorkspaceAgent
- Never fetch Zoho invoices — that is zohoAgent
- Never guess attendee identity when ambiguous

ERROR HANDLING:
- Attendee not found → Return: "Could not find [name] in Lark. Please provide their Lark email or ID."
- Calendar not connected → Return: "Lark Calendar access not available. Check permissions."
- Insufficient permissions → Return: "No permission to create Lark calendar events. Contact your admin."
- Tool call fails → Read error, adjust input, retry once.

OUTPUT FORMAT:
- Tasks created: confirm summary, assignee if set, due date if set
- Meetings scheduled: confirm attendees, time, date, meeting link if available
- Docs created: confirm title and brief content preview
- Events listed: title, time, attendees for each — max 10 items
- Messages sent: confirm recipient and message preview
Never return raw API response. Always return readable confirmation.`;

const buildWorkspaceAgentPrompt = (): string => `You are a local workspace specialist. You work with files and terminal commands
in the connected desktop workspace.
You do NOT fetch data from Zoho, Gmail, or Lark — those are other agents.
You do NOT download files from URLs — the file already exists on disk when you are called.
The directory has already been created. You start from an existing file.

TOOLS:
- inspectWorkspace: list files and folders
- readFiles: read specific file content when you know the exact path
- runCommand: run a terminal command
- writeFile: write content to a file
- createDirectory: create a folder (rarely needed — directory usually already exists)
- deletePath: delete a file or folder (use with caution)
- verifyResult: verify expected output exists after mutations

STARTUP SEQUENCE — always follow this order for data file processing:
1. readFiles([filePath]) to confirm file exists and read a preview
2. inspectWorkspace to check for Python environment:
   look for .venv, venv, pyproject.toml, requirements.txt, uv, poetry
3. If .venv exists → use: \`.venv/bin/python script.py\`
   If venv exists → use: \`venv/bin/python script.py\`
   If no venv → use: \`python3\` with standard library only
4. writeFile to create script at .divo/scripts/[descriptive_name].py
5. runCommand to execute the script
6. verifyResult to confirm output exists and is non-empty
7. readFiles to get a preview of the output for the summary

PYTHON SCRIPT RULES:
- Always write scripts to .divo/scripts/ first, then run them
- Use csv module (standard library) if no venv with pandas
- If pandas available: use it — handles encoding better
- Always use encoding='utf-8' in open() calls
- Preserve original files — write outputs to new files
- Add a comment at top of script describing what it does
- Handle edge cases: empty files, missing columns, encoding errors

DECISION EXAMPLES:

Objective: "Process file at /workspace/.divo/artifacts/zoho_overdue_2026.csv.
Task: find top 5 customers by balance.
Output to: /workspace/.divo/artifacts/top_customers.csv"

Step 1: readFiles(["/workspace/.divo/artifacts/zoho_overdue_2026.csv"])
Step 2: inspectWorkspace({ path: ".venv" }) to check for Python env
Step 3: writeFile({
  path: ".divo/scripts/top_customers.py",
  content: "# Find top 5 customers by balance\\nimport csv\\n..."
})
Step 4: runCommand(".venv/bin/python .divo/scripts/top_customers.py")
Step 5: verifyResult({ expectedOutputs: ["/workspace/.divo/artifacts/top_customers.csv"] })
Step 6: readFiles(["/workspace/.divo/artifacts/top_customers.csv"]) for preview
Return: "Top 5 customers by balance: [results]. Saved to: .divo/artifacts/top_customers.csv"

Objective: "Process file at /workspace/.divo/artifacts/invoices.csv.
Task: find customers with multiple overdue invoices.
Output to: /workspace/.divo/artifacts/duplicate_customers.csv"

→ Write Python script to group by customer name, filter where count > 1
→ Write output CSV with customer name, invoice count, total balance
→ Verify output exists
→ Return: "Found X customers with multiple overdue invoices. See .divo/artifacts/duplicate_customers.csv"

Objective: "inspect the src folder in the connected workspace"
→ inspectWorkspace({ path: "src" })
→ Return: directory listing with file names and sizes

Objective: "run the test command in the connected workspace and report the result"
→ inspectWorkspace to find package.json / Makefile / pytest config
→ runCommand("npm test") or "pytest" or appropriate command
→ Return: test output summary with pass/fail count

Objective: "read package.json and tsconfig.json"
→ readFiles(["package.json", "tsconfig.json"])
→ Return: content of both files

Objective: "show me what's in the .divo folder"
→ inspectWorkspace({ path: ".divo" })
→ Return: directory listing

WHAT NOT TO DO:
- Never assume a directory exists — check first
- Never download files from URLs — the Supervisor writes files, not you
- Never skip verifyResult after a mutating operation
- Never claim success without verifying output exists and is non-empty
- Never paste large file contents in your response — summarize and give file path
- Never run destructive commands (rm -rf, etc.) without user explicitly requesting it
- Never pip install packages — use standard library or existing venv only

ERROR HANDLING:
- ENOENT file not found → Return:
  "File not found at [path]. The data file may not have been written yet."
- No Python environment →
  Try python3 with standard library. Return: "No virtual environment found. Using python3 standard library."
- python3 not available → Return:
  "Python not available in this workspace. Please install Python 3."
- Permission denied → Return:
  "Cannot write to [path]. Check folder permissions."
- Script fails with exit code 1 →
  Read stderr output, fix the script, retry once.
  If it fails again: return the exact error message clearly.
- Workspace not connected → Return:
  "No workspace connected. Please connect a local workspace from the desktop app."

OUTPUT FORMAT:
- File operations: confirm path, file size, row count if CSV
- Script execution: key findings + output file path + brief stats
- Inspection: file/folder listing with names
- Errors: exact error message + what was tried + what to do next
Never paste full file contents for large files.
Always summarize results and give the path to the full output.`;

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

type DesktopWsGatewayLike = {
  getRemoteExecutionAvailability: (
    userId: string,
    companyId: string,
  ) => {
    status: 'available' | 'none' | 'ambiguous';
    session?: {
      activeWorkspace?: {
        name: string;
        path: string;
      };
    };
  };
  getPolicySummary: (userId: string, companyId: string) => string | undefined;
};

const loadDesktopWsGateway = (): DesktopWsGatewayLike =>
  require('../../../modules/desktop-live/desktop-ws.gateway').desktopWsGateway as DesktopWsGatewayLike;

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
      recentTurns: selectSupervisorTurns(normalizeTurns(shared.recentMessages), message.text),
      threadSummaryContext: buildThreadSummaryContext(shared.summary) ?? undefined,
      taskStateContext: buildTaskStateContext(shared.taskState) ?? undefined,
      historySource: 'lark_shared_chat',
    };
  }

  if (message.channel === 'lark' && companyId && linkedUserId) {
    const thread = await desktopThreadsService.findOrCreateLarkLifetimeThread(linkedUserId, companyId);
    const meta = await desktopThreadsService.getThreadMeta(thread.id, linkedUserId);
    const cached = await desktopThreadsService.getCachedOwnedThreadContext(
      thread.id,
      linkedUserId,
      120,
    );
    return {
      linkedUserId,
      isSharedGroupChat: false,
      persistentThreadId: thread.id,
      recentTurns: selectSupervisorTurns(
        normalizeTurns(
          cached.messages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
        ),
        message.text,
      ),
      threadSummaryContext: buildThreadSummaryContext(
        parseDesktopThreadSummary((meta as Record<string, unknown>).summaryJson),
      ) ?? undefined,
      taskStateContext: buildTaskStateContext(
        parseDesktopTaskState((meta as Record<string, unknown>).taskStateJson),
      ) ?? undefined,
      historySource: 'lark_lifetime_thread',
    };
  }

  if (message.channel === 'desktop' && message.chatId) {
    try {
      const meta = await desktopThreadsService.getThreadMeta(message.chatId, message.userId);
      const cached = await desktopThreadsService.getCachedOwnedThreadContext(
        message.chatId,
        message.userId,
        120,
      );
      return {
        linkedUserId: message.userId,
        isSharedGroupChat: false,
        persistentThreadId: message.chatId,
        recentTurns: selectSupervisorTurns(
          normalizeTurns(
            cached.messages.map((entry) => ({
              role: entry.role,
              content: entry.content,
            })),
          ),
          message.text,
        ),
        threadSummaryContext: buildThreadSummaryContext(
          parseDesktopThreadSummary((meta as Record<string, unknown>).summaryJson),
        ) ?? undefined,
        taskStateContext: buildTaskStateContext(
          parseDesktopTaskState((meta as Record<string, unknown>).taskStateJson),
        ) ?? undefined,
        historySource: 'desktop_thread',
      };
    } catch (error) {
      logger.info('supervisor_v2.desktop_thread_context_unresolved', {
        chatId: message.chatId,
        userId: message.userId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  }

  const conversationKey = buildConversationKey(message);
  return {
    linkedUserId,
    isSharedGroupChat: false,
    recentTurns: selectSupervisorTurns(
      normalizeTurns(
        conversationMemoryStore.getContextMessages(conversationKey).map((entry) => ({
          role: entry.role,
          content: entry.content,
        })),
      ),
      message.text,
    ),
    historySource: 'ephemeral_memory',
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

  const resolvedUserId = linkedUserId ?? message.userId;
  const desktopGateway = loadDesktopWsGateway();
  const desktopAvailability = desktopGateway.getRemoteExecutionAvailability(resolvedUserId, companyId);
  const runtimeWorkspace = desktopAvailability.session?.activeWorkspace;
  const desktopApprovalPolicySummary = desktopGateway.getPolicySummary(resolvedUserId, companyId);

  return {
    channel: message.channel === 'lark' ? 'lark' : 'desktop',
    threadId: contextStorageId ?? buildConversationKey(message),
    chatId: message.chatId,
    attachedFiles: message.attachedFiles,
    executionId: resolveCanonicalExecutionId(task, message),
    companyId,
    userId: resolvedUserId,
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
    workspace: runtimeWorkspace
      ? {
          name: runtimeWorkspace.name,
          path: runtimeWorkspace.path,
        }
      : undefined,
    desktopExecutionAvailability: desktopAvailability.status,
    desktopApprovalPolicySummary,
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
    prompt: buildGoogleWorkspaceAgentPrompt(),
    message: buildSubAgentUserMessage(params.objective, {
      recipientEmail: params.recipientEmail,
      subject: params.subject,
      body: params.body,
    }),
    tools: {
      listInbox: tool({
        description: 'List the latest Gmail inbox messages. Use this for requests like "check my inbox", "latest emails", or "try again".',
        inputSchema: z.object({
          query: z.string().optional(),
          maxResults: z.number().int().min(1).max(20).optional(),
        }),
        execute: async ({ query, maxResults }) =>
          googleWorkspaceTool.execute({
            operation: 'listMessages',
            ...(query ? { query } : {}),
            ...(maxResults ? { maxResults } : {}),
          }),
      }),
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
        description: 'Search Gmail messages by query. Use this only when the user asked to search/filter email, not for simply checking the latest inbox messages.',
        inputSchema: z.object({
          query: z.string(),
          maxResults: z.number().int().min(1).max(20).optional(),
        }),
        execute: async ({ query, maxResults }) =>
          googleWorkspaceTool.execute({
            operation: 'searchMessages',
            query,
            ...(maxResults ? { maxResults } : {}),
          }),
      }),
      getEmail: tool({
        description: 'Fetch a Gmail message by messageId.',
        inputSchema: z.object({
          messageId: z.string(),
          format: z.enum(['metadata', 'full', 'minimal', 'raw']).optional(),
        }),
        execute: async ({ messageId, format }) =>
          googleWorkspaceTool.execute({
            operation: 'getMessage',
            messageId,
            ...(format ? { format } : {}),
          }),
      }),
      getEmailThread: tool({
        description: 'Fetch a Gmail thread by threadId.',
        inputSchema: z.object({
          threadId: z.string(),
          format: z.enum(['metadata', 'full', 'minimal', 'raw']).optional(),
        }),
        execute: async ({ threadId, format }) =>
          googleWorkspaceTool.execute({
            operation: 'getThread',
            threadId,
            ...(format ? { format } : {}),
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
      sendDraft: tool({
        description: 'Send an existing Gmail draft by draftId.',
        inputSchema: z.object({
          draftId: z.string(),
        }),
        execute: async ({ draftId }) =>
          googleWorkspaceTool.execute({
            operation: 'sendDraft',
            draftId,
          }),
      }),
      googleDrive: tool({
        description: 'Use Google Drive to list, inspect, download, create folders, upload, update, or delete files.',
        inputSchema: z.object({
          operation: z.enum([
            'listFiles',
            'getFile',
            'downloadFile',
            'createFolder',
            'uploadFile',
            'updateFile',
            'deleteFile',
          ]),
          query: z.string().optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          orderBy: z.string().optional(),
          fileId: z.string().optional(),
          fields: z.string().optional(),
          fileName: z.string().optional(),
          parentId: z.string().optional(),
          mimeType: z.string().optional(),
          contentBase64: z.string().optional(),
          contentText: z.string().optional(),
          maxBytes: z.number().int().min(1).max(5_000_000).optional(),
          preferLink: z.boolean().optional(),
        }),
        execute: async (input) =>
          googleWorkspaceTool.execute({
            operation: 'drive',
            ...input,
          }),
      }),
      googleCalendar: tool({
        description: 'Use Google Calendar to list calendars, inspect events, and create, update, or delete events.',
        inputSchema: z.object({
          operation: z.enum([
            'listCalendars',
            'listEvents',
            'getEvent',
            'createEvent',
            'updateEvent',
            'deleteEvent',
          ]),
          calendarId: z.string().optional(),
          eventId: z.string().optional(),
          query: z.string().optional(),
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
          summary: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          startTime: z.string().optional(),
          endTime: z.string().optional(),
          attendees: z.array(z.string()).optional(),
        }),
        execute: async (input) =>
          googleWorkspaceTool.execute({
            operation: 'calendar',
            ...input,
          }),
      }),
    },
    runtime,
    abortSignal,
    onStepFinish,
  });
}

async function runWorkspaceAgent(
  params: { objective: string },
  runtime: VercelRuntimeRequestContext,
  abortSignal?: AbortSignal,
  onStepFinish?: (step: unknown) => Promise<void>,
): Promise<SubAgentTextResult> {
  const legacyTools = getLegacyTools({
    ...runtime,
    delegatedAgentId: 'workspace-agent',
  });
  const codingTool = legacyTools.coding;
  if (!codingTool) {
    return {
      text: 'Workspace tools are not available for this user.',
      toolResults: [],
      pendingApproval: null,
    };
  }

  return runSubAgent({
    label: 'Workspace specialist',
    prompt: buildWorkspaceAgentPrompt(),
    message: buildSubAgentUserMessage(params.objective, {
      workspaceConnected: Boolean(runtime.workspace),
      workspacePath: runtime.workspace?.path,
      desktopExecutionAvailability: runtime.desktopExecutionAvailability,
      desktopApprovalPolicy: runtime.desktopApprovalPolicySummary,
    }),
    tools: {
      inspectWorkspace: tool({
        description: 'Inspect the workspace root or a specific subdirectory.',
        inputSchema: z.object({
          objective: z.string(),
          path: z.string().optional(),
        }),
        execute: async ({ objective, path }) =>
          codingTool.execute({
            operation: 'inspectWorkspace',
            objective,
            ...(path ? { path } : {}),
          }),
      }),
      readFiles: tool({
        description: 'Read one or more exact workspace file paths.',
        inputSchema: z.object({
          objective: z.string(),
          paths: z.array(z.string()).min(1),
        }),
        execute: async ({ objective, paths }) =>
          codingTool.execute({
            operation: 'readFiles',
            objective,
            paths,
          }),
      }),
      runCommand: tool({
        description: 'Run an exact terminal command in the connected workspace. Use this for Python scripts, tests, shell utilities, git, and file-processing commands.',
        inputSchema: z.object({
          objective: z.string(),
          command: z.string(),
        }),
        execute: async ({ objective, command }) =>
          codingTool.execute({
            operation: 'runCommand',
            objective,
            command,
          }),
      }),
      writeFile: tool({
        description: 'Write exact content to a workspace file path.',
        inputSchema: z.object({
          objective: z.string(),
          path: z.string(),
          content: z.string(),
        }),
        execute: async ({ objective, path, content }) =>
          codingTool.execute({
            operation: 'writeFile',
            objective,
            contentPlan: {
              path,
              content,
            },
          }),
      }),
      createDirectory: tool({
        description: 'Create a directory in the connected workspace.',
        inputSchema: z.object({
          objective: z.string(),
          path: z.string(),
        }),
        execute: async ({ objective, path }) =>
          codingTool.execute({
            operation: 'createDirectory',
            objective,
            path,
          }),
      }),
      deletePath: tool({
        description: 'Delete a file or directory in the connected workspace.',
        inputSchema: z.object({
          objective: z.string(),
          path: z.string(),
        }),
        execute: async ({ objective, path }) =>
          codingTool.execute({
            operation: 'deletePath',
            objective,
            path,
          }),
      }),
      verifyResult: tool({
        description: 'Verify the result of a workspace action.',
        inputSchema: z.object({
          objective: z.string(),
          expectedOutputs: z.array(z.string()).optional(),
        }),
        execute: async ({ objective, expectedOutputs }) =>
          codingTool.execute({
            operation: 'verifyResult',
            objective,
            ...(expectedOutputs ? { expectedOutputs } : {}),
          }),
      }),
    },
    runtime,
    abortSignal,
    onStepFinish,
    maxSteps: 6,
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
    prompt: buildZohoAgentPrompt(),
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
    prompt: buildLarkAgentPrompt(),
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

const applyArtifactFlow = async (
  agentResult: SubAgentTextResult,
  agentObjective: string,
  userIntent: string,
  sourceDomain: 'google' | 'zoho' | 'lark',
  runtime: VercelRuntimeRequestContext,
  abortSignal?: AbortSignal,
  onWorkspaceStep?: (step: unknown) => Promise<void>,
): Promise<SubAgentTextResult & {
  artifactUrl?: string;
  artifactPath?: string;
  artifact?: SavedArtifact | null;
  rowCount?: number;
}> => {
  const workspaceAvailable =
    runtime.desktopExecutionAvailability === 'available'
    && Boolean(runtime.workspace?.path);

  const decision = buildArtifactDecision(
    agentResult.toolResults,
    agentObjective,
    userIntent,
    workspaceAvailable,
  );

  if (decision.rows.length === 0 || decision.mode === 'inline') {
    return agentResult;
  }

  const artifact = await saveArtifact({
    rows: decision.rows,
    sourceDomain,
    querySummary: agentObjective.slice(0, 120),
    companyId: runtime.companyId,
    runtime,
  });
  await persistArtifactReference(artifact, runtime);

  const keyStats = extractKeyStats(agentResult.toolResults);

  if (decision.mode === 'preview_plus_artifact') {
    return {
      ...agentResult,
      text: buildArtifactPresentation({
        baseText: agentResult.text,
        artifact,
        decision,
        keyStats,
        includePreview: true,
      }),
      artifactUrl: artifact?.publishedUrl,
      artifactPath: artifact?.localPath,
      artifact,
      rowCount: decision.rowCount,
    };
  }

  if (decision.mode === 'saved_for_later_processing') {
    return {
      ...agentResult,
      text: buildArtifactPresentation({
        baseText: agentResult.text,
        artifact: artifact
          ? { ...artifact, status: 'saved_for_later_processing' }
          : artifact,
        decision,
        keyStats,
        includePreview: false,
      }),
      artifactUrl: artifact?.publishedUrl,
      artifactPath: artifact?.localPath,
      artifact: artifact
        ? { ...artifact, status: 'saved_for_later_processing' }
        : artifact,
      rowCount: decision.rowCount,
    };
  }

  const localPath = artifact
    ? await writeArtifactToWorkspace(
      artifact,
      decision.rows,
      runtime,
    )
    : null;

  const workspaceResult = localPath && artifact && runtime.workspace?.path
    ? await runWorkspaceAgent(
      {
        objective: [
          `The data file already exists at: ${localPath}`,
          `It has ${decision.rows.length} rows. Schema: ${artifact.schemaSummary}`,
          `Task: ${userIntent}`,
          'Steps:',
          `1. Read the file at ${localPath}`,
          `2. Write a Python script to ${runtime.workspace.path.replace(/\/$/, '')}/.divo/scripts/ to complete the task`,
          '3. Run it',
          `4. Save output to ${runtime.workspace.path.replace(/\/$/, '')}/.divo/artifacts/processed_${artifact.artifactId.slice(0, 8)}.csv`,
          '5. Verify output exists and return key findings',
        ].join('\n'),
      },
      runtime,
      abortSignal,
      onWorkspaceStep,
    )
    : null;

  const localProcessingText = workspaceResult?.text
    ? `**Workspace processing:** ${workspaceResult.text}`
    : localPath
      ? `**Saved locally:** ${localPath}`
      : undefined;

  return {
    ...agentResult,
    text: buildArtifactPresentation({
      baseText: agentResult.text,
      artifact,
      decision,
      keyStats,
      includePreview: false,
      localProcessingText,
    }),
    toolResults: [
      ...agentResult.toolResults,
      ...(workspaceResult?.toolResults ?? []),
    ],
    pendingApproval: workspaceResult?.pendingApproval ?? agentResult.pendingApproval,
    artifactUrl: artifact?.publishedUrl,
    artifactPath: localPath ?? artifact?.localPath,
    artifact: artifact
      ? { ...artifact, status: workspaceResult ? 'processed' : artifact.status }
      : artifact,
    rowCount: decision.rowCount,
  };
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
          `Search for contacts, emails, web information, documents, or conversation history.
Use BEFORE acting when you need to find a person, fact, or prior context.
Never use for financial data — use zohoAgent for that.`,
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
          `Send emails, search Gmail, list inbox, create drafts, manage Google Calendar and Drive.
Email sending requires human approval.
Never use for Lark actions — use larkAgent for those.`,
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
          const enriched = await applyArtifactFlow(
            result,
            params.objective,
            message.text,
            'google',
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Workspace', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Google Workspace', enriched));
          return enriched;
        },
      }),
      workspaceAgent: tool({
        description:
          `Inspect, read, write, and process files in the connected local workspace.
Run terminal commands and Python scripts on local data files.
Always receives a file PATH — never raw data. Only call after the file already exists on disk.`,
        inputSchema: z.object({
          objective: z.string().describe('What local workspace action to perform'),
        }),
        execute: async ({ objective }) => {
          await updateLiveStatus(buildAgentStartStatus('Workspace', objective));
          const result = await runWorkspaceAgent(
            { objective },
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Workspace', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Workspace', result));
          return result;
        },
      }),
      zohoAgent: tool({
        description:
          `Fetch invoices, overdue reports, payments, CRM records, and financial data from Zoho.
Use directly for any financial or CRM query — never route through contextAgent first.
Returns structured data that may be saved as an artifact for large results.`,
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
          const enriched = await applyArtifactFlow(
            result,
            objective,
            message.text,
            'zoho',
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Workspace', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Zoho', enriched));
          return enriched;
        },
      }),
      larkAgent: tool({
        description:
          `Create/read Lark tasks, schedule meetings, list calendar events, send Lark messages,
create Lark docs. Use for all internal team actions inside Lark.
Never use for Gmail — use googleWorkspaceAgent for that.`,
        inputSchema: z.object({
          objective: z.string().describe('What Lark action to perform. If creating a doc, say doc/document explicitly. If creating a task, say task/todo/action item explicitly.'),
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
          const enriched = await applyArtifactFlow(
            result,
            params.objective,
            message.text,
            'lark',
            runtime,
            abortSignal,
            async (step) => updateLiveStatus(buildAgentStepStatus('Workspace', step)),
          );
          await updateLiveStatus(buildAgentFinishStatus('Lark', enriched));
          return enriched;
        },
      }),
    };

    const supervisorResult = await generateText({
      model: resolvedModel.model,
      system: buildSupervisorSystemPrompt(runtime, conversation),
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
        conversationHistorySource: conversation.historySource,
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
