import { createVercelDesktopTools } from '../vercel/tools';
import type {
  PendingApprovalAction,
  VercelCitation,
  VercelRuntimeRequestContext,
  VercelRuntimeToolHooks,
  VercelToolEnvelope,
} from '../vercel/types';
import type { GraphToolResult } from './runtime.tool-contract';

export type GraphToolFamily =
  | 'webSearch'
  | 'docSearch'
  | 'documentOcrRead'
  | 'invoiceParser'
  | 'statementParser'
  | 'skillSearch'
  | 'repo'
  | 'coding'
  | 'googleMail'
  | 'googleDrive'
  | 'googleCalendar'
  | 'zoho'
  | 'booksRead'
  | 'booksWrite'
  | 'outreach'
  | 'larkTask'
  | 'larkCalendar'
  | 'larkMeeting'
  | 'larkApproval'
  | 'larkDoc'
  | 'larkBase';

export const GRAPH_TOOL_FAMILY_MAP: Record<GraphToolFamily, string[]> = {
  webSearch: ['search-read', 'search-agent'],
  docSearch: ['search-documents'],
  documentOcrRead: ['document-ocr-read'],
  invoiceParser: ['invoice-parser'],
  statementParser: ['statement-parser'],
  skillSearch: ['skill-search'],
  repo: ['repo'],
  coding: ['coding'],
  googleMail: ['google-gmail'],
  googleDrive: ['google-drive'],
  googleCalendar: ['google-calendar'],
  zoho: ['search-zoho-context', 'read-zoho-records', 'zoho-agent', 'zoho-write'],
  booksRead: ['zoho-books-read', 'zoho-books-agent'],
  booksWrite: ['zoho-books-write', 'zoho-books-agent'],
  outreach: ['read-outreach-publishers', 'outreach-agent'],
  larkTask: ['lark-task-read', 'lark-task-write', 'lark-task-agent'],
  larkCalendar: ['lark-calendar-list', 'lark-calendar-read', 'lark-calendar-write', 'lark-calendar-agent'],
  larkMeeting: ['lark-meeting-read', 'lark-meeting-agent'],
  larkApproval: ['lark-approval-read', 'lark-approval-write', 'lark-approval-agent'],
  larkDoc: ['create-lark-doc', 'edit-lark-doc', 'lark-doc-agent'],
  larkBase: ['lark-base-read', 'lark-base-write', 'lark-base-agent'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeApproval = (toolName: string, pending: PendingApprovalAction): GraphToolResult => {
  if (pending.kind === 'tool_action') {
    return {
      kind: 'approval_required',
      summary: pending.summary,
      pendingAction: {
        toolId: pending.toolId,
        actionGroup: pending.actionGroup,
        title: pending.title,
        subject: pending.subject,
        payload: pending.payload,
        metadata: {
          operation: pending.operation,
          explanation: pending.explanation,
        },
      },
    };
  }

  return {
    kind: 'approval_required',
    summary: pending.title ?? `Approval required to continue ${toolName}.`,
    pendingAction: {
      toolId: pending.toolId ?? toolName,
      actionGroup: pending.actionGroup ?? 'execute',
      title: pending.title ?? `Approve ${toolName}`,
      subject: pending.subject,
      payload: isRecord(pending) ? pending : {},
      metadata: {
        kind: pending.kind,
        explanation: pending.explanation,
      },
    },
  };
};

export const toGraphToolResult = (toolName: string, output: unknown): GraphToolResult => {
  const envelope = (output ?? {}) as VercelToolEnvelope;
  if (envelope.pendingApprovalAction) {
    return normalizeApproval(toolName, envelope.pendingApprovalAction);
  }
  if (envelope.success) {
    return {
      kind: 'success',
      summary: envelope.summary,
      output: envelope.fullPayload ?? envelope.keyData ?? {},
      citations: (envelope.citations ?? []) as Array<Record<string, unknown>>,
    };
  }
  if (envelope.errorKind === 'permission') {
    return {
      kind: 'authorization_failed',
      summary: envelope.summary,
      reason: envelope.summary,
    };
  }
  if (envelope.errorKind === 'missing_input' || envelope.errorKind === 'validation' || envelope.errorKind === 'unsupported') {
    return {
      kind: 'validation_failed',
      summary: envelope.summary,
      reason: envelope.errorKind,
      details: {
        userAction: envelope.userAction,
      },
    };
  }
  return {
    kind: 'error',
    summary: envelope.summary ?? `${toolName} failed.`,
    retriable: envelope.retryable ?? false,
    reason: envelope.errorKind ?? 'tool_failed',
    details: {
      userAction: envelope.userAction,
    },
  };
};

export const isGraphToolFamilyAvailable = (
  runtime: VercelRuntimeRequestContext,
  family: GraphToolFamily,
): boolean => GRAPH_TOOL_FAMILY_MAP[family].some((toolId) => runtime.allowedToolIds.includes(toolId));

export class GraphToolFacade {
  private readonly tools: Record<string, any>;

  constructor(
    private readonly runtime: VercelRuntimeRequestContext,
    hooks: VercelRuntimeToolHooks,
  ) {
    this.tools = createVercelDesktopTools(runtime, hooks);
  }

  selectFamilies(families: GraphToolFamily[]): Record<string, any> {
    return Object.fromEntries(
      families
        .filter((family) => isGraphToolFamilyAvailable(this.runtime, family))
        .map((family) => [family, this.tools[family]])
        .filter(([, tool]) => Boolean(tool)),
    );
  }

  async invoke(family: GraphToolFamily, input: Record<string, unknown>): Promise<GraphToolResult> {
    const tool = this.tools[family];
    if (!tool || typeof tool.execute !== 'function') {
      return {
        kind: 'validation_failed',
        summary: `Tool family "${family}" is not registered.`,
        reason: 'tool_not_registered',
      };
    }
    const output = await tool.execute(input);
    return toGraphToolResult(family, output);
  }
}

export const collectGraphCitations = (output: unknown): VercelCitation[] =>
  Array.isArray((output as VercelToolEnvelope | undefined)?.citations)
    ? ((output as VercelToolEnvelope).citations ?? [])
    : [];
