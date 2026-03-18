import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { tool } from 'ai';
import { z } from 'zod';

import { conversationMemoryStore } from '../../state/conversation';
import { logger } from '../../../utils/logger';
import { skillService } from '../../skills/skill.service';
import { getSupportedToolActionGroups, type ToolActionGroup } from '../../tools/tool-action-groups';
import { companyGoogleAuthLinkRepository } from '../../channels/google/company-google-auth-link.repository';
import { googleOAuthService } from '../../channels/google/google-oauth.service';
import { googleUserAuthLinkRepository } from '../../channels/google/google-user-auth-link.repository';
import type {
  PendingApprovalAction,
  VercelCitation,
  VercelRuntimeRequestContext,
  VercelRuntimeToolHooks,
  VercelToolEnvelope,
} from './types';
import {
  discoverRepositories,
  inspectRepository,
  retrieveRepositoryFile,
} from './repo-tool';

type LarkOperationalConfigLike = {
  findByCompanyId: (companyId: string) => Promise<{
    defaultBaseAppToken?: string;
    defaultBaseTableId?: string;
    defaultBaseViewId?: string;
    defaultTasklistId?: string;
    defaultCalendarId?: string;
    defaultApprovalCode?: string;
  } | null>;
};

const loadModuleExport = <T>(modulePath: string, exportName: string): T => {
  const moduleRecord = require(modulePath) as Record<string, unknown>;
  return moduleRecord[exportName] as T;
};

const loadLarkDocsService = (): {
  createMarkdownDoc: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  editMarkdownDoc: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  inspectDocument: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readDocument: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-docs.service', 'larkDocsService');

const loadLarkTasksService = (): {
  listTasklists: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listTasks: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  createTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteTask: (input: Record<string, unknown>) => Promise<void>;
} => loadModuleExport('../../channels/lark/lark-tasks.service', 'larkTasksService');

const loadLarkCalendarService = (): {
  getPrimaryCalendar: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listCalendars: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listEvents: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  createEvent: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateEvent: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteEvent: (input: Record<string, unknown>) => Promise<void>;
} => loadModuleExport('../../channels/lark/lark-calendar.service', 'larkCalendarService');

const loadLarkMeetingsService = (): {
  listMeetings: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getMeeting: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-meetings.service', 'larkMeetingsService');

const loadLarkMinutesService = (): {
  getMinute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-minutes.service', 'larkMinutesService');

const loadLarkApprovalsService = (): {
  listInstances: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getInstance: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createInstance: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-approvals.service', 'larkApprovalsService');

const loadLarkBaseService = (): {
  listApps: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listTables: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listViews: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listFields: (input: Record<string, unknown>) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getRecord: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteRecord: (input: Record<string, unknown>) => Promise<void>;
} => loadModuleExport('../../channels/lark/lark-base.service', 'larkBaseService');

const loadLarkOperationalConfigRepository = (): LarkOperationalConfigLike =>
  loadModuleExport<LarkOperationalConfigLike>('../../channels/lark/lark-operational-config.repository', 'larkOperationalConfigRepository');

const loadLarkRuntimeClientError = (): { new (...args: any[]): Error } =>
  loadModuleExport('../../channels/lark/lark-runtime-client', 'LarkRuntimeClientError');

const loadResolveLarkTaskAssignees = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) =>
  loadModuleExport('./lark-helpers', 'resolveLarkTaskAssignees');

const loadListLarkTaskAssignablePeople = (): ((input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>) =>
  loadModuleExport('./lark-helpers', 'listLarkTaskAssignablePeople');

const loadNormalizeLarkTimestamp = (): ((value?: string, timeZone?: string) => string | undefined) =>
  loadModuleExport('./lark-helpers', 'normalizeLarkTimestamp');

const loadWebSearchService = (): {
  search: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/search/web-search.service', 'webSearchService');

const loadSearchIntegrationError = (): { new (...args: any[]): Error } =>
  loadModuleExport('../../integrations/search/web-search.service', 'SearchIntegrationError');

const loadEmbeddingService = (): {
  embed: (texts: string[]) => Promise<number[][]>;
} => loadModuleExport('../../integrations/embedding', 'embeddingService');

const loadVectorDocumentRepository = (): {
  findByFileAsset: (input: { companyId: string; fileAssetId: string }) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../integrations/vector/vector-document.repository', 'vectorDocumentRepository');

const loadFileUploadService = (): {
  listVisibleFiles: (input: {
    companyId: string;
    requesterUserId: string;
    requesterAiRole: string;
    isAdmin?: boolean;
  }) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../../modules/file-upload/file-upload.service', 'fileUploadService');

const loadDocumentTextHelpers = (): {
  extractTextFromBuffer: (buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
  normalizeExtractedText: (rawText: string, maxWords?: number) => string;
} => require('../../../modules/file-upload/document-text-extractor') as {
  extractTextFromBuffer: (buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
  normalizeExtractedText: (rawText: string, maxWords?: number) => string;
};

const loadQdrantAdapter = (): {
  search: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../integrations/vector/qdrant.adapter', 'qdrantAdapter');

const loadBuildCitationFromVectorResult = (): ((match: Record<string, unknown>, index?: number) => Record<string, unknown> | null) =>
  loadModuleExport('../../integrations/vector/vector-citations', 'buildCitationFromVectorResult');

const loadZohoReadAgent = (): { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> } =>
  new (loadModuleExport('../../agents/implementations/zoho-read.agent', 'ZohoReadAgent'))();

const loadOutreachReadAgent = (): { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> } =>
  new (loadModuleExport('../../agents/implementations/outreach-read.agent', 'OutreachReadAgent'))();

const loadCompanyContextResolver = (): {
  resolveCompanyId: (input?: { companyId?: unknown; larkTenantKey?: unknown }) => Promise<string>;
} => loadModuleExport('../../agents/support/company-context.resolver', 'companyContextResolver');

const loadZohoRetrievalService = (): {
  query: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../agents/support/zoho-retrieval.service', 'zohoRetrievalService');

const loadZohoDataClient = (): {
  fetchRecordBySource: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  createRecord?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateRecord?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteRecord?: (input: Record<string, unknown>) => Promise<void>;
} => loadModuleExport('../../integrations/zoho/zoho-data.client', 'zohoDataClient');

const loadZohoBooksClient = (): {
  listOrganizations: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  listRecords: (input: Record<string, unknown>) => Promise<{
    organizationId: string;
    items: Array<Record<string, unknown>>;
    payload: Record<string, unknown>;
  }>;
  getRecord: (input: Record<string, unknown>) => Promise<{
    organizationId: string;
    record: Record<string, unknown>;
    payload: Record<string, unknown>;
  }>;
  createRecord: (input: Record<string, unknown>) => Promise<{
    organizationId: string;
    record: Record<string, unknown>;
    payload: Record<string, unknown>;
  }>;
  updateRecord: (input: Record<string, unknown>) => Promise<{
    organizationId: string;
    record: Record<string, unknown>;
    payload: Record<string, unknown>;
  }>;
  deleteRecord: (input: Record<string, unknown>) => Promise<{
    organizationId: string;
    payload: Record<string, unknown>;
  }>;
} => loadModuleExport('../../integrations/zoho/zoho-books.client', 'zohoBooksClient');

const loadHitlActionService = (): {
  createPending: (input: {
    taskId: string;
    actionType: 'write' | 'update' | 'delete' | 'execute';
    summary: string;
    chatId: string;
    threadId?: string;
    executionId?: string;
    channel?: 'desktop' | 'lark';
    toolId?: string;
    actionGroup?: ToolActionGroup;
    subject?: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) => Promise<{ actionId: string }>;
} => loadModuleExport('../../state/hitl/hitl-action.service', 'hitlActionService');

const loadZohoRoleAccessService = (): {
  resolveScopeMode: (companyId: string, requesterAiRole?: string) => Promise<'email_scoped' | 'company_scoped'>;
} => loadModuleExport('../../tools/zoho-role-access.service', 'zohoRoleAccessService');

const loadRuntimeControls = (): {
  COMPANY_CONTROL_KEYS: { zohoUserScopedReadStrictEnabled: string };
  isCompanyControlEnabled: (input: Record<string, unknown>) => Promise<boolean>;
} => require('../../support/runtime-controls') as {
  COMPANY_CONTROL_KEYS: { zohoUserScopedReadStrictEnabled: string };
  isCompanyControlEnabled: (input: Record<string, unknown>) => Promise<boolean>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const summarize = (value: unknown, fallback = 'No summary returned.'): string => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === 'object') {
    const answer = asRecord(value)?.answer;
    if (typeof answer === 'string' && answer.trim()) {
      return answer.trim();
    }
  }
  return fallback;
};

const inferErrorKind = (summary: string): VercelToolEnvelope['errorKind'] => {
  const lowered = summary.toLowerCase();
  if (lowered.includes('not permitted') || lowered.includes('access to')) return 'permission';
  if (lowered.includes('required') || lowered.includes('please provide') || lowered.includes('no current')) return 'missing_input';
  if (lowered.includes('unsupported')) return 'unsupported';
  if (lowered.includes('invalid') || lowered.includes('failed:')) return 'validation';
  return 'api_failure';
};

const normalizeCitations = (value: unknown): VercelCitation[] => {
  return asArray(value).flatMap((entry, index) => {
    const record = asRecord(entry);
    if (!record) return [];
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : typeof record.url === 'string' && record.url.trim()
        ? `citation-${index + 1}`
        : null;
    if (!id) return [];
    return [{
      id,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id,
      url: typeof record.url === 'string' ? record.url : undefined,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
      sourceType: typeof record.sourceType === 'string' ? record.sourceType : undefined,
      sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
      fileAssetId: typeof record.fileAssetId === 'string' ? record.fileAssetId : undefined,
      chunkIndex: typeof record.chunkIndex === 'number' ? record.chunkIndex : undefined,
    }];
  });
};

const uniqueDefinedStrings = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));

const buildWebCitations = (
  items: Array<Record<string, unknown>>,
  sourceRefs?: unknown,
): VercelCitation[] => {
  const fallbackIds = asArray(sourceRefs)
    .map((entry) => asRecord(entry))
    .map((entry) => asString(entry?.id))
    .filter((value): value is string => Boolean(value));

  return items.flatMap((item, index) => {
    const url = asString(item.link) ?? asString(item.url);
    if (!url) return [];
    return [{
      id: fallbackIds[index] ?? `web-${index + 1}`,
      title: asString(item.title) ?? url,
      url,
      kind: 'web',
      sourceType: 'web',
      sourceId: fallbackIds[index] ?? url,
    }];
  });
};

const buildEnvelope = (input: {
  success: boolean;
  summary: string;
  keyData?: Record<string, unknown>;
  fullPayload?: Record<string, unknown>;
  citations?: VercelCitation[];
  errorKind?: VercelToolEnvelope['errorKind'];
  retryable?: boolean;
  userAction?: string;
  pendingApprovalAction?: PendingApprovalAction;
}): VercelToolEnvelope => ({
  success: input.success,
  summary: input.summary,
  ...(input.keyData ? { keyData: input.keyData } : {}),
  ...(input.fullPayload ? { fullPayload: input.fullPayload } : {}),
  ...(input.citations && input.citations.length > 0 ? { citations: input.citations } : {}),
  ...(input.errorKind ? { errorKind: input.errorKind } : {}),
  ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
  ...(input.userAction ? { userAction: input.userAction } : {}),
  ...(input.pendingApprovalAction ? { pendingApprovalAction: input.pendingApprovalAction } : {}),
});

const getAllowedActionGroups = (runtime: VercelRuntimeRequestContext, toolId: string): ToolActionGroup[] => {
  const explicit = runtime.allowedActionsByTool?.[toolId];
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  if (runtime.allowedToolIds.includes(toolId)) {
    return getSupportedToolActionGroups(toolId);
  }
  return [];
};

const ensureActionPermission = (
  runtime: VercelRuntimeRequestContext,
  toolId: string,
  actionGroup: ToolActionGroup,
): VercelToolEnvelope | null => {
  const allowed = getAllowedActionGroups(runtime, toolId);
  if (allowed.includes(actionGroup)) {
    return null;
  }
  return buildEnvelope({
    success: false,
    summary: `Permission denied: ${toolId} cannot perform ${actionGroup} for the current department role.`,
    errorKind: 'permission',
    retryable: false,
  });
};

const ensureAnyActionPermission = (
  runtime: VercelRuntimeRequestContext,
  toolIds: string[],
  actionGroup: ToolActionGroup,
  label?: string,
): VercelToolEnvelope | null => {
  const normalizedToolIds = Array.from(new Set(toolIds.filter(Boolean)));
  const allowed = normalizedToolIds.some((toolId) => getAllowedActionGroups(runtime, toolId).includes(actionGroup));
  if (allowed) {
    return null;
  }
  return buildEnvelope({
    success: false,
    summary: `Permission denied: ${label ?? normalizedToolIds.join(', ')} cannot perform ${actionGroup} for the current department role.`,
    errorKind: 'permission',
    retryable: false,
  });
};

const createPendingRemoteApproval = async (input: {
  runtime: VercelRuntimeRequestContext;
  toolId: string;
  actionGroup: ToolActionGroup;
  operation: string;
  summary: string;
  subject?: string;
  explanation?: string;
  payload: Record<string, unknown>;
}): Promise<VercelToolEnvelope> => {
  const actionType =
    input.actionGroup === 'delete'
      ? 'delete'
      : input.actionGroup === 'execute' || input.actionGroup === 'send'
        ? 'execute'
        : input.actionGroup === 'update'
          ? 'update'
          : 'write';
  const pending = await loadHitlActionService().createPending({
    taskId: input.runtime.executionId,
    actionType,
    summary: input.summary,
    chatId: input.runtime.chatId ?? input.runtime.threadId,
    threadId: input.runtime.threadId,
    executionId: input.runtime.executionId,
    channel: input.runtime.channel,
    toolId: input.toolId,
    actionGroup: input.actionGroup,
    subject: input.subject,
    payload: {
      ...input.payload,
      toolId: input.toolId,
      actionGroup: input.actionGroup,
      operation: input.operation,
    },
    metadata: {
      companyId: input.runtime.companyId,
      userId: input.runtime.userId,
      requesterAiRole: input.runtime.requesterAiRole,
      requesterEmail: input.runtime.requesterEmail,
      departmentId: input.runtime.departmentId,
      departmentName: input.runtime.departmentName,
      departmentRoleSlug: input.runtime.departmentRoleSlug,
      authProvider: input.runtime.authProvider,
      larkTenantKey: input.runtime.larkTenantKey,
      larkOpenId: input.runtime.larkOpenId,
      larkUserId: input.runtime.larkUserId,
      mode: input.runtime.mode,
    },
  });
  return buildEnvelope({
    success: true,
    summary: input.summary,
    pendingApprovalAction: {
      kind: 'tool_action',
      approvalId: pending.actionId,
      scope: 'backend_remote',
      toolId: input.toolId,
      actionGroup: input.actionGroup,
      operation: input.operation,
      title: `${input.toolId} ${input.actionGroup} approval required`,
      summary: input.summary,
      subject: input.subject,
      explanation: input.explanation,
      payload: input.payload,
    },
  });
};

const buildExpiryFromSeconds = (seconds?: number): Date | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
};

const normalizeGoogleScopes = (scopes?: string[]): Set<string> =>
  new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean));

type ResolvedGoogleLink = {
  mode: 'company' | 'user';
  accessToken: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: Date | null;
  accessTokenExpiresAt?: Date | null;
  tokenType?: string;
  scope?: string;
  scopes: string[];
  googleUserId: string;
  googleEmail?: string;
  googleName?: string;
  tokenMetadata?: Record<string, unknown> | null;
};

type RuntimeFileReference = {
  fileAssetId: string;
  fileName: string;
  mimeType?: string;
  cloudinaryUrl?: string;
  ingestionStatus?: string;
  updatedAtMs: number;
};

const buildRuntimeFileRecord = (entry: Record<string, unknown>): RuntimeFileReference => ({
  fileAssetId: asString(entry.id) ?? '',
  fileName: asString(entry.fileName) ?? 'file',
  mimeType: asString(entry.mimeType),
  cloudinaryUrl: asString(entry.cloudinaryUrl),
  ingestionStatus: asString(entry.ingestionStatus),
  updatedAtMs: Date.parse(asString(entry.updatedAt) ?? asString(entry.createdAt) ?? '') || Date.now(),
});

const inferCurrency = (text: string): string | undefined => {
  if (/₹|rs\.?|inr/i.test(text)) return 'INR';
  if (/\bUSD\b|\$/i.test(text)) return 'USD';
  if (/\bEUR\b|€/i.test(text)) return 'EUR';
  if (/\bGBP\b|£/i.test(text)) return 'GBP';
  return undefined;
};

const parseNumericAmount = (value: string): number | null => {
  const cleaned = value.replace(/[^0-9().,\-]/g, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const negative = cleaned.startsWith('(') && cleaned.endsWith(')');
  const normalized = negative ? `-${cleaned.slice(1, -1)}` : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const detectDateStrings = (text: string): string[] => {
  const matches = text.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 24);
};

const extractFieldByLabels = (text: string, labels: string[]): string | undefined => {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:#-]?\\s*([^\\n]+)`, 'i'));
    const value = match?.[1]?.trim();
    if (value) {
      return value.replace(/\s{2,}/g, ' ');
    }
  }
  return undefined;
};

const extractBestAmount = (text: string, labels: string[]): number | undefined => {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:#-]?\\s*([\\(\\)₹$A-Z\\s0-9,.-]+)`, 'i'));
    const amount = match?.[1] ? parseNumericAmount(match[1]) : null;
    if (amount !== null) {
      return amount;
    }
  }
  return undefined;
};

const parseInvoiceDocument = (text: string) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const invoiceNumber =
    extractFieldByLabels(text, ['invoice\\s*(?:no|number)', 'bill\\s*(?:no|number)', 'ref(?:erence)?\\s*(?:no|number)'])
    ?? lines.find((line) => /invoice/i.test(line) && /\d/.test(line));
  const vendorName =
    extractFieldByLabels(text, ['vendor', 'supplier', 'from', 'seller', 'billed\\s+by'])
    ?? lines.find((line) => /^[A-Za-z][A-Za-z0-9&.,()\- ]{3,}$/.test(line) && !/invoice|tax|gst|bill to/i.test(line));
  const dueDate = extractFieldByLabels(text, ['due\\s*date', 'payment\\s*due']);
  const invoiceDate = extractFieldByLabels(text, ['invoice\\s*date', 'bill\\s*date', 'date']) ?? detectDateStrings(text)[0];
  const gstin = text.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]Z[A-Z0-9]\b/i)?.[0];
  const subtotal = extractBestAmount(text, ['subtotal', 'taxable\\s*value', 'net\\s*amount']);
  const taxAmount = extractBestAmount(text, ['gst', 'igst', 'cgst', 'sgst', 'tax']);
  const totalAmount =
    extractBestAmount(text, ['grand\\s*total', 'invoice\\s*total', 'total\\s*amount', 'amount\\s*due', 'total'])
    ?? (() => {
      const amounts = Array.from(text.matchAll(/(?:₹|rs\.?|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/gi))
        .map((match) => parseNumericAmount(match[1] ?? ''))
        .filter((value): value is number => value !== null);
      return amounts.length > 0 ? Math.max(...amounts) : undefined;
    })();

  return {
    vendorName,
    invoiceNumber,
    invoiceDate,
    dueDate,
    gstin,
    currency: inferCurrency(text),
    subtotal,
    taxAmount,
    totalAmount,
    candidateDates: detectDateStrings(text),
    lineCount: lines.length,
  };
};

const parseStatementDocument = (text: string) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rowRegex = /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.+?)\s+([()\-0-9,]+\.\d{2}|[()\-0-9,]+)\s*$/;
  const rows = lines.flatMap((line) => {
    const match = line.match(rowRegex);
    if (!match) return [];
    const amount = parseNumericAmount(match[3] ?? '');
    return [{
      date: match[1],
      description: match[2].replace(/\s{2,}/g, ' ').trim(),
      amount,
      direction: amount !== null && amount < 0 ? 'debit' : 'credit',
    }];
  });

  const closingBalance = extractBestAmount(text, ['closing\\s*balance', 'balance\\s*as\\s*on', 'available\\s*balance']);
  const openingBalance = extractBestAmount(text, ['opening\\s*balance', 'balance\\s*brought\\s*forward']);
  const totalCredits = rows.filter((row) => typeof row.amount === 'number' && row.amount >= 0).reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const totalDebits = rows.filter((row) => typeof row.amount === 'number' && row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount ?? 0), 0);

  return {
    statementType: /bank/i.test(text) ? 'bank' : /ledger|account/i.test(text) ? 'account' : 'generic',
    accountName: extractFieldByLabels(text, ['account\\s*name', 'statement\\s*for', 'customer\\s*name']),
    accountNumber: extractFieldByLabels(text, ['account\\s*(?:no|number)', 'a\\/c\\s*(?:no|number)']),
    dateRange: {
      from: extractFieldByLabels(text, ['from', 'period\\s*from']) ?? detectDateStrings(text)[0],
      to: extractFieldByLabels(text, ['to', 'period\\s*to']) ?? detectDateStrings(text)[1],
    },
    currency: inferCurrency(text),
    openingBalance,
    closingBalance,
    transactionCount: rows.length,
    totals: {
      credits: totalCredits || undefined,
      debits: totalDebits || undefined,
    },
    rows: rows.slice(0, 200),
  };
};

const resolveGoogleAccess = async (
  runtime: VercelRuntimeRequestContext,
  requiredScopes: string[],
): Promise<{ accessToken: string; scopes: string[] } | { error: VercelToolEnvelope }> => {
  const companyLink = await companyGoogleAuthLinkRepository.findActiveByCompany(runtime.companyId);
  const userLink = companyLink ? null : await googleUserAuthLinkRepository.findActiveByUser(runtime.userId, runtime.companyId);
  const link: ResolvedGoogleLink | null = companyLink
    ? {
      mode: 'company',
      accessToken: companyLink.accessToken,
      refreshToken: companyLink.refreshToken,
      refreshTokenExpiresAt: companyLink.refreshTokenExpiresAt,
      accessTokenExpiresAt: companyLink.accessTokenExpiresAt,
      tokenType: companyLink.tokenType,
      scope: companyLink.scope,
      scopes: companyLink.scopes,
      googleUserId: companyLink.googleUserId,
      googleEmail: companyLink.googleEmail,
      googleName: companyLink.googleName,
      tokenMetadata: companyLink.tokenMetadata,
    }
    : userLink
      ? {
        mode: 'user',
        accessToken: userLink.accessToken,
        refreshToken: userLink.refreshToken,
        refreshTokenExpiresAt: userLink.refreshTokenExpiresAt,
        accessTokenExpiresAt: userLink.accessTokenExpiresAt,
        tokenType: userLink.tokenType,
        scope: userLink.scope,
        scopes: userLink.scopes,
        googleUserId: userLink.googleUserId,
        googleEmail: userLink.googleEmail,
        googleName: userLink.googleName,
        tokenMetadata: userLink.tokenMetadata,
      }
      : null;
  if (!link) {
    return {
      error: buildEnvelope({
        success: false,
        summary: 'No Google account is connected for this workspace or user.',
        errorKind: 'permission',
        retryable: false,
        userAction: 'Connect Google Workspace from Admin Settings → Integrations, or connect a personal Google account in desktop settings.',
      }),
    };
  }

  const scopeSet = normalizeGoogleScopes(link.scopes);
  const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
  if (missingScopes.length > 0) {
    return {
      error: buildEnvelope({
        success: false,
        summary: 'Google connection is missing required scopes.',
        errorKind: 'permission',
        retryable: false,
        userAction: `Reconnect Google and grant: ${missingScopes.join(', ')}`,
      }),
    };
  }

  let accessToken = link.accessToken;
  const expiresAt = link.accessTokenExpiresAt?.getTime();
  if (expiresAt && expiresAt - Date.now() < 60_000) {
    if (!link.refreshToken) {
      return {
        error: buildEnvelope({
          success: false,
          summary: 'Google access token expired and no refresh token is available.',
          errorKind: 'permission',
          retryable: false,
          userAction: 'Reconnect your Google account to refresh credentials.',
        }),
      };
    }
    const refreshed = await googleOAuthService.refreshAccessToken(link.refreshToken);
    accessToken = refreshed.accessToken;
    if (link.mode === 'company') {
      await companyGoogleAuthLinkRepository.upsert({
        companyId: runtime.companyId,
        googleUserId: link.googleUserId,
        googleEmail: link.googleEmail,
        googleName: link.googleName,
        scope: refreshed.scope ?? link.scope,
        accessToken: refreshed.accessToken,
        refreshToken: link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: buildExpiryFromSeconds(refreshed.expiresIn),
        refreshTokenExpiresAt: link.refreshTokenExpiresAt,
        tokenMetadata: link.tokenMetadata ?? undefined,
        linkedByUserId: runtime.userId,
      });
    } else {
      await googleUserAuthLinkRepository.upsert({
        userId: runtime.userId,
        companyId: runtime.companyId,
        googleUserId: link.googleUserId,
        googleEmail: link.googleEmail,
        googleName: link.googleName,
        scope: refreshed.scope ?? link.scope,
        accessToken: refreshed.accessToken,
        refreshToken: link.refreshToken,
        tokenType: refreshed.tokenType ?? link.tokenType,
        accessTokenExpiresAt: buildExpiryFromSeconds(refreshed.expiresIn),
        refreshTokenExpiresAt: link.refreshTokenExpiresAt,
        tokenMetadata: link.tokenMetadata ?? undefined,
      });
    }
  }

  return { accessToken, scopes: link.scopes };
};

const listVisibleRuntimeFiles = async (runtime: VercelRuntimeRequestContext): Promise<RuntimeFileReference[]> => {
  const files = await loadFileUploadService().listVisibleFiles({
    companyId: runtime.companyId,
    requesterUserId: runtime.userId,
    requesterAiRole: runtime.requesterAiRole,
    isAdmin: runtime.requesterAiRole === 'COMPANY_ADMIN' || runtime.requesterAiRole === 'SUPER_ADMIN',
  });

  return files
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map(buildRuntimeFileRecord)
    .filter((entry) => Boolean(entry.fileAssetId));
};

const resolveRuntimeFile = async (
  runtime: VercelRuntimeRequestContext,
  input: { fileAssetId?: string; fileName?: string },
): Promise<RuntimeFileReference | null> => {
  const files = await listVisibleRuntimeFiles(runtime);
  const normalizedId = input.fileAssetId?.trim();
  if (normalizedId) {
    return files.find((file) => file.fileAssetId === normalizedId) ?? null;
  }

  const normalizedName = input.fileName?.trim().toLowerCase();
  if (normalizedName) {
    return files.find((file) => file.fileName.trim().toLowerCase() === normalizedName)
      ?? files.find((file) => file.fileName.trim().toLowerCase().includes(normalizedName))
      ?? null;
  }

  const latest = conversationMemoryStore.getLatestFileAsset(buildConversationKey(runtime.threadId));
  if (!latest) {
    return null;
  }
  return files.find((file) => file.fileAssetId === latest.fileAssetId) ?? latest;
};

const extractIndexedFileText = async (runtime: VercelRuntimeRequestContext, fileAssetId: string): Promise<string> => {
  const docs = await loadVectorDocumentRepository().findByFileAsset({
    companyId: runtime.companyId,
    fileAssetId,
  });
  const chunks = docs
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => asRecord(entry.payload))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((payload) => asString(payload._chunk) ?? asString(payload.text) ?? '')
    .filter(Boolean);
  return chunks.join('\n\n').trim();
};

const extractFileText = async (
  runtime: VercelRuntimeRequestContext,
  file: RuntimeFileReference,
): Promise<{ text: string; source: 'vector' | 'ocr' }> => {
  const indexedText = await extractIndexedFileText(runtime, file.fileAssetId);
  if (indexedText) {
    return { text: indexedText, source: 'vector' };
  }

  if (!file.cloudinaryUrl || !file.mimeType) {
    return { text: '', source: 'ocr' };
  }

  const response = await fetch(file.cloudinaryUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch file content for OCR: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const { extractTextFromBuffer, normalizeExtractedText } = loadDocumentTextHelpers();
  const rawText = await extractTextFromBuffer(Buffer.from(arrayBuffer), file.mimeType, file.fileName);
  return {
    text: normalizeExtractedText(rawText),
    source: 'ocr',
  };
};

const encodeGmailMessage = (input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  isHtml?: boolean;
}): string => {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: text/${input.isHtml ? 'html' : 'plain'}; charset="UTF-8"`,
    '',
    input.body,
  ];
  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return raw;
};

const toEnvelopeFromAgentResult = (
  output: unknown,
  input?: {
    keyData?: Record<string, unknown>;
    fullPayload?: Record<string, unknown>;
    citations?: VercelCitation[];
  },
): VercelToolEnvelope => {
  const record = asRecord(output);
  const status = asString(record?.status);
  const success = status === 'success';
  const result = asRecord(record?.result);
  const error = asRecord(record?.error);
  const summary =
    asString(record?.message)
    ?? asString(result?.answer)
    ?? asString(error?.classifiedReason)
    ?? 'No summary returned.';

  return buildEnvelope({
    success,
    summary,
    keyData: input?.keyData,
    fullPayload: input?.fullPayload ?? result ?? record ?? undefined,
    citations: input?.citations,
    ...(success ? {} : {
      errorKind: inferErrorKind(summary),
      retryable: typeof error?.retriable === 'boolean' ? error.retriable : true,
    }),
  });
};

const buildAgentInvokeInput = (
  runtime: VercelRuntimeRequestContext,
  agentKey: string,
  objective: string,
  contextPacket: Record<string, unknown> = {},
) => ({
  taskId: runtime.executionId,
  agentKey,
  objective,
  constraints: ['vercel-tool'],
  contextPacket: {
    companyId: runtime.companyId,
    larkTenantKey: runtime.larkTenantKey,
    userId: runtime.userId,
    requesterEmail: runtime.requesterEmail,
    requesterAiRole: runtime.requesterAiRole,
    chatId: runtime.threadId,
    ...contextPacket,
  },
  correlationId: randomUUID(),
});

const buildConversationKey = (threadId: string): string => `desktop:${threadId}`;

const normalizeZohoSourceType = (value?: string): ZohoSourceType | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['leads', 'lead', 'zoho_lead'].includes(normalized)) return 'zoho_lead';
  if (['contacts', 'contact', 'zoho_contact'].includes(normalized)) return 'zoho_contact';
  if (['deals', 'deal', 'zoho_deal'].includes(normalized)) return 'zoho_deal';
  if (['cases', 'case', 'tickets', 'ticket', 'zoho_ticket'].includes(normalized)) return 'zoho_ticket';
  return undefined;
};

const normalizeZohoBooksModule = (value?: string):
  | 'invoices'
  | 'estimates'
  | 'bills'
  | 'customerpayments'
  | 'banktransactions'
  | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['invoice', 'invoices'].includes(normalized)) return 'invoices';
  if (['estimate', 'estimates'].includes(normalized)) return 'estimates';
  if (['bill', 'bills'].includes(normalized)) return 'bills';
  if (['customerpayment', 'customerpayments', 'payment', 'payments'].includes(normalized)) return 'customerpayments';
  if (['banktransaction', 'banktransactions', 'bank-transaction', 'bank-transactions'].includes(normalized)) {
    return 'banktransactions';
  }
  return undefined;
};

const getLarkDefaults = async (runtime: VercelRuntimeRequestContext) =>
  loadLarkOperationalConfigRepository().findByCompanyId(runtime.companyId);

const getLarkAuthInput = (runtime: VercelRuntimeRequestContext) => ({
  companyId: runtime.companyId,
  larkTenantKey: runtime.larkTenantKey,
  appUserId: runtime.userId,
  credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
});

const getLarkTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const withLarkTenantFallback = async <T>(
  runtime: VercelRuntimeRequestContext,
  run: (auth: Record<string, unknown>) => Promise<T>,
): Promise<T> => {
  const primary = getLarkAuthInput(runtime);
  try {
    return await run(primary);
  } catch (error) {
    const LarkRuntimeClientError = loadLarkRuntimeClientError();
    if (primary.credentialMode !== 'user_linked' || !(error instanceof LarkRuntimeClientError)) {
      throw error;
    }
    return run({
      ...primary,
      credentialMode: 'tenant',
    });
  }
};

const withLifecycle = async (
  hooks: VercelRuntimeToolHooks,
  toolName: string,
  title: string,
  run: () => Promise<VercelToolEnvelope>,
): Promise<VercelToolEnvelope> => {
  const activityId = randomUUID();
  await hooks.onToolStart(toolName, activityId, title);
  try {
    const output = await run();
    await hooks.onToolFinish(toolName, activityId, title, output);
    return output;
  } catch (error) {
    const summary = error instanceof Error ? error.message : 'Unknown tool error';
    const output = buildEnvelope({
      success: false,
      summary,
      errorKind: 'api_failure',
      retryable: true,
    });
    await hooks.onToolFinish(toolName, activityId, title, output);
    return output;
  }
};

const resolveWorkspacePath = (runtime: VercelRuntimeRequestContext, candidate: string): string => {
  const workspaceRoot = runtime.workspace?.path ?? '.';
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.join(workspaceRoot, candidate);
};

const inspectWorkspace = async (workspaceRoot: string) => {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  return entries
    .slice(0, 50)
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }));
};

const getCodingActivityTitle = (operation: string): string => {
  switch (operation) {
    case 'inspectWorkspace':
      return 'Inspecting workspace files';
    case 'readFiles':
      return 'Reading workspace files';
    case 'verifyResult':
      return 'Verifying local command results';
    case 'planCommand':
      return 'Planning shell command';
    case 'runScriptPlan':
      return 'Planning script execution';
    case 'writeFilePlan':
      return 'Planning file write';
    default:
      return 'Running local coding action';
  }
};

const readWorkspaceFiles = async (runtime: VercelRuntimeRequestContext, paths: string[]) => {
  const items = await Promise.all(paths.map(async (filePath) => {
    const absolutePath = resolveWorkspacePath(runtime, filePath);
    const content = await fs.readFile(absolutePath, 'utf8');
    return {
      path: filePath,
      content,
    };
  }));
  return items;
};

const summarizeActionResult = (runtime: VercelRuntimeRequestContext, expectedOutputs?: string[]): VercelToolEnvelope => {
  const latest = runtime.latestActionResult;
  if (!latest) {
    return buildEnvelope({
      success: false,
      summary: 'No local action result is available to verify yet.',
      errorKind: 'missing_input',
      retryable: false,
    });
  }

  return buildEnvelope({
    success: latest.ok,
    summary: latest.summary,
    keyData: {
      actionKind: latest.kind,
      expectedOutputs: expectedOutputs ?? [],
    },
    fullPayload: {
      latestActionResult: latest,
    },
    ...(latest.ok ? {} : { errorKind: 'api_failure', retryable: true }),
  });
};

const VERCEL_TOOL_PERMISSION_IDS: Record<string, string[]> = {
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
  zoho: ['search-zoho-context', 'read-zoho-records', 'zoho-agent', 'zoho-read', 'zoho-write'],
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

const isVercelToolAllowed = (runtime: VercelRuntimeRequestContext, toolName: string): boolean => {
  const requiredIds = VERCEL_TOOL_PERMISSION_IDS[toolName];
  if (!requiredIds || requiredIds.length === 0) {
    return false;
  }
  const allowed = new Set(runtime.allowedToolIds);
  return requiredIds.some((toolId) => allowed.has(toolId));
};

export const createVercelDesktopTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => {
  const tools = {
    webSearch: tool({
      description: 'Public web and documentation search only. Use for public internet research and exact page context.',
      inputSchema: z.object({
        operation: z.enum(['search', 'focusedSearch', 'fetchPageContext']),
        query: z.string().min(1),
        site: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'webSearch', 'Searching the web', async () => {
        try {
          const limit = Math.max(1, Math.min(8, input.limit ?? 5));
          const isPageContextFetch = input.operation === 'fetchPageContext';
          const searchResult = await loadWebSearchService().search({
            query: input.query,
            ...(input.site ? { exactDomain: input.site } : {}),
            ...(isPageContextFetch ? { crawlUrl: input.query } : {}),
            searchResultsLimit: limit,
            pageContextLimit: Math.min(isPageContextFetch ? 4 : 3, limit),
          });
          const record = asRecord(searchResult) ?? {};
          const items = asArray(record.items).map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
          const citations = buildWebCitations(items, record.sourceRefs);
          return buildEnvelope({
            success: true,
            summary: items.length > 0
              ? `Found ${items.length} public web result(s) for "${input.query}".`
              : `No public web results matched "${input.query}".`,
            keyData: {
              selectedResult: items[0] ?? null,
              urls: uniqueDefinedStrings(citations.map((citation) => citation.url)),
            },
            fullPayload: {
              query: record.query,
              exactDomain: record.exactDomain,
              focusedSiteSearch: record.focusedSiteSearch,
              crawlUsed: record.crawlUsed,
              crawlUrl: record.crawlUrl,
              crawlError: record.crawlError,
              searchResults: items,
            },
            citations,
          });
        } catch (error) {
          const SearchIntegrationError = loadSearchIntegrationError();
          const summary = error instanceof Error ? error.message : 'Web search failed.';
          return buildEnvelope({
            success: false,
            summary,
            errorKind: error instanceof SearchIntegrationError ? 'api_failure' : inferErrorKind(summary),
            retryable: true,
          });
        }
      }),
    }),

    docSearch: tool({
      description: 'Internal company document search only. Use for private docs and uploaded files.',
      inputSchema: z.object({
        operation: z.enum(['search', 'readChunkContext']),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'docSearch', 'Searching internal documents', async () => {
        const limit = Math.max(1, Math.min(10, input.limit ?? 5));
        const [queryVector] = await loadEmbeddingService().embed([input.query]);
        const vectorMatches = await loadQdrantAdapter().search({
          companyId: runtime.companyId,
          vector: queryVector,
          limit,
          sourceTypes: ['file_document'],
          includeShared: true,
          includePersonal: false,
          includePublic: false,
          requesterAiRole: runtime.requesterAiRole,
        });
        const matches = vectorMatches.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
        const citationBuilder = loadBuildCitationFromVectorResult();
        const citations = matches
          .map((match, index) => citationBuilder(match, index))
          .filter((entry): entry is VercelCitation => entry !== null);
        const normalizedMatches = matches.map((match, index) => {
          const payload = asRecord(match.payload) ?? {};
          return {
            id: `${asString(match.sourceType) ?? 'file_document'}:${asString(match.sourceId) ?? index + 1}`,
            fileName: asString(payload.fileName) ?? asString(payload.title) ?? 'document',
            text: asString(payload._chunk) ?? asString(payload.text) ?? '',
            modality: asString(payload.modality) ?? 'text',
            url: asString(payload.cloudinaryUrl) ?? asString(payload.sourceUrl),
            score: typeof match.score === 'number' ? match.score : undefined,
            sourceId: asString(match.sourceId),
            chunkIndex: typeof match.chunkIndex === 'number' ? match.chunkIndex : undefined,
            segmentStartMs: typeof payload.segmentStartMs === 'number' ? payload.segmentStartMs : undefined,
            segmentEndMs: typeof payload.segmentEndMs === 'number' ? payload.segmentEndMs : undefined,
          };
        });
        return buildEnvelope({
          success: true,
          summary: normalizedMatches.length > 0
            ? `Found ${normalizedMatches.length} relevant internal document section(s).`
            : 'No relevant internal document content matched the request.',
          keyData: {
            documentIds: uniqueDefinedStrings(citations.map((citation) => citation.sourceId)),
          },
          fullPayload: {
            matches: normalizedMatches,
          },
          citations,
        });
      }),
    }),

    documentOcrRead: tool({
      description: 'List visible uploaded files and extract machine-readable text from a selected document.',
      inputSchema: z.object({
        operation: z.enum(['listFiles', 'extractText']),
        fileAssetId: z.string().optional(),
        fileName: z.string().optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'documentOcrRead', 'Running document OCR', async () => {
        const conversationKey = buildConversationKey(runtime.threadId);
        if (input.operation === 'listFiles') {
          const files = await listVisibleRuntimeFiles(runtime);
          const limited = files.slice(0, input.limit ?? 10);
          return buildEnvelope({
            success: true,
            summary: limited.length > 0
              ? `Found ${limited.length} accessible uploaded file(s).`
              : 'No accessible uploaded files were found.',
            keyData: {
              fileAssetIds: limited.map((file) => file.fileAssetId),
            },
            fullPayload: {
              files: limited,
            },
          });
        }

        const file = await resolveRuntimeFile(runtime, input);
        if (!file) {
          return buildEnvelope({
            success: false,
            summary: 'No matching uploaded file was found. Provide fileAssetId or fileName, or upload a document first.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const extracted = await extractFileText(runtime, file);
        if (!extracted.text.trim()) {
          return buildEnvelope({
            success: false,
            summary: `No extractable text was found in ${file.fileName}.`,
            errorKind: 'validation',
            retryable: false,
          });
        }

        conversationMemoryStore.addFileAsset(conversationKey, file);
        return buildEnvelope({
          success: true,
          summary: `Extracted text from ${file.fileName}.`,
          keyData: {
            fileAssetId: file.fileAssetId,
            fileName: file.fileName,
            extractionSource: extracted.source,
          },
          fullPayload: {
            file,
            text: extracted.text,
            extractionSource: extracted.source,
          },
          citations: [{
            id: `file-${file.fileAssetId}`,
            title: file.fileName,
            url: file.cloudinaryUrl,
            kind: 'file',
            sourceType: 'file_document',
            sourceId: file.fileAssetId,
            fileAssetId: file.fileAssetId,
          }],
        });
      }),
    }),

    invoiceParser: tool({
      description: 'Parse uploaded invoice or bill documents into structured finance fields.',
      inputSchema: z.object({
        fileAssetId: z.string().optional(),
        fileName: z.string().optional(),
        text: z.string().optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'invoiceParser', 'Parsing invoice document', async () => {
        const conversationKey = buildConversationKey(runtime.threadId);
        const file = input.text ? null : await resolveRuntimeFile(runtime, input);
        if (!input.text && !file) {
          return buildEnvelope({
            success: false,
            summary: 'Invoice parsing requires uploaded document text or a visible file reference.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const extracted = input.text
          ? { text: input.text.trim(), source: 'provided' as const }
          : await extractFileText(runtime, file!);
        if (!extracted.text.trim()) {
          return buildEnvelope({
            success: false,
            summary: 'The invoice document does not contain extractable text.',
            errorKind: 'validation',
            retryable: false,
          });
        }

        if (file) {
          conversationMemoryStore.addFileAsset(conversationKey, file);
        }

        const parsed = parseInvoiceDocument(extracted.text);
        return buildEnvelope({
          success: true,
          summary: parsed.invoiceNumber
            ? `Parsed invoice ${parsed.invoiceNumber}${parsed.vendorName ? ` for ${parsed.vendorName}` : ''}.`
            : `Parsed invoice fields${parsed.vendorName ? ` for ${parsed.vendorName}` : ''}.`,
          keyData: {
            fileAssetId: file?.fileAssetId,
            fileName: file?.fileName,
            vendorName: parsed.vendorName,
            invoiceNumber: parsed.invoiceNumber,
            totalAmount: parsed.totalAmount,
          },
          fullPayload: {
            file,
            extractionSource: extracted.source,
            parsed,
            textPreview: extracted.text.slice(0, 4000),
          },
          ...(file ? {
            citations: [{
              id: `file-${file.fileAssetId}`,
              title: file.fileName,
              url: file.cloudinaryUrl,
              kind: 'file',
              sourceType: 'file_document',
              sourceId: file.fileAssetId,
              fileAssetId: file.fileAssetId,
            }],
          } : {}),
        });
      }),
    }),

    statementParser: tool({
      description: 'Parse uploaded bank or account statements into transaction rows and statement totals.',
      inputSchema: z.object({
        fileAssetId: z.string().optional(),
        fileName: z.string().optional(),
        text: z.string().optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'statementParser', 'Parsing statement document', async () => {
        const conversationKey = buildConversationKey(runtime.threadId);
        const file = input.text ? null : await resolveRuntimeFile(runtime, input);
        if (!input.text && !file) {
          return buildEnvelope({
            success: false,
            summary: 'Statement parsing requires uploaded document text or a visible file reference.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const extracted = input.text
          ? { text: input.text.trim(), source: 'provided' as const }
          : await extractFileText(runtime, file!);
        if (!extracted.text.trim()) {
          return buildEnvelope({
            success: false,
            summary: 'The statement document does not contain extractable text.',
            errorKind: 'validation',
            retryable: false,
          });
        }

        if (file) {
          conversationMemoryStore.addFileAsset(conversationKey, file);
        }

        const parsed = parseStatementDocument(extracted.text);
        return buildEnvelope({
          success: true,
          summary: `Parsed ${parsed.transactionCount} statement row(s).`,
          keyData: {
            fileAssetId: file?.fileAssetId,
            fileName: file?.fileName,
            transactionCount: parsed.transactionCount,
            closingBalance: parsed.closingBalance,
          },
          fullPayload: {
            file,
            extractionSource: extracted.source,
            parsed,
            textPreview: extracted.text.slice(0, 4000),
          },
          ...(file ? {
            citations: [{
              id: `file-${file.fileAssetId}`,
              title: file.fileName,
              url: file.cloudinaryUrl,
              kind: 'file',
              sourceType: 'file_document',
              sourceId: file.fileAssetId,
              fileAssetId: file.fileAssetId,
            }],
          } : {}),
        });
      }),
    }),

    skillSearch: tool({
      description: 'Search and read reusable global and department skills for specialized workflows before continuing the task.',
      inputSchema: z.object({
        operation: z.enum(['searchSkills', 'readSkill']),
        query: z.string().optional(),
        skillId: z.string().optional(),
        skillSlug: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (input) => withLifecycle(
        hooks,
        'skillSearch',
        input.operation === 'readSkill' ? 'Reading skill guide' : 'Searching skill library',
        async () => {
          if (input.operation === 'searchSkills') {
            if (!input.query?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'Skill search requires a query.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const skills = await skillService.searchVisibleSkills({
              companyId: runtime.companyId,
              departmentId: runtime.departmentId,
              query: input.query,
              limit: input.limit,
            });
            return buildEnvelope({
              success: true,
              summary: skills.length > 0
                ? `Found ${skills.length} relevant skill${skills.length === 1 ? '' : 's'}.`
                : 'No relevant skills matched the request.',
              keyData: {
                skills: skills.map((skill) => ({
                  id: skill.id,
                  slug: skill.slug,
                  name: skill.name,
                  summary: skill.summary,
                  scope: skill.scope,
                  departmentName: skill.departmentName,
                  tags: skill.tags,
                  source: skill.source,
                })),
              },
              fullPayload: {
                skills,
              },
            });
          }

          if (!input.skillId && !input.skillSlug) {
            return buildEnvelope({
              success: false,
              summary: 'Reading a skill requires skillId or skillSlug.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const skill = await skillService.readVisibleSkill({
            companyId: runtime.companyId,
            departmentId: runtime.departmentId,
            skillId: input.skillId,
            skillSlug: input.skillSlug,
          });
          if (!skill) {
            return buildEnvelope({
              success: false,
              summary: 'The requested skill was not found in the visible global or department skill scope.',
              errorKind: 'validation',
              retryable: false,
            });
          }

          return buildEnvelope({
            success: true,
            summary: `Loaded skill "${skill.name}".`,
            keyData: {
              skill: {
                id: skill.id,
                slug: skill.slug,
                name: skill.name,
                summary: skill.summary,
                scope: skill.scope,
                departmentName: skill.departmentName,
                tags: skill.tags,
                source: skill.source,
              },
            },
            fullPayload: {
              skill,
            },
          });
        },
      ),
    }),

    repo: tool({
      description: 'Remote GitHub repository discovery and file retrieval. Do not use for the local open workspace.',
      inputSchema: z.object({
        operation: z.enum(['discoverRepositories', 'inspectRepository', 'retrieveFile']),
        repoQuery: z.string().optional(),
        repoRef: z.string().optional(),
        targetFilePath: z.string().optional(),
        targetFileName: z.string().optional(),
        filePath: z.string().optional(),
        requireRoot: z.boolean().optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'repo', 'Inspecting GitHub repositories', async () => {
        if (input.operation === 'discoverRepositories') {
          if (!input.repoQuery?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'Repository discovery requires repoQuery.',
              errorKind: 'missing_input',
            });
          }
          const repositories = await discoverRepositories({
            repoQuery: input.repoQuery,
            targetFileName: input.targetFileName,
          });
          if (repositories.length === 0) {
            return buildEnvelope({
              success: false,
              summary: `I could not resolve the repository "${input.repoQuery}".`,
              errorKind: 'validation',
              retryable: true,
              userAction: 'Provide the exact repository URL or owner/repo name.',
            });
          }
          return buildEnvelope({
            success: true,
            summary: `Found ${repositories.length} matching GitHub repositories.`,
            keyData: {
              repo: repositories[0],
              files: [],
            },
            fullPayload: { repositories },
            citations: repositories.map((repo, index) => ({
              id: `repo-${index + 1}`,
              title: repo.fullName,
              url: repo.htmlUrl,
              kind: 'repository',
              sourceType: 'github',
              sourceId: repo.fullName,
            })),
          });
        }

        if (!input.repoRef?.trim()) {
          return buildEnvelope({
            success: false,
            summary: 'Repository inspection requires repoRef.',
            errorKind: 'missing_input',
          });
        }

        if (input.operation === 'inspectRepository') {
          const result = await inspectRepository({
            repoRef: input.repoRef,
            targetFilePath: input.targetFilePath,
            targetFileName: input.targetFileName,
            requireRoot: input.requireRoot,
          });
          return buildEnvelope({
            success: true,
            summary: `Resolved ${result.repo.fullName} and inspected ${result.tree.length} entries.`,
            keyData: {
              repo: result.repo,
              files: result.matches.map((entry) => entry.path),
            },
            fullPayload: result,
            citations: [{
              id: result.repo.fullName,
              title: result.repo.fullName,
              url: result.repo.htmlUrl,
              kind: 'repository',
              sourceType: 'github',
              sourceId: result.repo.fullName,
            }],
          });
        }

        const artifact = await retrieveRepositoryFile({
          repoRef: input.repoRef,
          filePath: input.filePath,
          targetFilePath: input.targetFilePath,
          targetFileName: input.targetFileName,
          requireRoot: input.requireRoot,
        });
        return buildEnvelope({
          success: true,
          summary: `Retrieved ${artifact.path} from ${artifact.repo.fullName}.`,
          keyData: {
            repo: artifact.repo,
            files: [artifact.path],
          },
          fullPayload: {
            artifact,
          },
          citations: [{
            id: `${artifact.repo.fullName}:${artifact.path}`,
            title: artifact.path,
            url: artifact.htmlUrl,
            kind: 'file',
            sourceType: 'github',
            sourceId: artifact.repo.fullName,
          }],
        });
      }),
    }),

    coding: tool({
      description: 'Primary local coding tool for the open workspace. Use inspectWorkspace to list files, readFiles to read exact files, planCommand or runScriptPlan only when you already know the exact shell command, writeFilePlan only when you already have the full file path and full file content, and verifyResult after an approved local action finishes. Do not call writeFilePlan without contentPlan.path and contentPlan.content. Do not call planCommand or runScriptPlan without command.',
      inputSchema: z.discriminatedUnion('operation', [
        z.object({
          operation: z.literal('inspectWorkspace'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
        }),
        z.object({
          operation: z.literal('readFiles'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          paths: z.array(z.string()).min(1),
        }),
        z.object({
          operation: z.literal('planCommand'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('runScriptPlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('writeFilePlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          contentPlan: z.object({
            path: z.string().min(1),
            content: z.string().min(1),
          }),
        }),
        z.object({
          operation: z.literal('verifyResult'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          expectedOutputs: z.array(z.string()).optional(),
        }),
      ]),
      execute: async (input) => withLifecycle(hooks, 'coding', getCodingActivityTitle(input.operation), async () => {
        const workspaceRoot = input.workspaceRoot?.trim() || runtime.workspace?.path;
        if (!workspaceRoot) {
          return buildEnvelope({
            success: false,
            summary: 'No open workspace is available for local coding actions.',
            errorKind: 'missing_input',
          });
        }

        if (input.operation === 'inspectWorkspace') {
          const items = await inspectWorkspace(workspaceRoot);
          return buildEnvelope({
            success: true,
            summary: `Inspected ${items.length} workspace entries in ${workspaceRoot}.`,
            keyData: {
              workspaceRoot,
              files: items,
            },
            fullPayload: { items },
          });
        }

        if (input.operation === 'readFiles') {
          const items = await readWorkspaceFiles(runtime, input.paths);
          return buildEnvelope({
            success: true,
            summary: `Read ${items.length} workspace file(s).`,
            keyData: {
              workspaceRoot,
              files: items.map((item) => item.path),
            },
            fullPayload: { files: items },
          });
        }

        if (input.operation === 'verifyResult') {
          return summarizeActionResult(runtime, input.expectedOutputs);
        }

        if (input.operation === 'planCommand' || input.operation === 'runScriptPlan') {
          const command = input.command.trim();
          return buildEnvelope({
            success: true,
            summary: `Proposed shell command: ${command}`,
            keyData: { workspaceRoot },
            pendingApprovalAction: {
              kind: 'run_command',
              command,
              cwd: workspaceRoot,
              explanation: input.objective,
            },
          });
        }

        if (input.operation === 'writeFilePlan') {
          const targetPath = input.contentPlan.path;
          const content = input.contentPlan.content;
          return buildEnvelope({
            success: true,
            summary: `Proposed file write: ${targetPath}`,
            keyData: { workspaceRoot },
            pendingApprovalAction: {
              kind: 'write_file',
              path: targetPath,
              content,
              explanation: input.objective,
            },
          });
        }

        return buildEnvelope({
          success: false,
          summary: `Unsupported coding operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
    }),

    googleMail: tool({
      description: 'Use the connected Google account to list, read, draft, and send Gmail messages.',
      inputSchema: z.object({
        operation: z.enum(['listMessages', 'getMessage', 'getThread', 'createDraft', 'sendMessage', 'sendDraft']),
        query: z.string().optional(),
        maxResults: z.number().int().min(1).max(50).optional(),
        messageId: z.string().optional(),
        threadId: z.string().optional(),
        draftId: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        isHtml: z.boolean().optional(),
        format: z.enum(['metadata', 'full', 'minimal', 'raw']).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'googleMail', 'Running Gmail workflow', async () => {
        const actionGroup: ToolActionGroup =
          input.operation === 'createDraft'
            ? 'create'
            : input.operation === 'sendMessage' || input.operation === 'sendDraft'
              ? 'send'
              : 'read';
        const permissionError = ensureActionPermission(runtime, 'google-gmail', actionGroup);
        if (permissionError) {
          return permissionError;
        }
        const requiresSend = input.operation === 'sendMessage';
        const requiresDraft = input.operation === 'createDraft' || input.operation === 'sendDraft';
        const requiredScopes = requiresSend
          ? ['https://www.googleapis.com/auth/gmail.send']
          : requiresDraft
            ? ['https://www.googleapis.com/auth/gmail.compose']
            : ['https://www.googleapis.com/auth/gmail.readonly'];

        const access = await resolveGoogleAccess(runtime, requiredScopes);
        if ('error' in access) {
          return access.error;
        }

        const baseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';

        if (input.operation === 'listMessages') {
          const url = new URL(`${baseUrl}/messages`);
          url.searchParams.set('maxResults', String(input.maxResults ?? 10));
          url.searchParams.set('q', input.query?.trim() || 'in:inbox');
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Gmail list failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          const items = asArray(payload.messages).map((entry) => asRecord(entry)).filter(Boolean);
          return buildEnvelope({
            success: true,
            summary: `Found ${items.length} message(s).`,
            keyData: { items },
            fullPayload: payload,
          });
        }

        if (input.operation === 'getMessage') {
          const messageId = input.messageId?.trim();
          if (!messageId) {
            return buildEnvelope({
              success: false,
              summary: 'getMessage requires messageId.',
              errorKind: 'missing_input',
            });
          }
          const url = new URL(`${baseUrl}/messages/${messageId}`);
          url.searchParams.set('format', input.format ?? 'metadata');
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Gmail getMessage failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          return buildEnvelope({
            success: true,
            summary: `Fetched message ${messageId}.`,
            keyData: { messageId },
            fullPayload: payload,
          });
        }

        if (input.operation === 'getThread') {
          const threadId = input.threadId?.trim();
          if (!threadId) {
            return buildEnvelope({
              success: false,
              summary: 'getThread requires threadId.',
              errorKind: 'missing_input',
            });
          }
          const url = new URL(`${baseUrl}/threads/${threadId}`);
          url.searchParams.set('format', input.format ?? 'metadata');
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Gmail getThread failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          return buildEnvelope({
            success: true,
            summary: `Fetched thread ${threadId}.`,
            keyData: { threadId },
            fullPayload: payload,
          });
        }

        if (input.operation === 'createDraft') {
          if (!input.to || !input.subject || !input.body) {
            return buildEnvelope({
              success: false,
              summary: 'createDraft requires to, subject, and body.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-gmail',
            actionGroup: 'create',
            operation: 'createDraft',
            summary: `Approval required to create Gmail draft "${input.subject}".`,
            subject: input.subject,
            explanation: `Create a draft to ${input.to}.`,
            payload: {
              to: input.to,
              subject: input.subject,
              body: input.body,
              cc: input.cc,
              bcc: input.bcc,
              isHtml: input.isHtml ?? false,
              threadId: input.threadId,
            },
          });
        }

        if (input.operation === 'sendDraft') {
          const draftId = input.draftId?.trim();
          if (!draftId) {
            return buildEnvelope({
              success: false,
              summary: 'sendDraft requires draftId.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-gmail',
            actionGroup: 'send',
            operation: 'sendDraft',
            summary: `Approval required to send Gmail draft ${draftId}.`,
            subject: draftId,
            explanation: 'Send the selected Gmail draft.',
            payload: { draftId },
          });
        }

        if (input.operation === 'sendMessage') {
          if (!input.to || !input.subject || !input.body) {
            return buildEnvelope({
              success: false,
              summary: 'sendMessage requires to, subject, and body.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-gmail',
            actionGroup: 'send',
            operation: 'sendMessage',
            summary: `Approval required to send Gmail message "${input.subject}".`,
            subject: input.subject,
            explanation: `Send email to ${input.to}.`,
            payload: {
              to: input.to,
              subject: input.subject,
              body: input.body,
              cc: input.cc,
              bcc: input.bcc,
              isHtml: input.isHtml ?? false,
              threadId: input.threadId,
            },
          });
        }

        return buildEnvelope({
          success: false,
          summary: `Unsupported Gmail operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
    }),

    googleDrive: tool({
      description: 'Use the connected Google account to list, read, download, and upload Drive files.',
      inputSchema: z.object({
        operation: z.enum(['listFiles', 'getFile', 'downloadFile', 'createFolder', 'uploadFile', 'updateFile', 'deleteFile']),
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
      execute: async (input) => withLifecycle(hooks, 'googleDrive', 'Running Google Drive workflow', async () => {
        const actionGroup: ToolActionGroup =
          input.operation === 'createFolder' || input.operation === 'uploadFile'
            ? 'create'
            : input.operation === 'updateFile'
              ? 'update'
              : input.operation === 'deleteFile'
                ? 'delete'
                : 'read';
        const permissionError = ensureActionPermission(runtime, 'google-drive', actionGroup);
        if (permissionError) {
          return permissionError;
        }
        const writeOps = actionGroup !== 'read';
        const requiredScopes = writeOps
          ? ['https://www.googleapis.com/auth/drive.file']
          : ['https://www.googleapis.com/auth/drive.readonly'];

        const access = await resolveGoogleAccess(runtime, requiredScopes);
        if ('error' in access) {
          return access.error;
        }

        const baseUrl = 'https://www.googleapis.com/drive/v3/files';
        const defaultFields = 'files(id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(emailAddress,displayName))';

        if (input.operation === 'listFiles') {
          const url = new URL(baseUrl);
          url.searchParams.set('pageSize', String(input.pageSize ?? 20));
          url.searchParams.set('fields', input.fields ?? defaultFields);
          if (input.query) url.searchParams.set('q', input.query);
          if (input.orderBy) url.searchParams.set('orderBy', input.orderBy);
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Drive list failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          const items = asArray(payload.files).map((entry) => asRecord(entry)).filter(Boolean);
          return buildEnvelope({
            success: true,
            summary: `Found ${items.length} file(s).`,
            keyData: { items },
            fullPayload: payload,
          });
        }

        if (input.operation === 'getFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return buildEnvelope({
              success: false,
              summary: 'getFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          const url = new URL(`${baseUrl}/${fileId}`);
          url.searchParams.set('fields', input.fields ?? 'id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(emailAddress,displayName)');
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Drive getFile failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          return buildEnvelope({
            success: true,
            summary: `Fetched file ${fileId}.`,
            keyData: { fileId },
            fullPayload: payload,
          });
        }

        if (input.operation === 'downloadFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return buildEnvelope({
              success: false,
              summary: 'downloadFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          if (input.preferLink) {
            const metaUrl = new URL(`${baseUrl}/${fileId}`);
            metaUrl.searchParams.set('fields', 'id,name,webContentLink,webViewLink,mimeType,size');
            const metaResponse = await fetch(metaUrl, {
              headers: { Authorization: `Bearer ${access.accessToken}` },
            });
            const metaPayload = (await metaResponse.json().catch(() => ({}))) as Record<string, unknown>;
            if (!metaResponse.ok) {
              return buildEnvelope({
                success: false,
                summary: `Drive metadata failed: ${(metaPayload as any)?.error?.message ?? metaResponse.statusText}`,
                errorKind: 'api_failure',
                retryable: true,
                fullPayload: { status: metaResponse.status, payload: metaPayload },
              });
            }
            return buildEnvelope({
              success: true,
              summary: 'Generated Drive download link.',
              keyData: {
                fileId,
                name: asString(metaPayload.name),
                webContentLink: asString(metaPayload.webContentLink),
                webViewLink: asString(metaPayload.webViewLink),
              },
              fullPayload: metaPayload,
            });
          }

          const url = new URL(`${baseUrl}/${fileId}`);
          url.searchParams.set('alt', 'media');
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
            return buildEnvelope({
              success: false,
              summary: `Drive download failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          const maxBytes = input.maxBytes ?? 2_000_000;
          if (buffer.length > maxBytes) {
            return buildEnvelope({
              success: false,
              summary: `Drive file is too large (${buffer.length} bytes).`,
              errorKind: 'validation',
              retryable: false,
              userAction: `Reduce size or increase maxBytes (<= 5,000,000).`,
            });
          }
          return buildEnvelope({
            success: true,
            summary: `Downloaded file ${fileId} (${buffer.length} bytes).`,
            keyData: { fileId, size: buffer.length },
            fullPayload: { fileId, base64: buffer.toString('base64') },
          });
        }

        if (input.operation === 'createFolder') {
          const name = input.fileName?.trim();
          if (!name) {
            return buildEnvelope({
              success: false,
              summary: 'createFolder requires fileName.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'create',
            operation: 'createFolder',
            summary: `Approval required to create Drive folder "${name}".`,
            subject: name,
            explanation: 'Create a Google Drive folder.',
            payload: {
              fileName: name,
              parentId: input.parentId,
            },
          });
        }

        if (input.operation === 'uploadFile') {
          const name = input.fileName?.trim();
          if (!name) {
            return buildEnvelope({
              success: false,
              summary: 'uploadFile requires fileName.',
              errorKind: 'missing_input',
            });
          }
          const content = input.contentBase64
            ? input.contentBase64
            : typeof input.contentText === 'string'
              ? Buffer.from(input.contentText, 'utf8').toString('base64')
              : undefined;
          if (!content) {
            return buildEnvelope({
              success: false,
              summary: 'uploadFile requires contentBase64 or contentText.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'create',
            operation: 'uploadFile',
            summary: `Approval required to upload Drive file "${name}".`,
            subject: name,
            explanation: 'Upload a file to Google Drive.',
            payload: {
              fileName: name,
              parentId: input.parentId,
              mimeType: input.mimeType ?? 'application/octet-stream',
              contentBase64: content,
            },
          });
        }

        if (input.operation === 'updateFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return buildEnvelope({
              success: false,
              summary: 'updateFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          const hasContent = Boolean(input.contentBase64 || input.contentText);
          const hasName = Boolean(input.fileName?.trim());
          if (!hasContent && !hasName) {
            return buildEnvelope({
              success: false,
              summary: 'updateFile requires contentBase64/contentText or fileName.',
              errorKind: 'missing_input',
            });
          }
          const content = input.contentBase64
            ? input.contentBase64
            : typeof input.contentText === 'string'
              ? Buffer.from(input.contentText, 'utf8').toString('base64')
              : undefined;
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'update',
            operation: 'updateFile',
            summary: `Approval required to update Drive file ${fileId}.`,
            subject: input.fileName?.trim() ?? fileId,
            explanation: 'Update a Google Drive file name or contents.',
            payload: {
              fileId,
              fileName: input.fileName?.trim(),
              mimeType: input.mimeType,
              parentId: input.parentId,
              ...(content ? { contentBase64: content } : {}),
            },
          });
        }

        if (input.operation === 'deleteFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return buildEnvelope({
              success: false,
              summary: 'deleteFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'delete',
            operation: 'deleteFile',
            summary: `Approval required to delete Drive file ${fileId}.`,
            subject: fileId,
            explanation: 'Delete a Google Drive file.',
            payload: { fileId },
          });
        }

        return buildEnvelope({
          success: false,
          summary: `Unsupported Drive operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
    }),

    googleCalendar: tool({
      description: 'Use the connected Google account to list, read, create, update, and delete Google Calendar events.',
      inputSchema: z.object({
        operation: z.enum(['listCalendars', 'listEvents', 'getEvent', 'createEvent', 'updateEvent', 'deleteEvent']),
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
      execute: async (input) => withLifecycle(hooks, 'googleCalendar', 'Running Google Calendar workflow', async () => {
        const actionGroup: ToolActionGroup =
          input.operation === 'createEvent'
            ? 'create'
            : input.operation === 'updateEvent'
              ? 'update'
              : input.operation === 'deleteEvent'
                ? 'delete'
                : 'read';
        const permissionError = ensureActionPermission(runtime, 'google-calendar', actionGroup);
        if (permissionError) {
          return permissionError;
        }

        const access = await resolveGoogleAccess(
          runtime,
          actionGroup === 'read'
            ? ['https://www.googleapis.com/auth/calendar.readonly']
            : ['https://www.googleapis.com/auth/calendar.events'],
        );
        if ('error' in access) {
          return access.error;
        }

        const calendarId = encodeURIComponent(input.calendarId?.trim() || 'primary');

        if (input.operation === 'listCalendars') {
          const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Google Calendar list failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          const items = asArray(payload.items).map((entry) => asRecord(entry)).filter(Boolean);
          return buildEnvelope({
            success: true,
            summary: `Found ${items.length} Google calendar(s).`,
            keyData: { calendars: items },
            fullPayload: payload,
          });
        }

        if (input.operation === 'listEvents') {
          const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
          if (input.query?.trim()) url.searchParams.set('q', input.query.trim());
          if (input.timeMin?.trim()) url.searchParams.set('timeMin', input.timeMin.trim());
          if (input.timeMax?.trim()) url.searchParams.set('timeMax', input.timeMax.trim());
          url.searchParams.set('singleEvents', 'true');
          url.searchParams.set('maxResults', '50');
          url.searchParams.set('orderBy', 'startTime');
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Google Calendar event list failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          const items = asArray(payload.items).map((entry) => asRecord(entry)).filter(Boolean);
          return buildEnvelope({
            success: true,
            summary: `Found ${items.length} Google Calendar event(s).`,
            keyData: { events: items },
            fullPayload: payload,
          });
        }

        if (input.operation === 'getEvent') {
          const eventId = input.eventId?.trim();
          if (!eventId) {
            return buildEnvelope({
              success: false,
              summary: 'getEvent requires eventId.',
              errorKind: 'missing_input',
            });
          }
          const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
            headers: { Authorization: `Bearer ${access.accessToken}` },
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            return buildEnvelope({
              success: false,
              summary: `Google Calendar getEvent failed: ${(payload as any)?.error?.message ?? response.statusText}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: response.status, payload },
            });
          }
          return buildEnvelope({
            success: true,
            summary: `Fetched Google Calendar event ${eventId}.`,
            keyData: { event: payload },
            fullPayload: payload,
          });
        }

        if (input.operation === 'createEvent') {
          if (!input.summary?.trim() || !input.startTime?.trim() || !input.endTime?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'createEvent requires summary, startTime, and endTime.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-calendar',
            actionGroup: 'create',
            operation: 'createEvent',
            summary: `Approval required to create Google Calendar event "${input.summary.trim()}".`,
            subject: input.summary.trim(),
            explanation: 'Create a Google Calendar event.',
            payload: {
              calendarId: input.calendarId?.trim() || 'primary',
              body: {
                summary: input.summary.trim(),
                ...(input.description?.trim() ? { description: input.description.trim() } : {}),
                ...(input.location?.trim() ? { location: input.location.trim() } : {}),
                start: { dateTime: input.startTime.trim() },
                end: { dateTime: input.endTime.trim() },
                ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
              },
            },
          });
        }

        if (input.operation === 'updateEvent') {
          const eventId = input.eventId?.trim();
          if (!eventId) {
            return buildEnvelope({
              success: false,
              summary: 'updateEvent requires eventId.',
              errorKind: 'missing_input',
            });
          }
          const body: Record<string, unknown> = {
            ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            ...(input.location?.trim() ? { location: input.location.trim() } : {}),
            ...(input.startTime?.trim() ? { start: { dateTime: input.startTime.trim() } } : {}),
            ...(input.endTime?.trim() ? { end: { dateTime: input.endTime.trim() } } : {}),
            ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
          };
          if (Object.keys(body).length === 0) {
            return buildEnvelope({
              success: false,
              summary: 'updateEvent requires at least one field to change.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-calendar',
            actionGroup: 'update',
            operation: 'updateEvent',
            summary: `Approval required to update Google Calendar event ${eventId}.`,
            subject: input.summary?.trim() ?? eventId,
            explanation: 'Update a Google Calendar event.',
            payload: {
              calendarId: input.calendarId?.trim() || 'primary',
              eventId,
              body,
            },
          });
        }

        if (input.operation === 'deleteEvent') {
          const eventId = input.eventId?.trim();
          if (!eventId) {
            return buildEnvelope({
              success: false,
              summary: 'deleteEvent requires eventId.',
              errorKind: 'missing_input',
            });
          }
          return createPendingRemoteApproval({
            runtime,
            toolId: 'google-calendar',
            actionGroup: 'delete',
            operation: 'deleteEvent',
            summary: `Approval required to delete Google Calendar event ${eventId}.`,
            subject: eventId,
            explanation: 'Delete a Google Calendar event.',
            payload: {
              calendarId: input.calendarId?.trim() || 'primary',
              eventId,
            },
          });
        }

        return buildEnvelope({
          success: false,
          summary: `Unsupported Google Calendar operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
    }),

    booksRead: tool({
      description: 'Read Zoho Books organizations and finance records such as invoices, estimates, bills, payments, and bank transactions.',
      inputSchema: z.object({
        operation: z.enum(['listOrganizations', 'listRecords', 'getRecord', 'summarizeModule']),
        module: z.string().optional(),
        recordId: z.string().optional(),
        organizationId: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        filters: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'booksRead', 'Running Zoho Books read workflow', async () => {
        const readPermissionError = ensureAnyActionPermission(
          runtime,
          ['zoho-books-read', 'zoho-books-agent'],
          'read',
          'booksRead',
        );
        if (readPermissionError) {
          return readPermissionError;
        }

        if (input.operation === 'listOrganizations') {
          try {
            const organizations = await loadZohoBooksClient().listOrganizations({
              companyId: runtime.companyId,
            });
            return buildEnvelope({
              success: true,
              summary: organizations.length > 0
                ? `Found ${organizations.length} Zoho Books organization(s).`
                : 'No Zoho Books organizations were returned by the current connection.',
              keyData: {
                organizationId: asString(organizations[0]?.organizationId),
                organizations,
              },
              fullPayload: {
                organizations,
              },
            });
          } catch (error) {
            const summary = error instanceof Error ? error.message : 'Failed to list Zoho Books organizations.';
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: true,
            });
          }
        }

        const moduleName = normalizeZohoBooksModule(input.module);
        if (!moduleName) {
          return buildEnvelope({
            success: false,
            summary: `${input.operation} requires a supported Zoho Books module such as invoices, estimates, bills, customerpayments, or banktransactions.`,
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        if (input.operation === 'getRecord') {
          if (!input.recordId?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'getRecord requires recordId.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          try {
            const result = await loadZohoBooksClient().getRecord({
              companyId: runtime.companyId,
              moduleName,
              recordId: input.recordId.trim(),
              organizationId: input.organizationId?.trim(),
            });
            return buildEnvelope({
              success: true,
              summary: `Fetched Zoho Books ${moduleName} record ${input.recordId.trim()}.`,
              keyData: {
                module: moduleName,
                recordId: input.recordId.trim(),
                organizationId: result.organizationId,
              },
              fullPayload: result.payload,
              citations: [{
                id: `books-${moduleName}-${input.recordId.trim()}`,
                title: `${moduleName}:${input.recordId.trim()}`,
                kind: 'record',
                sourceType: moduleName,
                sourceId: input.recordId.trim(),
              }],
            });
          } catch (error) {
            const summary = error instanceof Error ? error.message : 'Failed to fetch Zoho Books record.';
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: true,
            });
          }
        }

        try {
          const result = await loadZohoBooksClient().listRecords({
            companyId: runtime.companyId,
            moduleName,
            organizationId: input.organizationId?.trim(),
            filters: input.filters,
            limit: input.limit,
            query: input.query?.trim(),
          });

          if (input.operation === 'summarizeModule') {
            const statusCounts = result.items.reduce<Record<string, number>>((acc, item) => {
              const status = asString(item.status) ?? 'unknown';
              acc[status] = (acc[status] ?? 0) + 1;
              return acc;
            }, {});
            return buildEnvelope({
              success: true,
              summary: result.items.length > 0
                ? `Summarized ${result.items.length} Zoho Books ${moduleName} record(s).`
                : `No Zoho Books ${moduleName} records matched the current filters.`,
              keyData: {
                module: moduleName,
                organizationId: result.organizationId,
                recordCount: result.items.length,
                statusCounts,
              },
              fullPayload: {
                organizationId: result.organizationId,
                statusCounts,
                records: result.items,
                raw: result.payload,
              },
            });
          }

          return buildEnvelope({
            success: true,
            summary: result.items.length > 0
              ? `Found ${result.items.length} Zoho Books ${moduleName} record(s).`
              : `No Zoho Books ${moduleName} records matched the current filters.`,
            keyData: {
              module: moduleName,
              organizationId: result.organizationId,
              recordCount: result.items.length,
            },
            fullPayload: {
              organizationId: result.organizationId,
              records: result.items,
              raw: result.payload,
            },
            citations: result.items.flatMap((record, index) => {
              const recordId =
                asString(record.invoice_id)
                ?? asString(record.estimate_id)
                ?? asString(record.bill_id)
                ?? asString(record.payment_id)
                ?? asString(record.bank_transaction_id)
                ?? asString(record.transaction_id);
              if (!recordId) {
                return [];
              }
              return [{
                id: `books-${moduleName}-${index + 1}`,
                title: `${moduleName}:${recordId}`,
                kind: 'record',
                sourceType: moduleName,
                sourceId: recordId,
              }];
            }),
          });
        } catch (error) {
          const summary = error instanceof Error ? error.message : 'Failed to read Zoho Books records.';
          return buildEnvelope({
            success: false,
            summary,
            errorKind: inferErrorKind(summary),
            retryable: true,
          });
        }
      }),
    }),

    booksWrite: tool({
      description: 'Create, update, and delete Zoho Books records through approval-gated actions.',
      inputSchema: z.object({
        operation: z.enum(['createRecord', 'updateRecord', 'deleteRecord']),
        module: z.string(),
        recordId: z.string().optional(),
        organizationId: z.string().optional(),
        body: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'booksWrite', 'Running Zoho Books write workflow', async () => {
        const moduleName = normalizeZohoBooksModule(input.module);
        if (!moduleName) {
          return buildEnvelope({
            success: false,
            summary: `${input.operation} requires a supported Zoho Books module such as invoices, estimates, bills, customerpayments, or banktransactions.`,
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const actionGroup: ToolActionGroup =
          input.operation === 'createRecord'
            ? 'create'
            : input.operation === 'updateRecord'
              ? 'update'
              : 'delete';
        const permissionError = ensureAnyActionPermission(
          runtime,
          ['zoho-books-write', 'zoho-books-agent'],
          actionGroup,
          'booksWrite',
        );
        if (permissionError) {
          return permissionError;
        }

        if (input.operation !== 'createRecord' && !input.recordId?.trim()) {
          return buildEnvelope({
            success: false,
            summary: `${input.operation} requires recordId.`,
            errorKind: 'missing_input',
            retryable: false,
          });
        }
        if ((input.operation === 'createRecord' || input.operation === 'updateRecord') && !input.body) {
          return buildEnvelope({
            success: false,
            summary: `${input.operation} requires body.`,
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const subject =
          input.operation === 'createRecord'
            ? `Create Zoho Books ${moduleName}`
            : `${input.operation === 'updateRecord' ? 'Update' : 'Delete'} Zoho Books ${moduleName} ${input.recordId?.trim() ?? ''}`.trim();
        const summary =
          input.operation === 'createRecord'
            ? `Approval required to create a Zoho Books ${moduleName} record.`
            : input.operation === 'updateRecord'
              ? `Approval required to update Zoho Books ${moduleName} ${input.recordId?.trim() ?? ''}.`.trim()
              : `Approval required to delete Zoho Books ${moduleName} ${input.recordId?.trim() ?? ''}.`.trim();

        return createPendingRemoteApproval({
          runtime,
          toolId: 'zoho-books-write',
          actionGroup,
          operation: input.operation,
          summary,
          subject,
          explanation: 'Zoho Books mutations are approval-gated. Review the module, organization, record target, and payload before proceeding.',
          payload: {
            operation: input.operation,
            module: moduleName,
            recordId: input.recordId?.trim(),
            organizationId: input.organizationId?.trim(),
            body: input.body,
          },
        });
      }),
    }),

    larkTask: tool({
      description: 'Comprehensive Lark Tasks tool for task reads and writes.',
      inputSchema: z.object({
        operation: z.enum(['list', 'get', 'current', 'listTasklists', 'listAssignableUsers', 'create', 'update', 'delete', 'complete', 'reassign']),
        taskId: z.string().optional(),
        tasklistId: z.string().optional(),
        query: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        completed: z.boolean().optional(),
        dueTs: z.string().optional(),
        assigneeIds: z.array(z.string()).optional(),
        assigneeNames: z.array(z.string()).optional(),
        assignToMe: z.boolean().optional(),
        extra: z.record(z.unknown()).optional(),
        customFields: z.array(z.unknown()).optional(),
        repeatRule: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'larkTask', 'Running Lark Tasks workflow', async () => {
        const larkTasksService = loadLarkTasksService();
        const defaults = await getLarkDefaults(runtime);
        const conversationKey = buildConversationKey(runtime.threadId);
        const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
        const normalizeLarkTimestamp = loadNormalizeLarkTimestamp();
        const rememberTask = (task: Record<string, unknown>) => {
          const taskId = asString(task.taskId) ?? asString(task.task_id);
          if (!taskId) return;
          conversationMemoryStore.addLarkTask(conversationKey, {
            taskId,
            taskGuid: asString(task.taskGuid) ?? asString(task.task_guid) ?? asString(task.guid),
            summary: asString(task.summary),
            status: asString(task.status),
            url: asString(task.url),
          });
        };
        const resolveTaskGuid = async (taskRef?: string): Promise<string | null> => {
          const trimmed = taskRef?.trim();
          if (!trimmed) {
            return latestTask?.taskGuid ?? null;
          }
          if (/^[0-9a-f]{8}-/i.test(trimmed)) {
            return trimmed;
          }
          if (latestTask && (latestTask.taskId === trimmed || latestTask.taskGuid === trimmed)) {
            return latestTask.taskGuid ?? null;
          }
          const lookup = await withLarkTenantFallback(runtime, (auth) => larkTasksService.listTasks({
            ...auth,
            tasklistId: input.tasklistId ?? defaults?.defaultTasklistId,
            pageSize: 100,
          }));
          const match = lookup.items.find((item) =>
            asString(item.taskId) === trimmed
            || asString(item.taskGuid) === trimmed
            || asString(item.summary)?.toLowerCase() === trimmed.toLowerCase());
          if (match) rememberTask(match);
          return match ? (asString(match.taskGuid) ?? null) : null;
        };

        if (input.operation === 'listTasklists') {
          const tasklistsResult = await larkTasksService.listTasklists({
            ...getLarkAuthInput(runtime),
            pageSize: 50,
          });
          const normalizedQuery = input.query?.trim().toLowerCase();
          const items = normalizedQuery
            ? tasklistsResult.items.filter((item) => {
              const haystack = `${asString(item.tasklistId) ?? ''} ${asString(item.summary) ?? ''}`.toLowerCase();
              return haystack.includes(normalizedQuery);
            })
            : tasklistsResult.items;
          return buildEnvelope({
            success: true,
            summary: items.length > 0
              ? `Found ${items.length} Lark tasklist(s).`
              : 'No Lark tasklists matched the request.',
            keyData: {
              items,
            },
            fullPayload: {
              items,
              pageToken: tasklistsResult.pageToken,
              hasMore: tasklistsResult.hasMore,
            },
          });
        }
        if (input.operation === 'listAssignableUsers') {
          const people = await loadListLarkTaskAssignablePeople()({
            companyId: runtime.companyId,
            appUserId: runtime.userId,
            requestLarkOpenId: runtime.larkOpenId,
          });
          const normalizedQuery = input.query?.trim().toLowerCase();
          const filtered = normalizedQuery
            ? people.filter((person) => {
              const record = asRecord(person) ?? {};
              return [
                asString(record.displayName),
                asString(record.email),
                asString(record.externalUserId),
                asString(record.larkOpenId),
                asString(record.larkUserId),
              ].some((value) => value?.toLowerCase().includes(normalizedQuery));
            })
            : people;
          return buildEnvelope({
            success: true,
            summary: filtered.length > 0
              ? `Found ${filtered.length} assignable Lark teammate(s).`
              : 'No assignable Lark teammates matched the request.',
            keyData: {
              people: filtered,
            },
            fullPayload: { people: filtered },
          });
        }

        if (input.operation === 'current') {
          if (latestTask?.taskGuid) {
            const task = await withLarkTenantFallback(runtime, (auth) => larkTasksService.getTask({
              ...auth,
              taskGuid: latestTask.taskGuid,
            }));
            rememberTask(task);
            return buildEnvelope({
              success: true,
              summary: `Fetched current Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
              keyData: { task },
              fullPayload: { task },
            });
          }
          const latestVisible = await withLarkTenantFallback(runtime, (auth) => larkTasksService.listTasks({
            ...auth,
            tasklistId: input.tasklistId?.trim() || defaults?.defaultTasklistId,
            pageSize: 25,
          }));
          const sorted = [...latestVisible.items].sort((a, b) =>
            Number(asString(b.updatedAt) ?? '0') - Number(asString(a.updatedAt) ?? '0'));
          const currentTask = sorted[0];
          if (!currentTask) {
            return buildEnvelope({
              success: false,
              summary: 'No current Lark task was found.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          rememberTask(currentTask);
          return buildEnvelope({
            success: true,
            summary: `Fetched current Lark task: ${asString(currentTask.summary) ?? asString(currentTask.taskId) ?? 'task'}.`,
            keyData: { task: currentTask },
            fullPayload: { task: currentTask },
          });
        }

        if (input.operation === 'get') {
          const taskGuid = await resolveTaskGuid(input.taskId);
          if (!taskGuid) {
            return buildEnvelope({
              success: false,
              summary: `No Lark task matched "${input.taskId?.trim() ?? ''}".`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          const task = await withLarkTenantFallback(runtime, (auth) => larkTasksService.getTask({
            ...auth,
            taskGuid,
          }));
          rememberTask(task);
          return buildEnvelope({
            success: true,
            summary: `Fetched Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
            keyData: { task },
            fullPayload: { task },
          });
        }

        if (input.operation === 'list') {
          const defaults = await getLarkDefaults(runtime);
          const result = await withLarkTenantFallback(runtime, (auth) => larkTasksService.listTasks({
            ...auth,
            tasklistId: input.tasklistId?.trim() || defaults?.defaultTasklistId,
            pageSize: 50,
          }));
          const normalizedQuery = input.query?.trim().toLowerCase();
          const items = normalizedQuery
            ? result.items.filter((item) =>
              `${asString(item.taskId) ?? ''} ${asString(item.summary) ?? ''}`.toLowerCase().includes(normalizedQuery))
            : result.items;
          items.forEach(rememberTask);
          return buildEnvelope({
            success: true,
            summary: items.length > 0 ? `Found ${items.length} Lark task(s).` : 'No Lark tasks matched the request.',
            keyData: { items },
            fullPayload: {
              items,
              pageToken: result.pageToken,
              hasMore: result.hasMore,
            },
          });
        }

        const tasklistId = input.tasklistId?.trim() || defaults?.defaultTasklistId;
        const resolvedAssignees = (input.assignToMe || (input.assigneeNames?.length ?? 0) > 0)
          ? await loadResolveLarkTaskAssignees()({
            companyId: runtime.companyId,
            appUserId: runtime.userId,
            requestLarkOpenId: runtime.larkOpenId,
            assigneeNames: input.assigneeNames,
            assignToMe: input.assignToMe,
          })
          : null;
        if (resolvedAssignees?.unresolved.length) {
          return buildEnvelope({
            success: false,
            summary: `No assignable teammate matched ${resolvedAssignees.unresolved.map((value) => `"${value}"`).join(', ')}.`,
            errorKind: 'validation',
            retryable: false,
          });
        }
        if (resolvedAssignees?.ambiguous.length) {
          const first = resolvedAssignees.ambiguous[0];
          const options = first.matches
            .map((person) => asString(asRecord(person)?.displayName) ?? asString(asRecord(person)?.email) ?? asString(asRecord(person)?.externalUserId))
            .filter((value): value is string => Boolean(value))
            .join(', ');
          return buildEnvelope({
            success: false,
            summary: `"${first.query}" matched multiple teammates (${options}). Please be more specific.`,
            errorKind: 'validation',
            retryable: false,
          });
        }
        if ((input.operation === 'update' || input.operation === 'complete' || input.operation === 'reassign')
          && ((resolvedAssignees?.people.length ?? 0) > 0 || (input.assigneeIds?.length ?? 0) > 0)) {
          return buildEnvelope({
            success: false,
            summary: 'Assignee changes for an existing task are not supported by the current task update route.',
            errorKind: 'unsupported',
            retryable: false,
          });
        }

        if (input.operation === 'delete') {
          const taskGuid = await resolveTaskGuid(input.taskId);
          if (!taskGuid) {
            return buildEnvelope({
              success: false,
              summary: 'No current task was found in this conversation. Read or create the task first, or provide a task ID.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          await withLarkTenantFallback(runtime, (auth) => larkTasksService.deleteTask({
            ...auth,
            taskGuid,
          }));
          return buildEnvelope({
            success: true,
            summary: `Deleted Lark task ${input.taskId?.trim() ?? taskGuid}.`,
            keyData: { task: { taskGuid } },
          });
        }

        const resolvedMembers = (resolvedAssignees?.people ?? []).map((person) => {
          const record = asRecord(person) ?? {};
          return {
            id: asString(record.larkOpenId) ?? asString(record.externalUserId),
            role: 'assignee',
            type: 'user',
          };
        }).filter((person) => typeof person.id === 'string');

        const baseBody: Record<string, unknown> = {
          ...(tasklistId ? { tasklist_id: tasklistId } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.dueTs ? { due: { timestamp: normalizeLarkTimestamp(input.dueTs, getLarkTimeZone()) } } : {}),
          ...((input.operation === 'complete' || input.completed !== undefined)
            ? { completed_at: input.operation === 'complete' || input.completed ? String(Date.now()) : '0' }
            : {}),
          ...(input.extra ? { extra: input.extra } : {}),
          ...(input.customFields ? { custom_fields: input.customFields } : {}),
          ...(input.repeatRule ? { repeat_rule: input.repeatRule } : {}),
          ...(resolvedMembers.length > 0 ? { members: resolvedMembers } : {}),
          ...(resolvedMembers.length === 0 && input.assigneeIds && input.assigneeIds.length > 0 ? { assignee_ids: input.assigneeIds } : {}),
        };

        if (input.operation === 'create') {
          if (!input.summary) {
            return buildEnvelope({
              success: false,
              summary: 'Lark task create requires summary.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const task = await larkTasksService.createTask({
            ...getLarkAuthInput(runtime),
            body: baseBody,
          });
          rememberTask(task);
          return buildEnvelope({
            success: true,
            summary: `Created Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
            keyData: { task },
            fullPayload: { task },
          });
        }

        const taskGuid = await resolveTaskGuid(input.taskId);
        if (!taskGuid) {
          return buildEnvelope({
            success: false,
            summary: 'No current task was found in this conversation. Read or create the task first, or provide a task ID.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }
        const taskPayload = Object.fromEntries(
          Object.entries(baseBody).filter(([key]) => key !== 'tasklist_id'),
        );
        const updateFields = Object.keys(taskPayload)
          .map((field) => field === 'completed' ? 'completed_at' : field)
          .filter((field) => ['description', 'extra', 'start', 'due', 'completed_at', 'summary', 'repeat_rule', 'custom_fields'].includes(field));
        if (updateFields.length === 0) {
          return buildEnvelope({
            success: false,
            summary: 'Lark task update requires at least one field to change.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }
        const task = await withLarkTenantFallback(runtime, (auth) => larkTasksService.updateTask({
          ...auth,
          taskGuid,
          body: {
            task: taskPayload,
            update_fields: updateFields,
          },
        }));
        rememberTask(task);
        return buildEnvelope({
          success: true,
          summary: `Updated Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
          keyData: { task },
          fullPayload: { task },
        });
      }),
    }),

    larkCalendar: tool({
      description: 'Comprehensive Lark Calendar tool for day lookups and event mutations.',
      inputSchema: z.object({
        operation: z.enum(['listCalendars', 'listEvents', 'getEvent', 'createEvent', 'updateEvent', 'deleteEvent']),
        calendarId: z.string().optional(),
        calendarName: z.string().optional(),
        eventId: z.string().optional(),
        dateScope: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'larkCalendar', 'Running Lark Calendar workflow', async () => {
        const calendarService = loadLarkCalendarService();
        const defaults = await getLarkDefaults(runtime);
        const normalizeLarkTimestamp = loadNormalizeLarkTimestamp();
        const timeZone = getLarkTimeZone();
        const conversationKey = buildConversationKey(runtime.threadId);
        const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
        const effectiveDateScope = input.dateScope ?? runtime.dateScope;

        if (input.operation === 'listCalendars') {
          const result = await calendarService.listCalendars({
            ...getLarkAuthInput(runtime),
            pageSize: 50,
          });
          const normalizedQuery = input.calendarName?.trim().toLowerCase();
          const calendars = normalizedQuery
            ? result.items.filter((item) =>
              `${asString(item.calendarId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                .toLowerCase()
                .includes(normalizedQuery))
            : result.items;
          return buildEnvelope({
            success: true,
            summary: calendars.length > 0 ? `Found ${calendars.length} Lark calendar(s).` : 'No Lark calendars matched the request.',
            keyData: { calendars },
            fullPayload: { ...result, items: calendars },
          });
        }
        let resolvedCalendarId = input.calendarId?.trim() || defaults?.defaultCalendarId || latestEvent?.calendarId;
        if (!resolvedCalendarId && input.calendarName?.trim()) {
          const lookup = await calendarService.listCalendars({
            ...getLarkAuthInput(runtime),
            pageSize: 50,
          });
          const candidates = lookup.items.filter((item) =>
            `${asString(item.calendarId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
              .toLowerCase()
              .includes(input.calendarName!.trim().toLowerCase()));
          if (candidates.length === 0) {
            return buildEnvelope({
              success: false,
              summary: `No Lark calendar matched "${input.calendarName}".`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          if (candidates.length > 1) {
            return buildEnvelope({
              success: false,
              summary: `Multiple Lark calendars matched "${input.calendarName}". Please provide calendarId explicitly.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          resolvedCalendarId = asString(candidates[0].calendarId);
        }
        if (!resolvedCalendarId) {
          try {
            const primary = await calendarService.getPrimaryCalendar(getLarkAuthInput(runtime));
            resolvedCalendarId = asString(primary.calendarId);
          } catch {
            return buildEnvelope({
              success: false,
              summary: 'No default Lark calendar is configured and no primary calendar could be resolved. Provide calendarId or calendarName.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
        }
        if (input.operation === 'listEvents' || input.operation === 'getEvent') {
          const result = await calendarService.listEvents({
            ...getLarkAuthInput(runtime),
            calendarId: resolvedCalendarId,
            pageSize: 100,
            startTime: normalizeLarkTimestamp(input.startTime ?? effectiveDateScope, timeZone),
            endTime: normalizeLarkTimestamp(input.endTime, timeZone),
          });
          const normalizedQuery = (input.operation === 'getEvent' ? input.eventId : effectiveDateScope)?.trim().toLowerCase();
          const events = normalizedQuery
            ? result.items.filter((item) =>
              `${asString(item.eventId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                .toLowerCase()
                .includes(normalizedQuery))
            : result.items;
          events.forEach((item) => {
            conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
              eventId: asString(item.eventId) ?? '',
              calendarId: resolvedCalendarId as string,
              summary: asString(item.summary),
              startTime: asString(item.startTime),
              endTime: asString(item.endTime),
              url: asString(item.url),
            });
          });
          return buildEnvelope({
            success: true,
            summary: events.length > 0 ? `Found ${events.length} Lark calendar event(s).` : 'No Lark calendar events matched the request.',
            keyData: {
              calendar: { calendarId: resolvedCalendarId },
              events,
              event: events[0],
            },
            fullPayload: { ...result, items: events },
          });
        }
        const resolvedEventId = input.eventId?.trim() || latestEvent?.eventId;
        if ((input.operation === 'updateEvent' || input.operation === 'deleteEvent') && !resolvedEventId) {
          return buildEnvelope({
            success: false,
            summary: `No current event was found in this conversation. Read or create the event first, or provide an event ID.`,
            errorKind: 'missing_input',
            retryable: false,
          });
        }
        if (input.operation === 'deleteEvent') {
          await calendarService.deleteEvent({
            ...getLarkAuthInput(runtime),
            calendarId: resolvedCalendarId,
            eventId: resolvedEventId as string,
          });
          return buildEnvelope({
            success: true,
            summary: `Deleted Lark calendar event ${resolvedEventId as string}.`,
            keyData: { event: { eventId: resolvedEventId } },
          });
        }
        if (input.operation === 'createEvent' && (!input.summary || !(input.startTime ?? effectiveDateScope) || !input.endTime)) {
          return buildEnvelope({
            success: false,
            summary: 'Lark calendar create requires summary, startTime, and endTime.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }
        const body = {
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.startTime ?? effectiveDateScope
            ? { start_time: { timestamp: normalizeLarkTimestamp(input.startTime ?? effectiveDateScope, timeZone) } }
            : {}),
          ...(input.endTime ? { end_time: { timestamp: normalizeLarkTimestamp(input.endTime, timeZone) } } : {}),
        };
        const event = input.operation === 'createEvent'
          ? await calendarService.createEvent({
            ...getLarkAuthInput(runtime),
            calendarId: resolvedCalendarId,
            body,
          })
          : await calendarService.updateEvent({
            ...getLarkAuthInput(runtime),
            calendarId: resolvedCalendarId,
            eventId: resolvedEventId as string,
            body,
          });
        conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
          eventId: asString(event.eventId) ?? '',
          calendarId: resolvedCalendarId,
          summary: asString(event.summary) ?? input.summary,
          startTime: asString(event.startTime),
          endTime: asString(event.endTime),
          url: asString(event.url),
        });
        return buildEnvelope({
          success: true,
          summary: `${input.operation === 'createEvent' ? 'Created' : 'Updated'} Lark calendar event: ${asString(event.summary) ?? asString(event.eventId) ?? 'event'}.`,
          keyData: { event },
          fullPayload: { event },
        });
      }),
    }),

    larkMeeting: tool({
      description: 'Read-only Lark meeting and minute lookup. Use calendar for day-based meeting discovery.',
      inputSchema: z.object({
        operation: z.enum(['list', 'get', 'getMinute']),
        meetingId: z.string().optional(),
        meetingNo: z.string().optional(),
        minuteToken: z.string().optional(),
        query: z.string().optional(),
        dateScope: z.string().optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'larkMeeting', 'Running Lark Meeting workflow', async () => {
        const effectiveDateScope = input.dateScope ?? runtime.dateScope;
        if (input.operation === 'list' && effectiveDateScope) {
          return buildEnvelope({
            success: false,
            summary: 'Day-based meeting discovery is unsupported in the VC meetings API. Use larkCalendar for date-scoped meeting lookup.',
            errorKind: 'unsupported',
            retryable: false,
          });
        }
        if (input.operation === 'getMinute') {
          const minuteTokenOrUrl = input.minuteToken ?? input.query;
          if (!minuteTokenOrUrl?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'getMinute requires minuteToken or query.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const minute = await loadLarkMinutesService().getMinute({
            ...getLarkAuthInput(runtime),
            minuteTokenOrUrl,
          });
          return buildEnvelope({
            success: true,
            summary: `Fetched Lark minute ${asString(minute.title) ?? asString(minute.minuteToken) ?? 'minute'}.`,
            keyData: { meeting: minute },
            fullPayload: { minute },
          });
        }
        if (input.operation === 'get') {
          const meetingId = input.meetingId?.trim() || input.meetingNo?.trim();
          if (!meetingId) {
            return buildEnvelope({
              success: false,
              summary: 'get requires meetingId or meetingNo.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const meeting = await loadLarkMeetingsService().getMeeting({
            ...getLarkAuthInput(runtime),
            meetingId,
          });
          return buildEnvelope({
            success: true,
            summary: `Fetched Lark meeting ${asString(meeting.topic) ?? asString(meeting.meetingId) ?? 'meeting'}.`,
            keyData: { meeting },
            fullPayload: { meeting },
          });
        }
        const result = await loadLarkMeetingsService().listMeetings({
          ...getLarkAuthInput(runtime),
          pageSize: 20,
        });
        const normalizedQuery = input.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) =>
            `${asString(item.meetingId) ?? ''} ${asString(item.topic) ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        return buildEnvelope({
          success: true,
          summary: items.length > 0 ? `Found ${items.length} Lark meeting(s).` : 'No Lark meetings matched the request.',
          keyData: { items },
          fullPayload: { ...result, items },
        });
      }),
    }),

    larkApproval: tool({
      description: 'Comprehensive Lark Approvals tool for instance listing, lookup, and creation.',
      inputSchema: z.object({
        operation: z.enum(['listInstances', 'getInstance', 'createInstance']),
        approvalCode: z.string().optional(),
        instanceCode: z.string().optional(),
        status: z.string().optional(),
        pageSize: z.number().int().min(1).max(50).optional(),
        body: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'larkApproval', 'Running Lark Approvals workflow', async () => {
        const approvalsService = loadLarkApprovalsService();
        const defaults = await getLarkDefaults(runtime);
        if (input.operation === 'getInstance') {
          if (!input.instanceCode?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'getInstance requires instanceCode.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const instance = await approvalsService.getInstance({
            ...getLarkAuthInput(runtime),
            instanceCode: input.instanceCode.trim(),
          });
          return buildEnvelope({
            success: true,
            summary: `Fetched Lark approval instance ${asString(instance.title) ?? asString(instance.instanceCode) ?? 'instance'}.`,
            keyData: { instance },
            fullPayload: { instance },
          });
        }
        if (input.operation === 'listInstances') {
          const result = await approvalsService.listInstances({
            ...getLarkAuthInput(runtime),
            approvalCode: input.approvalCode?.trim() || defaults?.defaultApprovalCode,
            status: input.status,
            pageSize: input.pageSize,
          });
          return buildEnvelope({
            success: true,
            summary: result.items.length > 0 ? `Found ${result.items.length} Lark approval instance(s).` : 'No Lark approval instances matched the request.',
            keyData: { items: result.items },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        }
        const body = input.body;
        if (!body) {
          return buildEnvelope({
            success: false,
            summary: 'createInstance requires body.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }
        const instance = await approvalsService.createInstance({
          ...getLarkAuthInput(runtime),
          body: {
            ...body,
            ...(input.approvalCode?.trim() || defaults?.defaultApprovalCode
              ? { approval_code: input.approvalCode?.trim() || defaults?.defaultApprovalCode }
              : {}),
          },
        });
        return buildEnvelope({
          success: true,
          summary: `Created Lark approval instance ${asString(instance.title) ?? asString(instance.instanceCode) ?? 'instance'}.`,
          keyData: { instance },
          fullPayload: { instance },
        });
      }),
    }),

    larkBase: tool({
      description: 'Comprehensive Lark Base tool for bitable records.',
      inputSchema: z.object({
        operation: z.enum(['listApps', 'listTables', 'listViews', 'listFields', 'listRecords', 'getRecord', 'createRecord', 'updateRecord', 'deleteRecord']),
        appToken: z.string().optional(),
        tableId: z.string().optional(),
        viewId: z.string().optional(),
        recordId: z.string().optional(),
        query: z.string().optional(),
        filter: z.string().optional(),
        sort: z.string().optional(),
        fieldNames: z.array(z.string()).optional(),
        fields: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'larkBase', 'Running Lark Base workflow', async () => {
        const defaults = await getLarkDefaults(runtime);
        const appToken = input.appToken?.trim() || defaults?.defaultBaseAppToken;
        const tableId = input.tableId?.trim() || defaults?.defaultBaseTableId;
        const viewId = input.viewId?.trim() || defaults?.defaultBaseViewId;
        const authInput = getLarkAuthInput(runtime);
        const baseService = loadLarkBaseService();

        if (input.operation === 'listApps') {
          const result = await baseService.listApps({
            ...authInput,
            pageSize: 50,
          });
          return buildEnvelope({
            success: true,
            summary: result.items.length > 0 ? `Found ${result.items.length} Lark Base app(s).` : 'No Lark Base apps were found.',
            keyData: { items: result.items },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        }

        if (input.operation === 'listTables') {
          if (!appToken) {
            return buildEnvelope({
              success: false,
              summary: 'listTables requires appToken or a configured default Base app token.',
              errorKind: 'missing_input',
            });
          }
          const result = await baseService.listTables({
            ...authInput,
            appToken,
            pageSize: 50,
          });
          return buildEnvelope({
            success: true,
            summary: result.items.length > 0 ? `Found ${result.items.length} Lark Base table(s).` : 'No Lark Base tables were found.',
            keyData: { app: { appToken }, items: result.items },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        }

        if (input.operation === 'listViews') {
          if (!appToken || !tableId) {
            return buildEnvelope({
              success: false,
              summary: 'listViews requires appToken and tableId, or configured defaults.',
              errorKind: 'missing_input',
            });
          }
          const result = await baseService.listViews({
            ...authInput,
            appToken,
            tableId,
            pageSize: 50,
          });
          return buildEnvelope({
            success: true,
            summary: result.items.length > 0 ? `Found ${result.items.length} Lark Base view(s).` : 'No Lark Base views were found.',
            keyData: { app: { appToken }, table: { tableId }, items: result.items },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        }

        if (input.operation === 'listFields') {
          if (!appToken || !tableId) {
            return buildEnvelope({
              success: false,
              summary: 'listFields requires appToken and tableId, or configured defaults.',
              errorKind: 'missing_input',
            });
          }
          const result = await baseService.listFields({
            ...authInput,
            appToken,
            tableId,
            pageSize: 200,
          });
          const filteredItems = input.fieldNames && input.fieldNames.length > 0
            ? result.items.filter((item) =>
              input.fieldNames?.some((fieldName) => (asString(item.fieldName) ?? '').toLowerCase() === fieldName.toLowerCase()))
            : result.items;
          return buildEnvelope({
            success: true,
            summary: filteredItems.length > 0 ? `Found ${filteredItems.length} Lark Base field(s).` : 'No Lark Base fields matched the request.',
            keyData: { app: { appToken }, table: { tableId }, items: filteredItems },
            fullPayload: { ...result, items: filteredItems },
          });
        }

        if (input.operation === 'getRecord') {
          if (!appToken || !tableId || !input.recordId?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'getRecord requires appToken, tableId, and recordId, or configured app/table defaults.',
              errorKind: 'missing_input',
            });
          }
          const record = await baseService.getRecord({
            ...authInput,
            appToken,
            tableId,
            recordId: input.recordId.trim(),
          });
          return buildEnvelope({
            success: true,
            summary: `Fetched Lark Base record ${record.recordId}.`,
            keyData: { app: { appToken }, table: { tableId }, record },
            fullPayload: { record },
          });
        }

        if (input.operation === 'deleteRecord') {
          if (!appToken || !tableId || !input.recordId?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'deleteRecord requires appToken, tableId, and recordId, or configured app/table defaults.',
              errorKind: 'missing_input',
            });
          }
          await baseService.deleteRecord({
            ...authInput,
            appToken,
            tableId,
            recordId: input.recordId.trim(),
          });
          return buildEnvelope({
            success: true,
            summary: `Deleted Lark Base record ${input.recordId.trim()}.`,
            keyData: {
              app: { appToken },
              table: { tableId },
              record: { recordId: input.recordId.trim() },
            },
          });
        }

        if (input.operation === 'listRecords') {
          if (!appToken || !tableId) {
            return buildEnvelope({
              success: false,
              summary: 'listRecords requires appToken and tableId, or configured defaults.',
              errorKind: 'missing_input',
            });
          }
          const result = await baseService.listRecords({
            ...authInput,
            appToken,
            tableId,
            viewId,
            pageSize: 50,
          });
          const normalizedQuery = input.query?.trim().toLowerCase();
          const items = normalizedQuery
            ? result.items.filter((item) =>
              `${asString(item.recordId) ?? ''} ${JSON.stringify(asRecord(item.fields) ?? {})}`.toLowerCase().includes(normalizedQuery))
            : result.items;
          return buildEnvelope({
            success: true,
            summary: items.length > 0 ? `Found ${items.length} Lark Base record(s).` : 'No Lark Base records matched the request.',
            keyData: {
              app: { appToken },
              table: { tableId },
              view: viewId ? { viewId } : undefined,
              items,
            },
            fullPayload: { ...result, items },
          });
        }

        if (!appToken || !tableId || !input.fields) {
          return buildEnvelope({
            success: false,
            summary: `${input.operation} requires appToken, tableId, and fields, or configured app/table defaults.`,
            errorKind: 'missing_input',
          });
        }
        const record = input.operation === 'createRecord'
          ? await baseService.createRecord({
            ...authInput,
            appToken,
            tableId,
            fields: input.fields,
          })
          : await baseService.updateRecord({
            ...authInput,
            appToken,
            tableId,
            recordId: input.recordId?.trim() ?? '',
            fields: input.fields,
          });
        return buildEnvelope({
          success: true,
          summary: `${input.operation === 'createRecord' ? 'Created' : 'Updated'} Lark Base record ${asString(record.recordId) ?? 'record'}.`,
          keyData: {
            app: { appToken },
            table: { tableId },
            record,
          },
          fullPayload: { record },
        });
      }),
    }),

    larkDoc: tool({
      description: 'Comprehensive Lark Docs tool for create, edit, read, and inspect.',
      inputSchema: z.object({
        operation: z.enum(['create', 'edit', 'read', 'inspect']),
        documentId: z.string().optional(),
        title: z.string().optional(),
        markdown: z.string().optional(),
        instruction: z.string().optional(),
        strategy: z.enum(['replace', 'append', 'patch', 'delete']).optional(),
        query: z.string().optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'larkDoc', 'Running Lark Docs workflow', async () => {
        const larkDocsService = loadLarkDocsService();
        const conversationKey = buildConversationKey(runtime.threadId);
        if (input.operation === 'create') {
          if (!input.title?.trim() || !input.markdown) {
            return buildEnvelope({
              success: false,
              summary: 'create requires title and markdown.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const result = await larkDocsService.createMarkdownDoc({
            ...getLarkAuthInput(runtime),
            title: input.title,
            markdown: input.markdown,
          });
          conversationMemoryStore.addLarkDoc(conversationKey, {
            title: asString(result.title) ?? input.title,
            documentId: asString(result.documentId) ?? '',
            url: asString(result.url),
          });
          return buildEnvelope({
            success: true,
            summary: `Created Lark Doc ${asString(result.url) ?? asString(result.documentId) ?? 'document'}.`,
            keyData: {
              documentId: asString(result.documentId),
              docUrl: asString(result.url),
              blockCount: typeof result.blockCount === 'number' ? result.blockCount : undefined,
            },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        }
        if (input.operation === 'edit') {
          const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
          const documentId = input.documentId?.trim() || latestDoc?.documentId;
          if (!documentId) {
            return buildEnvelope({
              success: false,
              summary: 'No prior Lark Doc was found in this conversation. Please provide documentId.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const result = await larkDocsService.editMarkdownDoc({
            ...getLarkAuthInput(runtime),
            documentId,
            instruction: input.instruction ?? 'Update the document.',
            strategy: input.strategy ?? 'patch',
            ...(input.markdown ? { newMarkdown: input.markdown } : {}),
          });
          conversationMemoryStore.addLarkDoc(conversationKey, {
            title: latestDoc?.title ?? 'Lark Doc',
            documentId: asString(result.documentId) ?? documentId,
            url: asString(result.url),
          });
          return buildEnvelope({
            success: true,
            summary: `Updated Lark Doc ${asString(result.url) ?? asString(result.documentId) ?? documentId}.`,
            keyData: {
              documentId: asString(result.documentId) ?? documentId,
              docUrl: asString(result.url),
            },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        }

        const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
        const documentId = input.documentId?.trim() || latestDoc?.documentId;
        if (!documentId) {
          return buildEnvelope({
            success: false,
            summary: 'No prior Lark Doc was found in this conversation. Please provide documentId.',
            errorKind: 'missing_input',
          });
        }
        try {
          const larkDocsService = loadLarkDocsService();
          const result = input.operation === 'read'
            ? await larkDocsService.readDocument({
              companyId: runtime.companyId,
              larkTenantKey: runtime.larkTenantKey,
              appUserId: runtime.userId,
              credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
              documentId,
            })
            : await larkDocsService.inspectDocument({
            companyId: runtime.companyId,
            larkTenantKey: runtime.larkTenantKey,
            appUserId: runtime.userId,
            credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
            documentId,
          });
          return buildEnvelope({
            success: true,
            summary: input.operation === 'read'
              ? `Read Lark Doc ${documentId}.`
              : `Inspected Lark Doc ${documentId}.`,
            keyData: {
              documentId,
              docUrl: asString(result.url),
              blockCount: typeof result.blockCount === 'number' ? result.blockCount : undefined,
              headings: asArray(result.headings).filter((value): value is string => typeof value === 'string'),
            },
            fullPayload: result as unknown as Record<string, unknown>,
          });
        } catch (error) {
          return buildEnvelope({
            success: false,
            summary: error instanceof Error ? error.message : 'Failed to inspect Lark Doc.',
            errorKind: 'api_failure',
            retryable: true,
          });
        }
      }),
    }),

    zoho: tool({
      description: 'Comprehensive Zoho CRM tool for search context and grounded record reads.',
      inputSchema: z.object({
        operation: z.enum(['searchContext', 'readRecords', 'summarizePipeline', 'getRecord', 'createRecord', 'updateRecord', 'deleteRecord']),
        query: z.string().optional(),
        module: z.string().optional(),
        recordId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
        fields: z.record(z.unknown()).optional(),
        trigger: z.array(z.string()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'zoho', 'Running Zoho workflow', async () => {
        const readPermissionError = ensureAnyActionPermission(
          runtime,
          ['search-zoho-context', 'read-zoho-records', 'zoho-agent', 'zoho-read'],
          'read',
          'zoho',
        );
        const sourceType = normalizeZohoSourceType(input.module);

        if (input.operation === 'searchContext') {
          if (readPermissionError) {
            return readPermissionError;
          }
          if (!input.query?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'searchContext requires query.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          try {
            const companyId = await loadCompanyContextResolver().resolveCompanyId({
              companyId: runtime.companyId,
              larkTenantKey: runtime.larkTenantKey,
            });
            const { COMPANY_CONTROL_KEYS, isCompanyControlEnabled } = loadRuntimeControls();
            const strictUserScopeEnabled = await isCompanyControlEnabled({
              controlKey: COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled,
              companyId,
              defaultValue: true,
            });
            const scopeMode = strictUserScopeEnabled
              ? await loadZohoRoleAccessService().resolveScopeMode(companyId, runtime.requesterAiRole)
              : 'company_scoped';
            const matches = await loadZohoRetrievalService().query({
              companyId,
              requesterUserId: runtime.userId,
              requesterEmail: runtime.requesterEmail,
              scopeMode,
              strictUserScopeEnabled,
              text: input.query.trim(),
              limit: 5,
            });
            const normalizedMatches = matches.map((entry) => {
              const record = asRecord(entry) ?? {};
              const payload = asRecord(record.payload) ?? {};
              return {
                type: asString(record.sourceType),
                id: asString(record.sourceId),
                score: typeof record.score === 'number' ? record.score : undefined,
                data: payload,
              };
            });
            const citations = normalizedMatches.flatMap((entry, index) => {
              const sourceType = entry.type;
              const sourceId = entry.id;
              if (!sourceType || !sourceId) return [];
              return [{
                id: `zoho-${index + 1}`,
                title: `${sourceType}:${sourceId}`,
                kind: 'record',
                sourceType,
                sourceId,
              }];
            });
            return buildEnvelope({
              success: true,
              summary: normalizedMatches.length > 0
                ? `Found ${normalizedMatches.length} relevant Zoho record(s).`
                : 'No Zoho records matched the context search.',
              keyData: {
                recordId: normalizedMatches[0]?.id,
                recordType: normalizedMatches[0]?.type ?? input.module,
              },
              fullPayload: {
                companyId,
                scopeMode,
                records: normalizedMatches,
              },
              citations,
            });
          } catch (error) {
            const summary = error instanceof Error ? error.message : 'Zoho context search failed.';
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: true,
            });
          }
        }

        if (input.operation === 'getRecord') {
          if (readPermissionError) {
            return readPermissionError;
          }
          if (!sourceType || !input.recordId?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'getRecord requires module and recordId.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          try {
            const record = await loadZohoDataClient().fetchRecordBySource({
              companyId: runtime.companyId,
              sourceType,
              sourceId: input.recordId.trim(),
            });
            if (!record) {
              return buildEnvelope({
                success: false,
                summary: `No Zoho record was found for ${input.module} ${input.recordId.trim()}.`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            return buildEnvelope({
              success: true,
              summary: `Fetched Zoho ${input.module?.trim() ?? 'record'} ${input.recordId.trim()}.`,
              keyData: {
                recordId: input.recordId.trim(),
                recordType: sourceType,
              },
              fullPayload: {
                record,
              },
              citations: [{
                id: `zoho-record-${input.recordId.trim()}`,
                title: `${sourceType}:${input.recordId.trim()}`,
                kind: 'record',
                sourceType,
                sourceId: input.recordId.trim(),
              }],
            });
          } catch (error) {
            const summary = error instanceof Error ? error.message : 'Failed to fetch Zoho record.';
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: true,
            });
          }
        }

        if (input.operation === 'createRecord' || input.operation === 'updateRecord' || input.operation === 'deleteRecord') {
          const actionGroup: ToolActionGroup =
            input.operation === 'createRecord'
              ? 'create'
              : input.operation === 'updateRecord'
                ? 'update'
                : 'delete';
          const permissionError = ensureAnyActionPermission(runtime, ['zoho-write', 'zoho-agent'], actionGroup, 'zoho');
          if (permissionError) {
            return permissionError;
          }
          if (!sourceType) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires a supported Zoho module such as Leads, Contacts, Deals, or Cases.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (input.operation !== 'createRecord' && !input.recordId?.trim()) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires recordId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if ((input.operation === 'createRecord' || input.operation === 'updateRecord') && !input.fields) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires fields.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const subject =
            input.operation === 'createRecord'
              ? `Create Zoho ${input.module?.trim() ?? sourceType}`
              : `${input.operation === 'updateRecord' ? 'Update' : 'Delete'} Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim();
          const summary =
            input.operation === 'createRecord'
              ? `Approval required to create a Zoho ${input.module?.trim() ?? sourceType}.`
              : input.operation === 'updateRecord'
                ? `Approval required to update Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                : `Approval required to delete Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim();
          return createPendingRemoteApproval({
            runtime,
            toolId: 'zoho-write',
            actionGroup,
            operation: input.operation,
            summary,
            subject,
            explanation: 'Zoho CRM mutations are approval-gated. Review the module, record target, and field payload before proceeding.',
            payload: {
              operation: input.operation,
              module: input.module?.trim(),
              sourceType,
              recordId: input.recordId?.trim(),
              fields: input.fields,
              trigger: input.trigger,
            },
          });
        }

        if (readPermissionError) {
          return readPermissionError;
        }
        if (!input.query?.trim()) {
          return buildEnvelope({
            success: false,
            summary: `${input.operation} requires query.`,
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const objectiveParts = [input.query.trim()];
        if (input.module?.trim()) objectiveParts.push(`Module: ${input.module.trim()}`);
        if (input.recordId?.trim()) objectiveParts.push(`Record ID: ${input.recordId.trim()}`);
        if (input.filters && Object.keys(input.filters).length > 0) {
          objectiveParts.push(`Filters: ${JSON.stringify(input.filters)}`);
        }
        const agentResult = await loadZohoReadAgent().invoke(
          buildAgentInvokeInput(runtime, 'zoho-read', objectiveParts.join('\n'), {
            filters: input.filters,
          }),
        );
        const result = asRecord(asRecord(agentResult)?.result);
        const sourceRefs = asArray(result?.sourceRefs).map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
        const citations = sourceRefs.flatMap((entry, index) => {
          const id = asString(entry.id);
          if (!id) return [];
          const [sourceType, rest] = id.split(':', 2);
          return [{
            id: `zoho-read-${index + 1}`,
            title: id,
            kind: 'record',
            sourceType,
            sourceId: rest ?? id,
          }];
        });
        return toEnvelopeFromAgentResult(agentResult, {
          keyData: {
            recordId: input.recordId,
            recordType: input.module,
          },
          fullPayload: result,
          citations,
        });
      }),
    }),

    outreach: tool({
      description: 'Comprehensive Outreach publisher inventory tool.',
      inputSchema: z.object({
        operation: z.enum(['searchPublishers', 'getCampaign', 'summarizeInventory']),
        query: z.string().min(1),
        campaignId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => withLifecycle(hooks, 'outreach', 'Running Outreach workflow', async () => {
        if (input.operation === 'getCampaign') {
          return buildEnvelope({
            success: false,
            summary: 'Outreach campaign lookup is not implemented in the current outreach integration. Use searchPublishers or summarizeInventory instead.',
            errorKind: 'unsupported',
            retryable: false,
          });
        }
        const agentResult = await loadOutreachReadAgent().invoke(
          buildAgentInvokeInput(runtime, 'outreach-read', input.query, {
            filters: input.filters,
            rawFilterString: typeof input.filters?.rawFilterString === 'string' ? input.filters.rawFilterString : undefined,
          }),
        );
        const result = asRecord(asRecord(agentResult)?.result);
        const records = asArray(result?.records).map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
        const citations = records.flatMap((entry, index) => {
          const website = asString(entry.website);
          const id = asString(entry.id) ?? website;
          if (!id) return [];
          return [{
            id: `outreach-${index + 1}`,
            title: website ?? id,
            url: website ? `https://${website.replace(/^https?:\/\//i, '')}` : undefined,
            kind: 'record',
            sourceType: 'outreach',
            sourceId: id,
          }];
        });
        return toEnvelopeFromAgentResult(agentResult, {
          keyData: {
            campaignId: input.campaignId,
            recipientCount: records.length,
          },
          fullPayload: result,
          citations,
        });
      }),
    }),
  };

  const filteredEntries = Object.entries(tools).filter(([toolName]) => isVercelToolAllowed(runtime, toolName));

  logger.info('vercel.tools.filtered', {
    threadId: runtime.threadId,
    executionId: runtime.executionId,
    requesterAiRole: runtime.requesterAiRole,
    allowedToolIds: runtime.allowedToolIds,
    exposedTools: filteredEntries.map(([toolName]) => toolName),
  });

  return Object.fromEntries(filteredEntries);
};

export type VercelDesktopTools = Record<string, any>;
