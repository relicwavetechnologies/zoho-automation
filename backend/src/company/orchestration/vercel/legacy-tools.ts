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
import type { MemberSessionDTO } from '../../../modules/member-auth/member-auth.service';
import { discoverRepositories, inspectRepository, retrieveRepositoryFile } from './repo-tool';
import { formatZohoGatewayDeniedMessage } from '../../integrations/zoho/zoho-gateway-denials';

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
  listTasklists: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listTasks: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  createTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  addMembers: (input: Record<string, unknown>) => Promise<void>;
  removeMembers: (input: Record<string, unknown>) => Promise<void>;
  deleteTask: (input: Record<string, unknown>) => Promise<void>;
} => loadModuleExport('../../channels/lark/lark-tasks.service', 'larkTasksService');

const loadLarkCalendarService = (): {
  getPrimaryCalendar: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listCalendars: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listEvents: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  createEvent: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateEvent: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteEvent: (input: Record<string, unknown>) => Promise<void>;
  listFreebusy: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  addEventAttendees: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-calendar.service', 'larkCalendarService');

const loadLarkMeetingsService = (): {
  listMeetings: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getMeeting: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-meetings.service', 'larkMeetingsService');

const loadLarkMinutesService = (): {
  getMinute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-minutes.service', 'larkMinutesService');

const loadLarkApprovalsService = (): {
  listInstances: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getInstance: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createInstance: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-approvals.service', 'larkApprovalsService');

const loadLarkMessagingService = (): {
  sendDirectTextMessage: (input: {
    companyId?: string;
    larkTenantKey?: string;
    appUserId?: string;
    credentialMode?: 'tenant' | 'user_linked';
    recipientOpenId: string;
    text: string;
  }) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-messaging.service', 'larkMessagingService');

const loadLarkBaseService = (): {
  listApps: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listTables: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listViews: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  listFields: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getRecord: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteRecord: (input: Record<string, unknown>) => Promise<void>;
} => loadModuleExport('../../channels/lark/lark-base.service', 'larkBaseService');

const loadLarkOperationalConfigRepository = (): LarkOperationalConfigLike =>
  loadModuleExport<LarkOperationalConfigLike>(
    '../../channels/lark/lark-operational-config.repository',
    'larkOperationalConfigRepository',
  );

const loadLarkRuntimeClientError = (): { new (...args: any[]): Error } =>
  loadModuleExport('../../channels/lark/lark-runtime-client', 'LarkRuntimeClientError');

const loadResolveLarkTaskAssignees = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) => loadModuleExport('./lark-helpers', 'resolveLarkTaskAssignees');

const loadListLarkTaskAssignablePeople = (): ((
  input: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>) =>
  loadModuleExport('./lark-helpers', 'listLarkTaskAssignablePeople');

const loadCanonicalizeLarkPersonIds = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  resolvedIds: string[];
  unresolvedIds: string[];
  ambiguousIds: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) => loadModuleExport('./lark-helpers', 'canonicalizeLarkPersonIds');

const loadResolveLarkPeople = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) => loadModuleExport('./lark-helpers', 'resolveLarkPeople');

const loadListLarkPeople = (): ((
  input: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>) =>
  loadModuleExport('./lark-helpers', 'listLarkPeople');

const loadNormalizeLarkTimestamp = (): ((
  value?: string,
  timeZone?: string,
) => string | undefined) => loadModuleExport('./lark-helpers', 'normalizeLarkTimestamp');

const loadWebSearchService = (): {
  search: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/search/web-search.service', 'webSearchService');

const loadSearchIntegrationError = (): { new (...args: any[]): Error } =>
  loadModuleExport('../../integrations/search/web-search.service', 'SearchIntegrationError');

const loadFileUploadService = (): {
  listVisibleFiles: (input: {
    companyId: string;
    requesterUserId: string;
    requesterAiRole: string;
    isAdmin?: boolean;
  }) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../../modules/file-upload/file-upload.service', 'fileUploadService');

const loadDesktopWorkflowsService = (): {
  createDraft: (
    session: MemberSessionDTO,
    input?: { name?: string | null; departmentId?: string | null },
  ) => Promise<Record<string, any>>;
  get: (session: MemberSessionDTO, workflowId: string) => Promise<Record<string, any>>;
  author: (
    session: MemberSessionDTO,
    workflowId: string,
    message: string,
    attachedFiles?: Array<{
      fileAssetId: string;
      cloudinaryUrl: string;
      mimeType: string;
      fileName: string;
    }>,
  ) => Promise<Record<string, any>>;
  update: (
    session: MemberSessionDTO,
    workflowId: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, any>>;
  publish: (
    session: MemberSessionDTO,
    input: Record<string, unknown>,
  ) => Promise<Record<string, any>>;
  runNow: (
    session: MemberSessionDTO,
    workflowId: string,
    overrideText?: string | null,
  ) => Promise<Record<string, any>>;
  setScheduleState: (
    session: MemberSessionDTO,
    workflowId: string,
    scheduleEnabled: boolean,
  ) => Promise<Record<string, any>>;
  listVisibleSummaries: (session: MemberSessionDTO) => Promise<Array<Record<string, any>>>;
  resolveVisibleWorkflow: (
    session: MemberSessionDTO,
    reference: string,
  ) => Promise<Record<string, any>>;
} =>
  loadModuleExport(
    '../../../modules/desktop-workflows/desktop-workflows.service',
    'desktopWorkflowsService',
  );

const loadWorkflowScheduleHelpers = (): {
  zonedDateTimeToUtc: (input: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    timeZone: string;
  }) => Date;
} => ({
  zonedDateTimeToUtc: loadModuleExport(
    '../../../modules/desktop-workflows/desktop-workflows.schedule',
    'zonedDateTimeToUtc',
  ),
});

const loadDocumentTextHelpers = (): {
  extractTextFromBuffer: (buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
  normalizeExtractedText: (rawText: string, maxWords?: number) => string;
} =>
  require('../../../modules/file-upload/document-text-extractor') as {
    extractTextFromBuffer: (buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
    normalizeExtractedText: (rawText: string, maxWords?: number) => string;
  };

const loadFileRetrievalService = (): {
  search: (input: {
    companyId: string;
    query: string;
    requesterAiRole?: string;
    fileAssetId?: string;
    limit?: number;
    preferParentContext?: boolean;
  }) => Promise<{
    matches: Array<Record<string, unknown>>;
    citations: Array<Record<string, unknown>>;
    enhancements: string[];
    queriesUsed: string[];
    correctiveRetryUsed: boolean;
  }>;
  readChunkContext: (input: {
    companyId: string;
    fileAssetId: string;
    chunkIndex?: number;
  }) => Promise<{ text: string; source: 'parent_section' | 'chunk' | 'document' | 'missing' }>;
  getIndexedFileText: (input: {
    companyId: string;
    fileAssetId: string;
    maxChars?: number;
  }) => Promise<string>;
} => loadModuleExport('../../retrieval/file-retrieval.service', 'fileRetrievalService');

const loadZohoReadAgent = (): {
  invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => new (loadModuleExport('../../agents/implementations/zoho-read.agent', 'ZohoReadAgent'))();

const loadOutreachReadAgent = (): {
  invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} =>
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
  listModuleRecords?: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  getModuleRecord?: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  createModuleRecord?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateModuleRecord?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteModuleRecord?: (input: Record<string, unknown>) => Promise<void>;
  listNotes?: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  listModuleNotes?: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  getNote?: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  createNote?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createModuleNote?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateNote?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteNote?: (input: Record<string, unknown>) => Promise<void>;
  listAttachments?: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  listModuleAttachments?: (
    input: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
  getAttachmentContent?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getModuleAttachmentContent?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  uploadAttachment?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  uploadModuleAttachment?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteAttachment?: (input: Record<string, unknown>) => Promise<void>;
  deleteModuleAttachment?: (input: Record<string, unknown>) => Promise<void>;
  listModuleFields?: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
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
  importBankStatement?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getLastImportedBankStatement?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getMatchingBankTransactions?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getInvoiceEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getInvoicePaymentReminderContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getEstimateEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getCreditNoteEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getSalesOrderEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getPurchaseOrderEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getContactStatementEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getVendorPaymentEmailContent?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  listTemplates?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getAttachment?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getRecordDocument?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  applyTemplate?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  uploadAttachment?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  deleteAttachment?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  listComments?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  addComment?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  updateComment?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  deleteComment?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
  getReport?: (
    input: Record<string, unknown>,
  ) => Promise<{ organizationId: string; payload: Record<string, unknown> }>;
} => loadModuleExport('../../integrations/zoho/zoho-books.client', 'zohoBooksClient');

const loadZohoFinanceOpsService = (): {
  buildOverdueReport: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  mapCustomerPayments: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reconcileVendorStatement: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reconcileBankClosing: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/zoho/zoho-finance-ops.service', 'zohoFinanceOpsService');

const loadZohoGatewayService = (): {
  resolveScopeContext: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listAuthorizedRecords: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getAuthorizedRecord: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getAuthorizedChildResource: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  executeAuthorizedMutation: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/zoho/zoho-gateway.service', 'zohoGatewayService');

const workflowAttachedFileSchema = z
  .object({
    fileAssetId: z.string().min(1),
    cloudinaryUrl: z.string().url(),
    mimeType: z.string().min(1),
    fileName: z.string().min(1),
  })
  .strict();

const workflowDestinationSchema = z
  .object({
    kind: z.enum(['desktop_inbox', 'desktop_thread', 'lark_chat']),
    label: z.string().trim().max(160).optional(),
    value: z.string().trim().max(200).optional(),
  })
  .strict();

const workflowScheduleInputSchema = z
  .object({
    frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'one_time']),
    timezone: z.string().trim().min(1).max(100).optional(),
    time: z
      .string()
      .trim()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    intervalHours: z.number().int().min(1).max(24).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    dayOfWeek: z
      .enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
      .optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    runDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

const WORKFLOW_DAY_CODE_BY_VALUE: Record<string, 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'> = {
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
  sunday: 'SU',
};

const buildRuntimeWorkflowSession = (runtime: VercelRuntimeRequestContext): MemberSessionDTO => ({
  userId: runtime.userId,
  companyId: runtime.companyId,
  role: runtime.requesterAiRole,
  aiRole: runtime.requesterAiRole,
  sessionId: runtime.executionId,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  authProvider: runtime.channel === 'lark' ? 'lark' : 'password',
  email: runtime.requesterEmail ?? '',
  larkTenantKey: runtime.larkTenantKey,
  larkOpenId: runtime.larkOpenId,
  larkUserId: runtime.larkUserId,
  resolvedDepartmentId: runtime.departmentId,
  resolvedDepartmentName: runtime.departmentName,
  resolvedDepartmentRoleSlug: runtime.departmentRoleSlug,
});

const buildRuntimeWorkflowDestinations = (
  runtime: VercelRuntimeRequestContext,
): Array<z.infer<typeof workflowDestinationSchema>> => {
  if (runtime.channel === 'lark' && runtime.chatId) {
    return [
      {
        kind: 'lark_chat',
        label: 'Current Lark chat',
        value: runtime.chatId,
      },
    ];
  }
  return [
    {
      kind: 'desktop_thread',
      label: 'Current desktop thread',
      value: runtime.threadId,
    },
  ];
};

const toWorkflowOutputConfig = (destinations: Array<z.infer<typeof workflowDestinationSchema>>) => {
  const sourceDestinations =
    destinations.length > 0
      ? destinations
      : [{ kind: 'desktop_inbox', label: 'Desktop inbox' } as const];

  const normalizedDestinations = sourceDestinations.map((destination) => {
    if (destination.kind === 'desktop_inbox') {
      return {
        id: 'desktop_inbox',
        kind: 'desktop_inbox' as const,
        label: destination.label || 'Desktop inbox',
      };
    }
    if (destination.kind === 'desktop_thread') {
      return {
        id: 'desktop_thread',
        kind: 'desktop_thread' as const,
        label: destination.label || 'Desktop thread',
        threadId: destination.value || destination.label || 'desktop-thread',
      };
    }
    return {
      id: 'lark_chat',
      kind: 'lark_chat' as const,
      label: destination.label || 'Lark chat',
      chatId: destination.value || destination.label || 'lark-chat',
    };
  });

  return {
    version: 'v1' as const,
    destinations: normalizedDestinations,
    defaultDestinationIds: normalizedDestinations.map((destination) => destination.id),
  };
};

const buildWorkflowOutputConfigSignature = (value: unknown): string => {
  const record = asRecord(value);
  const destinations = asArray(record?.destinations)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((destination) =>
      [
        asString(destination.kind) ?? '',
        asString(destination.id) ?? '',
        asString(destination.threadId) ?? '',
        asString(destination.chatId) ?? '',
        asString(destination.label) ?? '',
      ].join(':'),
    )
    .sort();
  const defaultIds = asArray(record?.defaultDestinationIds)
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .sort();
  return JSON.stringify({ destinations, defaultIds });
};

const shouldAdoptRuntimeWorkflowDestinations = (
  currentOutputConfig: unknown,
  desiredOutputConfig: ReturnType<typeof toWorkflowOutputConfig>,
): boolean =>
  buildWorkflowOutputConfigSignature(currentOutputConfig) !==
  buildWorkflowOutputConfigSignature(desiredOutputConfig);

const parseWorkflowTime = (value: string): { hour: number; minute: number } => {
  const [hour, minute] = value.split(':').map((part) => Number(part));
  return { hour, minute };
};

const toWorkflowScheduleConfig = (
  input: z.infer<typeof workflowScheduleInputSchema>,
):
  | { ok: true; schedule: Record<string, unknown> }
  | { ok: false; summary: string; userAction: string } => {
  const timezone = input.timezone?.trim() || 'Asia/Kolkata';
  if (input.frequency === 'hourly') {
    if (!input.intervalHours) {
      return {
        ok: false,
        summary: 'Hourly schedules need intervalHours.',
        userAction: 'Ask the user how many hours apart the workflow should run.',
      };
    }
    return {
      ok: true,
      schedule: {
        type: 'hourly',
        timezone,
        intervalHours: input.intervalHours,
        minute: input.minute ?? 0,
      },
    };
  }
  if (input.frequency === 'daily') {
    if (!input.time) {
      return {
        ok: false,
        summary: 'Daily schedules need a time.',
        userAction: 'Ask the user what time the workflow should run each day.',
      };
    }
    return { ok: true, schedule: { type: 'daily', timezone, time: parseWorkflowTime(input.time) } };
  }
  if (input.frequency === 'weekly') {
    if (!input.time || !input.dayOfWeek) {
      return {
        ok: false,
        summary: 'Weekly schedules need both a dayOfWeek and time.',
        userAction: 'Ask the user which weekday and time the workflow should run.',
      };
    }
    return {
      ok: true,
      schedule: {
        type: 'weekly',
        timezone,
        time: parseWorkflowTime(input.time),
        daysOfWeek: [WORKFLOW_DAY_CODE_BY_VALUE[input.dayOfWeek]],
      },
    };
  }
  if (input.frequency === 'monthly') {
    if (!input.time || !input.dayOfMonth) {
      return {
        ok: false,
        summary: 'Monthly schedules need both a dayOfMonth and time.',
        userAction: 'Ask the user which day of the month and time the workflow should run.',
      };
    }
    return {
      ok: true,
      schedule: {
        type: 'monthly',
        timezone,
        time: parseWorkflowTime(input.time),
        dayOfMonth: input.dayOfMonth,
      },
    };
  }
  if (!input.runDate || !input.time) {
    return {
      ok: false,
      summary: 'One-time schedules need both runDate and time.',
      userAction: 'Ask the user which date and time the workflow should run once.',
    };
  }
  const zonedRunAt = loadWorkflowScheduleHelpers().zonedDateTimeToUtc({
    year: Number(input.runDate.slice(0, 4)),
    month: Number(input.runDate.slice(5, 7)),
    day: Number(input.runDate.slice(8, 10)),
    hour: parseWorkflowTime(input.time).hour,
    minute: parseWorkflowTime(input.time).minute,
    timeZone: timezone,
  });
  return {
    ok: true,
    schedule: {
      type: 'one_time',
      timezone,
      runAt: zonedRunAt.toISOString(),
    },
  };
};

const summarizeWorkflowCandidates = (candidates: Array<Record<string, unknown>>): string =>
  candidates
    .slice(0, 6)
    .map((candidate) => {
      const id = asString(candidate.id) ?? 'unknown';
      const name = asString(candidate.name) ?? 'Unnamed workflow';
      const status = asString(candidate.status) ?? 'unknown';
      return `- ${name} (${id}) [${status}]`;
    })
    .join('\n');

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

type DesktopWsGatewayLike = {
  getPolicyDecision: (
    userId: string,
    companyId: string,
    action: RemoteDesktopLocalAction,
  ) => {
    status: 'allow' | 'ask' | 'deny' | 'none' | 'ambiguous';
    session?: {
      wsSessionId: string;
      activeWorkspace?: { path: string; name: string };
    };
  };
  dispatchRemoteLocalAction: (input: {
    userId: string;
    companyId: string;
    action: RemoteDesktopLocalAction;
    reason?: string;
    overrideAsk?: boolean;
  }) => Promise<{
    kind: RemoteDesktopLocalAction['kind'];
    ok: boolean;
    summary: string;
    payload?: Record<string, unknown>;
  }>;
};

const loadDesktopWsGateway = (): DesktopWsGatewayLike =>
  loadModuleExport<DesktopWsGatewayLike>(
    '../../../modules/desktop-live/desktop-ws.gateway',
    'desktopWsGateway',
  );

const loadRuntimeControls = (): {
  COMPANY_CONTROL_KEYS: { zohoUserScopedReadStrictEnabled: string };
  isCompanyControlEnabled: (input: Record<string, unknown>) => Promise<boolean>;
} =>
  require('../../support/runtime-controls') as {
    COMPANY_CONTROL_KEYS: { zohoUserScopedReadStrictEnabled: string };
    isCompanyControlEnabled: (input: Record<string, unknown>) => Promise<boolean>;
  };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

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
  if (
    lowered.includes('required') ||
    lowered.includes('please provide') ||
    lowered.includes('no current')
  )
    return 'missing_input';
  if (lowered.includes('unsupported')) return 'unsupported';
  if (lowered.includes('invalid') || lowered.includes('failed:')) return 'validation';
  return 'api_failure';
};

const normalizeCitations = (value: unknown): VercelCitation[] => {
  return asArray(value).flatMap((entry, index) => {
    const record = asRecord(entry);
    if (!record) return [];
    const id =
      typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : typeof record.url === 'string' && record.url.trim()
          ? `citation-${index + 1}`
          : null;
    if (!id) return [];
    return [
      {
        id,
        title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id,
        url: typeof record.url === 'string' ? record.url : undefined,
        kind: typeof record.kind === 'string' ? record.kind : undefined,
        sourceType: typeof record.sourceType === 'string' ? record.sourceType : undefined,
        sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
        fileAssetId: typeof record.fileAssetId === 'string' ? record.fileAssetId : undefined,
        chunkIndex: typeof record.chunkIndex === 'number' ? record.chunkIndex : undefined,
      },
    ];
  });
};

const uniqueDefinedStrings = (values: Array<string | undefined>): string[] =>
  Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  );

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
    return [
      {
        id: fallbackIds[index] ?? `web-${index + 1}`,
        title: asString(item.title) ?? url,
        url,
        kind: 'web',
        sourceType: 'web',
        sourceId: fallbackIds[index] ?? url,
      },
    ];
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

const buildZohoGatewayDeniedEnvelope = (
  authResult: Record<string, unknown>,
  fallbackSummary: string,
): VercelToolEnvelope => {
  const denialReason = asString(authResult.denialReason);
  const moduleName = asString(authResult.module);
  const formatted = formatZohoGatewayDeniedMessage(authResult, fallbackSummary);

  return buildEnvelope({
    success: false,
    summary: formatted.summary,
    errorKind: formatted.errorKind,
    retryable: false,
    ...(formatted.userAction ? { userAction: formatted.userAction } : {}),
    fullPayload: denialReason
      ? {
          denialReason,
          module: moduleName,
        }
      : undefined,
  });
};

const buildZohoGatewayRequester = (
  runtime: VercelRuntimeRequestContext,
): Record<string, unknown> => ({
  companyId: runtime.companyId,
  userId: runtime.userId,
  departmentId: runtime.departmentId,
  departmentRoleSlug: runtime.departmentRoleSlug,
  requesterEmail: runtime.requesterEmail,
  requesterAiRole: runtime.requesterAiRole,
  departmentZohoReadScope: runtime.departmentZohoReadScope,
});

const buildBooksMutationAuthorizationTarget = (input: {
  operation: string;
  moduleName?: string;
  recordId?: string;
  accountId?: string;
  transactionId?: string;
  invoiceId?: string;
  estimateId?: string;
  creditNoteId?: string;
  salesOrderId?: string;
  purchaseOrderId?: string;
  billId?: string;
  contactId?: string;
  vendorPaymentId?: string;
  organizationId?: string;
}): Record<string, unknown> => {
  let module = input.moduleName;
  let recordId = input.recordId;

  if (
    ['activateBankAccount', 'deactivateBankAccount', 'importBankStatement'].includes(
      input.operation,
    )
  ) {
    module = 'bankaccounts';
    recordId = input.accountId;
  } else if (
    [
      'matchBankTransaction',
      'unmatchBankTransaction',
      'excludeBankTransaction',
      'restoreBankTransaction',
      'uncategorizeBankTransaction',
      'categorizeBankTransaction',
      'categorizeBankTransactionAsExpense',
      'categorizeBankTransactionAsVendorPayment',
      'categorizeBankTransactionAsCustomerPayment',
      'categorizeBankTransactionAsCreditNoteRefund',
    ].includes(input.operation)
  ) {
    module = 'banktransactions';
    recordId = input.transactionId;
  } else if (
    [
      'emailInvoice',
      'remindInvoice',
      'enableInvoicePaymentReminder',
      'disableInvoicePaymentReminder',
      'writeOffInvoice',
      'cancelInvoiceWriteOff',
      'markInvoiceSent',
      'voidInvoice',
      'markInvoiceDraft',
      'submitInvoice',
      'approveInvoice',
    ].includes(input.operation)
  ) {
    module = 'invoices';
    recordId = input.invoiceId;
  } else if (
    [
      'emailEstimate',
      'markEstimateSent',
      'acceptEstimate',
      'declineEstimate',
      'submitEstimate',
      'approveEstimate',
    ].includes(input.operation)
  ) {
    module = 'estimates';
    recordId = input.estimateId;
  } else if (
    ['emailCreditNote', 'openCreditNote', 'voidCreditNote', 'refundCreditNote'].includes(
      input.operation,
    )
  ) {
    module = 'creditnotes';
    recordId = input.creditNoteId;
  } else if (
    [
      'emailSalesOrder',
      'openSalesOrder',
      'voidSalesOrder',
      'submitSalesOrder',
      'approveSalesOrder',
      'createInvoiceFromSalesOrder',
    ].includes(input.operation)
  ) {
    module = 'salesorders';
    recordId = input.salesOrderId;
  } else if (
    [
      'emailPurchaseOrder',
      'openPurchaseOrder',
      'billPurchaseOrder',
      'cancelPurchaseOrder',
      'rejectPurchaseOrder',
      'submitPurchaseOrder',
      'approvePurchaseOrder',
    ].includes(input.operation)
  ) {
    module = 'purchaseorders';
    recordId = input.purchaseOrderId;
  } else if (['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(input.operation)) {
    module = 'bills';
    recordId = input.billId;
  } else if (
    [
      'emailContact',
      'emailContactStatement',
      'enableContactPaymentReminder',
      'disableContactPaymentReminder',
    ].includes(input.operation)
  ) {
    module = 'contacts';
    recordId = input.contactId;
  } else if (input.operation === 'emailVendorPayment') {
    module = 'vendorpayments';
    recordId = input.vendorPaymentId;
  }

  return {
    domain: 'books',
    module,
    operation: input.operation,
    recordId,
    organizationId: input.organizationId,
  };
};

const buildCrmMutationAuthorizationTarget = (input: {
  operation: string;
  moduleName?: string;
  recordId?: string;
}): Record<string, unknown> => ({
  domain: 'crm',
  module: input.moduleName,
  operation: input.operation,
  recordId: input.recordId,
});

const getAllowedActionGroups = (
  runtime: VercelRuntimeRequestContext,
  toolId: string,
): ToolActionGroup[] => {
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
  const allowed = normalizedToolIds.some((toolId) =>
    getAllowedActionGroups(runtime, toolId).includes(actionGroup),
  );
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
      departmentManagerApprovalConfig: input.runtime.departmentManagerApprovalConfig,
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

type RemoteDesktopLocalAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

const summarizeRemoteLocalAction = (action: RemoteDesktopLocalAction): string => {
  switch (action.kind) {
    case 'run_command':
      return `Run shell command: ${action.command}`;
    case 'write_file':
      return `Write file: ${action.path}`;
    case 'mkdir':
      return `Create directory: ${action.path}`;
    case 'delete_path':
      return `Delete path: ${action.path}`;
    case 'read_file':
      return `Read file: ${action.path}`;
    case 'list_files':
      return `Inspect workspace${action.path ? ` in ${action.path}` : ''}`;
    default:
      return 'Run local desktop action';
  }
};

const createPendingDesktopRemoteApproval = async (input: {
  runtime: VercelRuntimeRequestContext;
  action: RemoteDesktopLocalAction;
  actionGroup: ToolActionGroup;
  operation: string;
  summary: string;
  subject?: string;
  explanation?: string;
}): Promise<VercelToolEnvelope> => {
  const actionType =
    input.actionGroup === 'delete'
      ? 'delete'
      : input.actionGroup === 'execute'
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
    toolId: 'coding',
    actionGroup: input.actionGroup,
    subject: input.subject,
    payload: {
      toolId: 'coding',
      actionGroup: input.actionGroup,
      operation: input.operation,
      desktopRemoteLocalAction: input.action,
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
      desktopRemoteLocalAction: input.action,
      desktopRemoteLocalActionGroup: input.actionGroup,
      desktopRemoteLocalOperation: input.operation,
      desktopRemoteLocalSummary: input.summary,
      ...(input.explanation ? { desktopRemoteLocalExplanation: input.explanation } : {}),
      approvalExecutionMode: 'desktop_remote',
    },
  });
  return buildEnvelope({
    success: true,
    summary: input.summary,
    pendingApprovalAction: {
      kind: 'tool_action',
      approvalId: pending.actionId,
      scope: 'backend_remote',
      toolId: 'coding',
      actionGroup: input.actionGroup,
      operation: input.operation,
      title: 'Desktop execution approval required',
      summary: input.summary,
      subject: input.subject,
      explanation: input.explanation,
      payload: {
        desktopRemoteLocalAction: input.action,
      },
    },
  });
};

const buildRemoteLocalExecutionUnavailableEnvelope = (
  status: 'none' | 'ambiguous' | 'deny',
): VercelToolEnvelope => {
  if (status === 'none') {
    return buildEnvelope({
      success: false,
      summary: 'No active desktop workspace is available for local execution.',
      errorKind: 'missing_input',
      retryable: true,
      userAction:
        'Open Divo Desktop, select the target workspace, and keep it connected before retrying.',
    });
  }
  if (status === 'ambiguous') {
    return buildEnvelope({
      success: false,
      summary: 'Multiple desktop workspaces are online; remote execution target is ambiguous.',
      errorKind: 'validation',
      retryable: true,
      userAction: 'Keep exactly one eligible desktop workspace connected before retrying.',
    });
  }
  return buildEnvelope({
    success: false,
    summary: 'This desktop workspace policy denies the requested local action.',
    errorKind: 'permission',
    retryable: false,
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

const FILE_LOOKUP_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'file',
  'files',
  'doc',
  'docs',
  'document',
  'documents',
  'pdf',
  'uploaded',
  'upload',
  'shared',
  'above',
  'latest',
  'recent',
]);

const normalizeFileLookupText = (value?: string): string =>
  (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeFileLookupText = (value?: string): string[] =>
  normalizeFileLookupText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !FILE_LOOKUP_STOP_WORDS.has(token));

const scoreRuntimeFileMatch = (file: RuntimeFileReference, query: string): number => {
  const normalizedQuery = normalizeFileLookupText(query);
  const normalizedName = normalizeFileLookupText(file.fileName);
  if (!normalizedQuery || !normalizedName) {
    return 0;
  }
  if (normalizedName === normalizedQuery) {
    return 1;
  }
  if (normalizedName.includes(normalizedQuery)) {
    return 0.95;
  }
  if (normalizedQuery.includes(normalizedName)) {
    return 0.9;
  }

  const queryTokens = tokenizeFileLookupText(query);
  const nameTokens = tokenizeFileLookupText(file.fileName);
  if (queryTokens.length === 0 || nameTokens.length === 0) {
    return 0;
  }

  const exactMatches = queryTokens.filter((token) => nameTokens.includes(token)).length;
  const partialMatches = queryTokens.filter((token) =>
    nameTokens.some((nameToken) => nameToken.includes(token) || token.includes(nameToken)),
  ).length;

  const exactScore = exactMatches / queryTokens.length;
  const partialScore = partialMatches / queryTokens.length;
  const recencyBoost = Math.min(
    0.05,
    Math.max(
      0,
      (file.updatedAtMs - Date.now() + 7 * 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000),
    ) * 0.05,
  );
  return Math.max(exactScore * 0.8 + partialScore * 0.15 + recencyBoost, 0);
};

const resolveFuzzyRuntimeFileMatch = (
  files: RuntimeFileReference[],
  query: string,
): RuntimeFileReference | null => {
  const ranked = files
    .map((file) => ({ file, score: scoreRuntimeFileMatch(file, query) }))
    .filter((entry) => entry.score >= 0.45)
    .sort(
      (left, right) => right.score - left.score || right.file.updatedAtMs - left.file.updatedAtMs,
    );
  return ranked[0]?.file ?? null;
};

const rankRuntimeFileMatches = (
  files: RuntimeFileReference[],
  query?: string,
): RuntimeFileReference[] => {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) {
    return files.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }
  return files
    .map((file) => ({ file, score: scoreRuntimeFileMatch(file, normalizedQuery) }))
    .filter((entry) => entry.score >= 0.2)
    .sort(
      (left, right) => right.score - left.score || right.file.updatedAtMs - left.file.updatedAtMs,
    )
    .map((entry) => entry.file);
};

const buildRuntimeFileRecord = (entry: Record<string, unknown>): RuntimeFileReference => ({
  fileAssetId: asString(entry.id) ?? '',
  fileName: asString(entry.fileName) ?? 'file',
  mimeType: asString(entry.mimeType),
  cloudinaryUrl: asString(entry.cloudinaryUrl),
  ingestionStatus: asString(entry.ingestionStatus),
  updatedAtMs:
    Date.parse(asString(entry.updatedAt) ?? asString(entry.createdAt) ?? '') || Date.now(),
});

const inferCurrency = (text: string): string | undefined => {
  if (/₹|rs\.?|inr/i.test(text)) return 'INR';
  if (/\bUSD\b|\$/i.test(text)) return 'USD';
  if (/\bEUR\b|€/i.test(text)) return 'EUR';
  if (/\bGBP\b|£/i.test(text)) return 'GBP';
  return undefined;
};

const parseNumericAmount = (value: string): number | null => {
  const cleaned = value
    .replace(/[^0-9().,\-]/g, '')
    .replace(/,/g, '')
    .trim();
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
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const invoiceNumber =
    extractFieldByLabels(text, [
      'invoice\\s*(?:no|number)',
      'bill\\s*(?:no|number)',
      'ref(?:erence)?\\s*(?:no|number)',
    ]) ?? lines.find((line) => /invoice/i.test(line) && /\d/.test(line));
  const vendorName =
    extractFieldByLabels(text, ['vendor', 'supplier', 'from', 'seller', 'billed\\s+by']) ??
    lines.find(
      (line) =>
        /^[A-Za-z][A-Za-z0-9&.,()\- ]{3,}$/.test(line) && !/invoice|tax|gst|bill to/i.test(line),
    );
  const dueDate = extractFieldByLabels(text, ['due\\s*date', 'payment\\s*due']);
  const invoiceDate =
    extractFieldByLabels(text, ['invoice\\s*date', 'bill\\s*date', 'date']) ??
    detectDateStrings(text)[0];
  const gstin = text.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]Z[A-Z0-9]\b/i)?.[0];
  const subtotal = extractBestAmount(text, ['subtotal', 'taxable\\s*value', 'net\\s*amount']);
  const taxAmount = extractBestAmount(text, ['gst', 'igst', 'cgst', 'sgst', 'tax']);
  const totalAmount =
    extractBestAmount(text, [
      'grand\\s*total',
      'invoice\\s*total',
      'total\\s*amount',
      'amount\\s*due',
      'total',
    ]) ??
    (() => {
      const amounts = Array.from(
        text.matchAll(
          /(?:₹|rs\.?|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/gi,
        ),
      )
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
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rowRegex =
    /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.+?)\s+([()\-0-9,]+\.\d{2}|[()\-0-9,]+)\s*$/;
  const rows = lines.flatMap((line) => {
    const match = line.match(rowRegex);
    if (!match) return [];
    const amount = parseNumericAmount(match[3] ?? '');
    return [
      {
        date: match[1],
        description: match[2].replace(/\s{2,}/g, ' ').trim(),
        amount,
        direction: amount !== null && amount < 0 ? 'debit' : 'credit',
      },
    ];
  });

  const closingBalance = extractBestAmount(text, [
    'closing\\s*balance',
    'balance\\s*as\\s*on',
    'available\\s*balance',
  ]);
  const openingBalance = extractBestAmount(text, [
    'opening\\s*balance',
    'balance\\s*brought\\s*forward',
  ]);
  const totalCredits = rows
    .filter((row) => typeof row.amount === 'number' && row.amount >= 0)
    .reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const totalDebits = rows
    .filter((row) => typeof row.amount === 'number' && row.amount < 0)
    .reduce((sum, row) => sum + Math.abs(row.amount ?? 0), 0);

  return {
    statementType: /bank/i.test(text)
      ? 'bank'
      : /ledger|account/i.test(text)
        ? 'account'
        : 'generic',
    accountName: extractFieldByLabels(text, [
      'account\\s*name',
      'statement\\s*for',
      'customer\\s*name',
    ]),
    accountNumber: extractFieldByLabels(text, [
      'account\\s*(?:no|number)',
      'a\\/c\\s*(?:no|number)',
    ]),
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
  const userLink = companyLink
    ? null
    : await googleUserAuthLinkRepository.findActiveByUser(runtime.userId, runtime.companyId);
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
        userAction:
          'Connect Google Workspace from Admin Settings → Integrations, or connect a personal Google account in desktop settings.',
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

const listVisibleRuntimeFiles = async (
  runtime: VercelRuntimeRequestContext,
): Promise<RuntimeFileReference[]> => {
  const files = await loadFileUploadService().listVisibleFiles({
    companyId: runtime.companyId,
    requesterUserId: runtime.userId,
    requesterAiRole: runtime.requesterAiRole,
    requesterEmail: runtime.requesterEmail,
    isAdmin:
      runtime.requesterAiRole === 'COMPANY_ADMIN' || runtime.requesterAiRole === 'SUPER_ADMIN',
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
  const runtimeAttachments = Array.isArray(runtime.attachedFiles) ? runtime.attachedFiles : [];
  const attachmentMatches = runtimeAttachments
    .filter((file) => file.fileAssetId && file.fileName)
    .map((file) => ({
      fileAssetId: file.fileAssetId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      cloudinaryUrl: file.cloudinaryUrl,
    }));
  const files = await listVisibleRuntimeFiles(runtime);
  const mergedFiles = [
    ...attachmentMatches,
    ...files.filter(
      (file) =>
        !attachmentMatches.some((attachment) => attachment.fileAssetId === file.fileAssetId),
    ),
  ];
  const normalizedId = input.fileAssetId?.trim();
  if (normalizedId) {
    return mergedFiles.find((file) => file.fileAssetId === normalizedId) ?? null;
  }

  const normalizedName = input.fileName?.trim().toLowerCase();
  if (normalizedName) {
    return (
      mergedFiles.find((file) => file.fileName.trim().toLowerCase() === normalizedName) ??
      mergedFiles.find((file) => file.fileName.trim().toLowerCase().includes(normalizedName)) ??
      resolveFuzzyRuntimeFileMatch(mergedFiles, normalizedName) ??
      null
    );
  }

  const latest = conversationMemoryStore.getLatestFileAsset(buildConversationKey(runtime.threadId));
  if (!latest) {
    return null;
  }
  return mergedFiles.find((file) => file.fileAssetId === latest.fileAssetId) ?? latest;
};

const extractIndexedFileText = async (
  runtime: VercelRuntimeRequestContext,
  fileAssetId: string,
): Promise<string> => {
  return loadFileRetrievalService().getIndexedFileText({
    companyId: runtime.companyId,
    fileAssetId,
    maxChars: 18_000,
  });
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
    throw new Error(
      `Failed to fetch file content for OCR: ${response.status} ${response.statusText}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const { extractTextFromBuffer, normalizeExtractedText } = loadDocumentTextHelpers();
  const rawText = await extractTextFromBuffer(
    Buffer.from(arrayBuffer),
    file.mimeType,
    file.fileName,
  );
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
    asString(record?.message) ??
    asString(result?.answer) ??
    asString(error?.classifiedReason) ??
    'No summary returned.';

  return buildEnvelope({
    success,
    summary,
    keyData: input?.keyData,
    fullPayload: input?.fullPayload ?? result ?? record ?? undefined,
    citations: input?.citations,
    ...(success
      ? {}
      : {
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
    departmentZohoReadScope: runtime.departmentZohoReadScope,
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
  if (['accounts', 'account', 'companies', 'company', 'zoho_account'].includes(normalized))
    return 'zoho_account';
  if (['deals', 'deal', 'zoho_deal'].includes(normalized)) return 'zoho_deal';
  if (['cases', 'case', 'tickets', 'ticket', 'zoho_ticket'].includes(normalized))
    return 'zoho_ticket';
  return undefined;
};

const normalizeZohoCrmModuleName = (value?: string): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['leads', 'lead', 'zoho_lead'].includes(normalized)) return 'Leads';
  if (['contacts', 'contact', 'zoho_contact'].includes(normalized)) return 'Contacts';
  if (['accounts', 'account', 'companies', 'company', 'zoho_account'].includes(normalized))
    return 'Accounts';
  if (['deals', 'deal', 'zoho_deal'].includes(normalized)) return 'Deals';
  if (['cases', 'case', 'tickets', 'ticket', 'zoho_ticket'].includes(normalized)) return 'Cases';
  if (['tasks', 'task'].includes(normalized)) return 'Tasks';
  if (['events', 'event', 'meetings', 'meeting'].includes(normalized)) return 'Events';
  if (['calls', 'call'].includes(normalized)) return 'Calls';
  if (['products', 'product'].includes(normalized)) return 'Products';
  if (['quotes', 'quote'].includes(normalized)) return 'Quotes';
  if (['vendors', 'vendor'].includes(normalized)) return 'Vendors';
  if (['invoices', 'invoice'].includes(normalized)) return 'Invoices';
  if (['salesorders', 'salesorder', 'sales_orders', 'sales-order'].includes(normalized))
    return 'Sales_Orders';
  if (['purchaseorders', 'purchaseorder', 'purchase_orders', 'purchase-order'].includes(normalized))
    return 'Purchase_Orders';
  return value?.trim();
};

const normalizeZohoBooksModule = (
  value?: string,
):
  | 'contacts'
  | 'invoices'
  | 'estimates'
  | 'creditnotes'
  | 'bills'
  | 'salesorders'
  | 'purchaseorders'
  | 'customerpayments'
  | 'vendorpayments'
  | 'bankaccounts'
  | 'banktransactions'
  | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['contact', 'contacts', 'customer', 'customers', 'vendor', 'vendors'].includes(normalized))
    return 'contacts';
  if (['invoice', 'invoices'].includes(normalized)) return 'invoices';
  if (['estimate', 'estimates'].includes(normalized)) return 'estimates';
  if (['creditnote', 'creditnotes', 'credit-note', 'credit-notes'].includes(normalized))
    return 'creditnotes';
  if (['bill', 'bills'].includes(normalized)) return 'bills';
  if (['salesorder', 'salesorders', 'sales-order', 'sales-orders'].includes(normalized))
    return 'salesorders';
  if (['purchaseorder', 'purchaseorders', 'purchase-order', 'purchase-orders'].includes(normalized))
    return 'purchaseorders';
  if (['customerpayment', 'customerpayments', 'payment', 'payments'].includes(normalized))
    return 'customerpayments';
  if (['vendorpayment', 'vendorpayments', 'vendor-payment', 'vendor-payments'].includes(normalized))
    return 'vendorpayments';
  if (
    [
      'bankaccount',
      'bankaccounts',
      'bank-account',
      'bank-accounts',
      'account',
      'accounts',
    ].includes(normalized)
  ) {
    return 'bankaccounts';
  }
  if (
    ['banktransaction', 'banktransactions', 'bank-transaction', 'bank-transactions'].includes(
      normalized,
    )
  ) {
    return 'banktransactions';
  }
  return undefined;
};

type ZohoBooksRuntimeModule = NonNullable<ReturnType<typeof normalizeZohoBooksModule>>;

const getRuntimeZohoBooksEntity = (
  runtime: VercelRuntimeRequestContext,
  moduleName: ZohoBooksRuntimeModule,
): { module: ZohoBooksRuntimeModule; recordId: string } | null => {
  const currentEntity = runtime.taskState?.currentEntity;
  const currentModule = normalizeZohoBooksModule(currentEntity?.module);
  if (currentModule === moduleName && currentEntity?.recordId?.trim()) {
    return {
      module: currentModule,
      recordId: currentEntity.recordId.trim(),
    };
  }

  const lastFetched = runtime.taskState?.lastFetchedByModule?.[moduleName];
  const lastFetchedModule = normalizeZohoBooksModule(lastFetched?.module);
  if (lastFetchedModule === moduleName && lastFetched?.recordId?.trim()) {
    return {
      module: lastFetchedModule,
      recordId: lastFetched.recordId.trim(),
    };
  }

  return null;
};

const inferZohoBooksModuleFromOperation = (
  operation: string,
): ZohoBooksRuntimeModule | undefined => {
  if (
    [
      'emailEstimate',
      'markEstimateSent',
      'acceptEstimate',
      'declineEstimate',
      'submitEstimate',
      'approveEstimate',
      'getEstimateEmailContent',
    ].includes(operation)
  ) {
    return 'estimates';
  }
  if (
    [
      'emailInvoice',
      'remindInvoice',
      'enableInvoicePaymentReminder',
      'disableInvoicePaymentReminder',
      'writeOffInvoice',
      'cancelInvoiceWriteOff',
      'markInvoiceSent',
      'voidInvoice',
      'markInvoiceDraft',
      'submitInvoice',
      'approveInvoice',
      'getInvoiceEmailContent',
      'getInvoicePaymentReminderContent',
    ].includes(operation)
  ) {
    return 'invoices';
  }
  if (
    [
      'emailCreditNote',
      'openCreditNote',
      'voidCreditNote',
      'refundCreditNote',
      'getCreditNoteEmailContent',
    ].includes(operation)
  ) {
    return 'creditnotes';
  }
  if (
    [
      'emailSalesOrder',
      'openSalesOrder',
      'voidSalesOrder',
      'submitSalesOrder',
      'approveSalesOrder',
      'createInvoiceFromSalesOrder',
      'getSalesOrderEmailContent',
    ].includes(operation)
  ) {
    return 'salesorders';
  }
  if (
    [
      'emailPurchaseOrder',
      'openPurchaseOrder',
      'billPurchaseOrder',
      'cancelPurchaseOrder',
      'rejectPurchaseOrder',
      'submitPurchaseOrder',
      'approvePurchaseOrder',
      'getPurchaseOrderEmailContent',
    ].includes(operation)
  ) {
    return 'purchaseorders';
  }
  if (['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(operation)) {
    return 'bills';
  }
  if (
    [
      'emailContact',
      'emailContactStatement',
      'enableContactPaymentReminder',
      'disableContactPaymentReminder',
      'getContactStatementEmailContent',
    ].includes(operation)
  ) {
    return 'contacts';
  }
  if (['emailVendorPayment', 'getVendorPaymentEmailContent'].includes(operation)) {
    return 'vendorpayments';
  }
  return undefined;
};

const resolveZohoBooksModuleFromRuntime = (
  runtime: VercelRuntimeRequestContext,
  explicitModule: string | undefined,
  operation: string,
): ZohoBooksRuntimeModule | undefined => {
  const explicit = normalizeZohoBooksModule(explicitModule);
  if (explicit) {
    return explicit;
  }
  const inferred = inferZohoBooksModuleFromOperation(operation);
  if (inferred) {
    const entity = getRuntimeZohoBooksEntity(runtime, inferred);
    if (entity) {
      return entity.module;
    }
    return inferred;
  }
  const currentEntityModule = normalizeZohoBooksModule(runtime.taskState?.currentEntity?.module);
  if (currentEntityModule) {
    return currentEntityModule;
  }
  const activeModule = normalizeZohoBooksModule(runtime.taskState?.activeModule);
  return activeModule;
};

const resolveZohoBooksRecordIdFromRuntime = (
  runtime: VercelRuntimeRequestContext,
  moduleName: ZohoBooksRuntimeModule | undefined,
  explicitRecordId?: string,
): string | undefined => {
  const direct = explicitRecordId?.trim();
  if (direct) {
    return direct;
  }
  if (!moduleName) {
    return undefined;
  }
  return getRuntimeZohoBooksEntity(runtime, moduleName)?.recordId;
};

const resolvePendingBooksWriteBodyFromRuntime = (input: {
  runtime: VercelRuntimeRequestContext;
  operation: string;
  moduleName?: ZohoBooksRuntimeModule;
  recordId?: string;
  explicitBody?: Record<string, unknown>;
}): Record<string, unknown> | undefined => {
  if (input.explicitBody) {
    return input.explicitBody;
  }
  const pendingApproval = input.runtime.taskState?.pendingApproval;
  if (!pendingApproval || pendingApproval.toolId !== 'zoho-books-write') {
    return undefined;
  }
  const pendingModule = normalizeZohoBooksModule(pendingApproval.module);
  const pendingPayload = asRecord(pendingApproval.payload);
  const pendingBody = asRecord(pendingPayload?.body);
  const pendingRecordId = asString(pendingApproval.recordId) ?? asString(pendingPayload?.recordId);
  if (!pendingBody) {
    return undefined;
  }
  if (pendingApproval.operation !== input.operation) {
    return undefined;
  }
  if (input.moduleName && pendingModule && input.moduleName !== pendingModule) {
    return undefined;
  }
  if (input.recordId?.trim() && pendingRecordId && input.recordId.trim() !== pendingRecordId) {
    return undefined;
  }
  return pendingBody;
};

const getLarkDefaults = async (runtime: VercelRuntimeRequestContext) =>
  loadLarkOperationalConfigRepository().findByCompanyId(runtime.companyId);

const getLarkAuthInput = (runtime: VercelRuntimeRequestContext) => {
  const authInput = {
    companyId: runtime.companyId,
    larkTenantKey: runtime.larkTenantKey,
    appUserId: runtime.userId,
    credentialMode:
      runtime.authProvider === 'lark' ? ('user_linked' as const) : ('tenant' as const),
  };

  logger.info('vercel.lark.auth.selected', {
    executionId: runtime.executionId,
    threadId: runtime.threadId,
    companyId: runtime.companyId,
    userId: runtime.userId,
    authProvider: runtime.authProvider,
    credentialMode: authInput.credentialMode,
    hasLarkTenantKey: Boolean(runtime.larkTenantKey),
    hasLarkOpenId: Boolean(runtime.larkOpenId),
    hasLarkUserId: Boolean(runtime.larkUserId),
  });

  return authInput;
};

const LARK_LOCAL_TIME_ZONE = 'Asia/Kolkata';

const getLarkTimeZone = (): string => LARK_LOCAL_TIME_ZONE;

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
    logger.warn('vercel.lark.auth.fallback_to_tenant', {
      executionId: runtime.executionId,
      threadId: runtime.threadId,
      companyId: runtime.companyId,
      userId: runtime.userId,
      error: error.message,
    });
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

const inspectWorkspace = async (workspaceRoot: string, targetPath?: string) => {
  const directoryPath = targetPath?.trim()
    ? path.resolve(workspaceRoot, targetPath.trim())
    : workspaceRoot;
  const relativePath = path.relative(workspaceRoot, directoryPath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error('Requested inspect path escapes the active workspace');
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries.slice(0, 50).map((entry) => ({
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
    case 'runCommand':
    case 'planCommand':
      return 'Planning shell command';
    case 'runScript':
    case 'runScriptPlan':
      return 'Planning script execution';
    case 'writeFile':
    case 'writeFilePlan':
      return 'Planning file write';
    case 'createDirectory':
    case 'mkdirPlan':
      return 'Planning directory creation';
    case 'deletePath':
    case 'deletePathPlan':
      return 'Planning path deletion';
    default:
      return 'Running local coding action';
  }
};

const readWorkspaceFiles = async (runtime: VercelRuntimeRequestContext, paths: string[]) => {
  const items = await Promise.all(
    paths.map(async (filePath) => {
      const absolutePath = resolveWorkspacePath(runtime, filePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      return {
        path: filePath,
        content,
      };
    }),
  );
  return items;
};

const summarizeActionResult = (
  runtime: VercelRuntimeRequestContext,
  expectedOutputs?: string[],
): VercelToolEnvelope => {
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
  workflowDraft: ['workflow-authoring'],
  workflowPlan: ['workflow-authoring'],
  workflowBuild: ['workflow-authoring'],
  workflowSave: ['workflow-authoring'],
  workflowSchedule: ['workflow-authoring'],
  workflowList: ['workflow-authoring'],
  workflowRun: ['workflow-authoring'],
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
  larkMessage: ['lark-message-read', 'lark-message-write'],
  larkCalendar: [
    'lark-calendar-list',
    'lark-calendar-read',
    'lark-calendar-write',
    'lark-calendar-agent',
  ],
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
  const allowed = new Set(runtime.runExposedToolIds ?? runtime.allowedToolIds);
  return requiredIds.some((toolId) => allowed.has(toolId));
};

export const createVercelDesktopTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => {
  const tools = {
    webSearch: tool({
      description:
        'Public web and documentation search only. Use for public internet research and exact page context.',
      inputSchema: z.object({
        operation: z.enum(['search', 'focusedSearch', 'fetchPageContext']),
        query: z.string().min(1),
        site: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'webSearch', 'Searching the web', async () => {
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
            const items = asArray(record.items)
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => Boolean(entry));
            const citations = buildWebCitations(items, record.sourceRefs);
            return buildEnvelope({
              success: true,
              summary:
                items.length > 0
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
              errorKind:
                error instanceof SearchIntegrationError ? 'api_failure' : inferErrorKind(summary),
              retryable: true,
            });
          }
        }),
    }),

    docSearch: tool({
      description:
        'Internal company document search only. Use this before workspace, Google Drive, or repo inspection when the user is asking about uploaded files, private docs, or indexed company documents.',
      inputSchema: z.discriminatedUnion('operation', [
        z.object({
          operation: z.literal('search'),
          query: z.string().min(1),
          fileAssetId: z.string().optional(),
          limit: z.number().int().min(1).max(10).optional(),
        }),
        z.object({
          operation: z.literal('readChunkContext'),
          fileAssetId: z.string().min(1),
          chunkIndex: z.number().int().min(0).optional(),
          query: z.string().optional(),
          limit: z.number().int().min(1).max(10).optional(),
        }),
      ]),
      execute: async (input) =>
        withLifecycle(hooks, 'docSearch', 'Searching internal documents', async () => {
          if (input.operation === 'readChunkContext') {
            if (!input.fileAssetId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'readChunkContext requires fileAssetId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }

            const context = await loadFileRetrievalService().readChunkContext({
              companyId: runtime.companyId,
              fileAssetId: input.fileAssetId.trim(),
              chunkIndex: input.chunkIndex,
            });

            if (!context.text.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'No chunk context was found for that file reference.',
                errorKind: 'not_found',
                retryable: false,
              });
            }

            return buildEnvelope({
              success: true,
              summary: `Loaded ${context.source.replace(/_/g, ' ')} context for file ${input.fileAssetId.trim()}.`,
              keyData: {
                fileAssetId: input.fileAssetId.trim(),
                chunkIndex: input.chunkIndex,
                source: context.source,
              },
              fullPayload: {
                fileAssetId: input.fileAssetId.trim(),
                chunkIndex: input.chunkIndex,
                source: context.source,
                text: context.text,
              },
              citations: [
                {
                  id: `file-${input.fileAssetId.trim()}-${input.chunkIndex ?? 0}`,
                  title: input.fileAssetId.trim(),
                  kind: 'file',
                  sourceType: 'file_document',
                  sourceId: input.fileAssetId.trim(),
                  fileAssetId: input.fileAssetId.trim(),
                  chunkIndex: input.chunkIndex,
                },
              ],
            });
          }

          const limit = Math.max(1, Math.min(10, input.limit ?? 5));
          const searchResult = await loadFileRetrievalService().search({
            companyId: runtime.companyId,
            query: input.query,
            fileAssetId: input.fileAssetId?.trim(),
            limit,
            requesterAiRole: runtime.requesterAiRole,
            preferParentContext: true,
          });
          const citations = searchResult.citations.filter((entry): entry is VercelCitation =>
            Boolean(entry),
          );
          const normalizedMatches = searchResult.matches.map((match) => {
            const payload = asRecord(match) ?? {};
            return {
              id: asString(payload.id) ?? 'file_document:unknown',
              fileName: asString(payload.fileName) ?? 'document',
              text: asString(payload.text) ?? '',
              displayText: asString(payload.displayText) ?? asString(payload.text) ?? '',
              modality: asString(payload.modality) ?? 'text',
              url: asString(payload.url),
              score: typeof payload.score === 'number' ? payload.score : undefined,
              sourceId: asString(payload.sourceId),
              chunkIndex: typeof payload.chunkIndex === 'number' ? payload.chunkIndex : undefined,
              documentClass: asString(payload.documentClass),
              chunkingStrategy: asString(payload.chunkingStrategy),
              sectionPath: Array.isArray(payload.sectionPath) ? payload.sectionPath : [],
            };
          });
          return buildEnvelope({
            success: true,
            summary:
              normalizedMatches.length > 0
                ? `Found ${normalizedMatches.length} relevant internal document section(s).`
                : 'No relevant internal document content matched the request.',
            keyData: {
              documentIds: uniqueDefinedStrings(citations.map((citation) => citation.sourceId)),
              queriesUsed: searchResult.queriesUsed,
              enhancements: searchResult.enhancements,
            },
            fullPayload: {
              matches: normalizedMatches,
              queriesUsed: searchResult.queriesUsed,
              enhancements: searchResult.enhancements,
              correctiveRetryUsed: searchResult.correctiveRetryUsed,
            },
            citations,
          });
        }),
    }),

    documentOcrRead: tool({
      description:
        'List visible uploaded files and extract machine-readable text from a selected document. Use this as an internal uploaded-file path before workspace, Google Drive, or repo inspection when you need the exact file contents.',
      inputSchema: z.object({
        operation: z.enum(['listFiles', 'extractText']),
        fileAssetId: z.string().optional(),
        fileName: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'documentOcrRead', 'Running document OCR', async () => {
          const conversationKey = buildConversationKey(runtime.threadId);
          if (input.operation === 'listFiles') {
            const files = await listVisibleRuntimeFiles(runtime);
            const limited = rankRuntimeFileMatches(files, input.query ?? input.fileName).slice(
              0,
              input.limit ?? 10,
            );
            return buildEnvelope({
              success: true,
              summary:
                limited.length > 0
                  ? `Found ${limited.length} accessible uploaded file(s)${input.query?.trim() ? ` matching "${input.query.trim()}"` : ''}.`
                  : input.query?.trim()
                    ? `No accessible uploaded files matched "${input.query.trim()}".`
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
            const candidates = rankRuntimeFileMatches(
              await listVisibleRuntimeFiles(runtime),
              input.fileName,
            ).slice(0, 5);
            return buildEnvelope({
              success: false,
              summary:
                candidates.length > 0
                  ? `No exact uploaded file match was found. Closest visible files: ${candidates.map((candidate) => candidate.fileName).join(', ')}.`
                  : 'No matching uploaded file was found. Provide fileAssetId or fileName, or upload a document first.',
              errorKind: 'missing_input',
              retryable: false,
              ...(candidates.length > 0
                ? {
                    fullPayload: {
                      candidates,
                    },
                  }
                : {}),
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
            citations: [
              {
                id: `file-${file.fileAssetId}`,
                title: file.fileName,
                url: file.cloudinaryUrl,
                kind: 'file',
                sourceType: 'file_document',
                sourceId: file.fileAssetId,
                fileAssetId: file.fileAssetId,
              },
            ],
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
      execute: async (input) =>
        withLifecycle(hooks, 'invoiceParser', 'Parsing invoice document', async () => {
          const conversationKey = buildConversationKey(runtime.threadId);
          const file = input.text ? null : await resolveRuntimeFile(runtime, input);
          if (!input.text && !file) {
            return buildEnvelope({
              success: false,
              summary:
                'Invoice parsing requires uploaded document text or a visible file reference.',
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
            ...(file
              ? {
                  citations: [
                    {
                      id: `file-${file.fileAssetId}`,
                      title: file.fileName,
                      url: file.cloudinaryUrl,
                      kind: 'file',
                      sourceType: 'file_document',
                      sourceId: file.fileAssetId,
                      fileAssetId: file.fileAssetId,
                    },
                  ],
                }
              : {}),
          });
        }),
    }),

    statementParser: tool({
      description:
        'Parse uploaded bank or account statements into transaction rows and statement totals.',
      inputSchema: z.object({
        fileAssetId: z.string().optional(),
        fileName: z.string().optional(),
        text: z.string().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'statementParser', 'Parsing statement document', async () => {
          const conversationKey = buildConversationKey(runtime.threadId);
          const file = input.text ? null : await resolveRuntimeFile(runtime, input);
          if (!input.text && !file) {
            return buildEnvelope({
              success: false,
              summary:
                'Statement parsing requires uploaded document text or a visible file reference.',
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
            ...(file
              ? {
                  citations: [
                    {
                      id: `file-${file.fileAssetId}`,
                      title: file.fileName,
                      url: file.cloudinaryUrl,
                      kind: 'file',
                      sourceType: 'file_document',
                      sourceId: file.fileAssetId,
                      fileAssetId: file.fileAssetId,
                    },
                  ],
                }
              : {}),
          });
        }),
    }),

    workflowDraft: tool({
      description:
        'Create a reusable workflow/prompt draft or reopen an existing draft. Use when the user wants to make a process reusable, save it for later, or prepare it for scheduling.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(160).optional(),
          departmentId: z.string().uuid().nullable().optional(),
          destinations: z.array(workflowDestinationSchema).max(10).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowDraft', 'Preparing workflow draft', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'create');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const destinations = input.destinations ?? buildRuntimeWorkflowDestinations(runtime);
          const desiredOutputConfig = toWorkflowOutputConfig(destinations);

          if (input.workflowId) {
            const existing = await workflowsService.get(session, input.workflowId);
            const normalized = shouldAdoptRuntimeWorkflowDestinations(
              existing.outputConfig,
              desiredOutputConfig,
            )
              ? await workflowsService.update(session, input.workflowId, {
                  outputConfig: desiredOutputConfig,
                  ...(input.departmentId !== undefined || runtime.departmentId
                    ? { departmentId: input.departmentId ?? runtime.departmentId ?? null }
                    : {}),
                })
              : existing;
            return buildEnvelope({
              success: true,
              summary: `Resumed workflow draft "${asString(normalized.name) ?? input.workflowId}".`,
              keyData: {
                workflowId: normalized.id,
                name: normalized.name,
                status: normalized.status,
              },
              fullPayload: normalized,
            });
          }

          const created = await workflowsService.createDraft(session, {
            name: input.name ?? null,
            departmentId: input.departmentId ?? runtime.departmentId ?? null,
          });
          const normalized = await workflowsService.update(session, created.id as string, {
            outputConfig: desiredOutputConfig,
            ...(input.departmentId !== undefined || runtime.departmentId
              ? { departmentId: input.departmentId ?? runtime.departmentId ?? null }
              : {}),
          });

          return buildEnvelope({
            success: true,
            summary: `Created workflow draft "${asString(normalized.name) ?? asString(created.name) ?? 'New workflow'}".`,
            keyData: {
              workflowId: normalized.id,
              name: normalized.name,
              status: normalized.status,
            },
            fullPayload: normalized,
          });
        }),
    }),

    workflowPlan: tool({
      description:
        'Advance workflow planning from a user brief. Use this when the user wants a reusable prompt/workflow or wants to schedule a repeatable process. If required details are missing, this tool returns exactly what to ask next.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          brief: z.string().trim().min(1).max(12000).optional(),
          attachedFiles: z.array(workflowAttachedFileSchema).max(12).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowPlan', 'Planning workflow', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'create');
          if (permissionError) {
            return permissionError;
          }
          if (!input.brief?.trim()) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow planning needs the process or prompt brief first.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user what reusable process/prompt they want to create.',
            });
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          let workflowId = input.workflowId;
          if (!workflowId) {
            const created = await workflowsService.createDraft(session, {
              departmentId: runtime.departmentId ?? null,
            });
            const destinations = buildRuntimeWorkflowDestinations(runtime);
            const normalized = await workflowsService.update(session, created.id as string, {
              outputConfig: toWorkflowOutputConfig(destinations),
              ...(runtime.departmentId ? { departmentId: runtime.departmentId } : {}),
            });
            workflowId = asString(normalized.id) ?? asString(created.id);
          }
          if (!workflowId) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow planning could not create a draft workflow.',
              errorKind: 'api_failure',
              retryable: true,
            });
          }

          const runtimeDestinations = buildRuntimeWorkflowDestinations(runtime);
          const desiredOutputConfig = toWorkflowOutputConfig(runtimeDestinations);
          const current = await workflowsService.get(session, workflowId);
          if (shouldAdoptRuntimeWorkflowDestinations(current.outputConfig, desiredOutputConfig)) {
            await workflowsService.update(session, workflowId, {
              outputConfig: desiredOutputConfig,
              ...(runtime.departmentId ? { departmentId: runtime.departmentId } : {}),
            });
          }

          const planned = await workflowsService.author(
            session,
            workflowId,
            input.brief.trim(),
            input.attachedFiles ?? [],
          );
          const planningState = asRecord(planned.planningState);
          const openQuestions = asArray(planningState?.openQuestions)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          if (openQuestions.length > 0 && planningState?.readyToBuild !== true) {
            const firstQuestion =
              asString(openQuestions[0]?.question) ??
              'Ask the user for the next missing workflow detail.';
            return buildEnvelope({
              success: false,
              summary:
                asString(planned.aiDraft) ??
                asString(planned.userIntent) ??
                `Workflow planning needs more details. ${firstQuestion}`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: firstQuestion,
              keyData: {
                workflowId: planned.id,
                name: planned.name,
                readyToBuild: planningState?.readyToBuild ?? false,
                openQuestionCount: openQuestions.length,
              },
              fullPayload: planned,
            });
          }

          return buildEnvelope({
            success: true,
            summary:
              planningState?.readyToBuild === true
                ? `Workflow "${asString(planned.name) ?? workflowId}" is ready to build.`
                : `Workflow "${asString(planned.name) ?? workflowId}" planning was updated.`,
            keyData: {
              workflowId: planned.id,
              name: planned.name,
              readyToBuild: planningState?.readyToBuild ?? false,
            },
            fullPayload: planned,
          });
        }),
    }),

    workflowBuild: tool({
      description:
        'Build the reusable workflow/prompt once planning is complete. If planning is still incomplete, this tool tells you exactly what to ask the user next.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowBuild', 'Building workflow', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'update');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const runtimeDestinations = buildRuntimeWorkflowDestinations(runtime);
          const desiredOutputConfig = toWorkflowOutputConfig(runtimeDestinations);
          let current = await workflowsService.get(session, input.workflowId);
          if (shouldAdoptRuntimeWorkflowDestinations(current.outputConfig, desiredOutputConfig)) {
            current = await workflowsService.update(session, input.workflowId, {
              outputConfig: desiredOutputConfig,
              ...(runtime.departmentId ? { departmentId: runtime.departmentId } : {}),
            });
          }
          const planningState = asRecord(current.planningState);
          const openQuestions = asArray(planningState?.openQuestions)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          if (planningState?.readyToBuild !== true) {
            const firstQuestion =
              asString(openQuestions[0]?.question) ??
              'Ask the user for the remaining workflow details before building.';
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" is not ready to build yet.`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: firstQuestion,
              keyData: {
                workflowId: current.id,
                name: current.name,
                openQuestionCount: openQuestions.length,
              },
              fullPayload: current,
            });
          }

          const built = await workflowsService.author(
            session,
            input.workflowId,
            'Build the reusable workflow now.',
          );
          return buildEnvelope({
            success: true,
            summary: `Built workflow "${asString(built.name) ?? input.workflowId}".`,
            keyData: {
              workflowId: built.id,
              name: built.name,
              built:
                typeof built.compiledPrompt === 'string' && built.compiledPrompt.trim().length > 0,
            },
            fullPayload: built,
          });
        }),
    }),

    workflowSave: tool({
      description:
        'Save or publish a built reusable workflow. Requires explicit confirmation before saving, and never enables a schedule unless explicitly requested.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
          confirm: z.boolean().optional(),
          scheduleEnabled: z.boolean().optional(),
          departmentId: z.string().uuid().nullable().optional(),
          destinations: z.array(workflowDestinationSchema).max(10).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowSave', 'Saving workflow', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'update');
          if (permissionError) {
            return permissionError;
          }
          if (input.confirm !== true) {
            return buildEnvelope({
              success: false,
              summary: input.scheduleEnabled
                ? 'Saving and enabling a workflow schedule requires explicit confirmation.'
                : 'Saving this reusable workflow requires explicit confirmation.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: input.scheduleEnabled
                ? 'Ask the user to confirm saving and enabling the schedule.'
                : 'Ask the user to confirm saving the reusable workflow.',
            });
          }

          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const runtimeDestinations =
            input.destinations ?? buildRuntimeWorkflowDestinations(runtime);
          const desiredOutputConfig = toWorkflowOutputConfig(runtimeDestinations);
          let current = await workflowsService.get(session, input.workflowId);
          if (shouldAdoptRuntimeWorkflowDestinations(current.outputConfig, desiredOutputConfig)) {
            current = await workflowsService.update(session, input.workflowId, {
              outputConfig: desiredOutputConfig,
              ...(input.departmentId !== undefined || runtime.departmentId
                ? { departmentId: input.departmentId ?? runtime.departmentId ?? null }
                : {}),
            });
          }
          if (typeof current.compiledPrompt !== 'string' || !current.compiledPrompt.trim()) {
            return buildEnvelope({
              success: false,
              summary: `Workflow "${asString(current.name) ?? input.workflowId}" is not built yet.`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Build the workflow first, then save or publish it.',
              fullPayload: current,
            });
          }

          const outputConfig = input.destinations
            ? toWorkflowOutputConfig(input.destinations)
            : current.outputConfig;
          const published = await workflowsService.publish(session, {
            workflowId: current.id,
            name: current.name,
            userIntent: current.userIntent,
            aiDraft: current.aiDraft ?? undefined,
            workflowSpec: current.workflowSpec,
            compiledPrompt: current.compiledPrompt,
            schedule: current.schedule,
            scheduleEnabled: input.scheduleEnabled ?? false,
            outputConfig,
            departmentId:
              input.departmentId ?? runtime.departmentId ?? current.departmentId ?? null,
          });

          return buildEnvelope({
            success: true,
            summary: input.scheduleEnabled
              ? `Saved and scheduled workflow "${asString(current.name) ?? input.workflowId}".`
              : `Saved workflow "${asString(current.name) ?? input.workflowId}".`,
            keyData: {
              workflowId: published.workflowId,
              status: published.status,
              scheduleEnabled: published.scheduleEnabled,
              nextRunAt: published.nextRunAt,
              primaryThreadId: published.primaryThreadId,
            },
            fullPayload: published,
          });
        }),
    }),

    workflowSchedule: tool({
      description:
        'Update a workflow schedule or enable/disable scheduling. If timing is missing, this tool tells you what to ask the user next. Enabling a schedule requires explicit confirmation.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid(),
          schedule: workflowScheduleInputSchema.optional(),
          scheduleEnabled: z.boolean().optional(),
          confirm: z.boolean().optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowSchedule', 'Updating workflow schedule', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'update');
          if (permissionError) {
            return permissionError;
          }
          if (!input.schedule && input.scheduleEnabled === undefined) {
            return buildEnvelope({
              success: false,
              summary:
                'Workflow scheduling needs either a new schedule or an explicit enable/disable decision.',
              errorKind: 'missing_input',
              retryable: false,
              userAction:
                'Ask the user what schedule to set, or whether they want scheduling enabled or paused.',
            });
          }

          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const runtimeDestinations = buildRuntimeWorkflowDestinations(runtime);
          const desiredOutputConfig = toWorkflowOutputConfig(runtimeDestinations);
          let current = await workflowsService.get(session, input.workflowId);
          if (shouldAdoptRuntimeWorkflowDestinations(current.outputConfig, desiredOutputConfig)) {
            current = await workflowsService.update(session, input.workflowId, {
              outputConfig: desiredOutputConfig,
              ...(runtime.departmentId ? { departmentId: runtime.departmentId } : {}),
            });
          }
          if (input.schedule) {
            const parsedSchedule = toWorkflowScheduleConfig(input.schedule);
            if (!parsedSchedule.ok) {
              return buildEnvelope({
                success: false,
                summary: parsedSchedule.summary,
                errorKind: 'missing_input',
                retryable: false,
                userAction: parsedSchedule.userAction,
              });
            }
            current = await workflowsService.update(session, input.workflowId, {
              schedule: parsedSchedule.schedule,
            });
          }

          if (input.scheduleEnabled === true) {
            if (input.confirm !== true) {
              return buildEnvelope({
                success: false,
                summary: 'Enabling a workflow schedule requires explicit confirmation.',
                errorKind: 'missing_input',
                retryable: false,
                userAction: 'Ask the user to confirm enabling the workflow schedule.',
              });
            }
            if (
              typeof current.compiledPrompt !== 'string' ||
              !current.compiledPrompt.trim() ||
              asString(current.status) === 'draft'
            ) {
              return buildEnvelope({
                success: false,
                summary: `Workflow "${asString(current.name) ?? input.workflowId}" must be built and saved before scheduling is enabled.`,
                errorKind: 'missing_input',
                retryable: false,
                userAction: 'Build and save the workflow first, then enable its schedule.',
              });
            }
            const scheduled = await workflowsService.setScheduleState(
              session,
              input.workflowId,
              true,
            );
            return buildEnvelope({
              success: true,
              summary: `Enabled scheduling for "${asString(current.name) ?? input.workflowId}".`,
              keyData: scheduled,
              fullPayload: scheduled,
            });
          }

          if (input.scheduleEnabled === false) {
            const paused = await workflowsService.setScheduleState(
              session,
              input.workflowId,
              false,
            );
            return buildEnvelope({
              success: true,
              summary: `Paused scheduling for "${asString(current.name) ?? input.workflowId}".`,
              keyData: paused,
              fullPayload: paused,
            });
          }

          const refreshed = await workflowsService.get(session, input.workflowId);
          return buildEnvelope({
            success: true,
            summary: `Updated the saved schedule for "${asString(refreshed.name) ?? input.workflowId}".`,
            keyData: {
              workflowId: refreshed.id,
              schedule: refreshed.schedule,
            },
            fullPayload: refreshed,
          });
        }),
    }),

    workflowList: tool({
      description:
        'List saved reusable prompts/workflows available to the current user. Use this for requests like "show my saved prompts" or "list workflows".',
      inputSchema: z
        .object({
          query: z.string().trim().max(160).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowList', 'Listing workflows', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'read');
          if (permissionError) {
            return permissionError;
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflows = await loadDesktopWorkflowsService().listVisibleSummaries(session);
          const filtered = input.query?.trim()
            ? workflows.filter((workflow) =>
                (asString(workflow.name) ?? '')
                  .toLowerCase()
                  .includes(input.query!.trim().toLowerCase()),
              )
            : workflows;
          return buildEnvelope({
            success: true,
            summary:
              filtered.length > 0
                ? `Found ${filtered.length} saved workflow(s).`
                : 'No saved workflows matched the current request.',
            keyData: {
              workflowCount: filtered.length,
            },
            fullPayload: {
              workflows: filtered,
            },
          });
        }),
    }),

    workflowRun: tool({
      description:
        'Run a saved workflow now by id or exact/near-exact name. Use this when the user asks to run a saved prompt/workflow, not when they want immediate ad hoc execution.',
      inputSchema: z
        .object({
          workflowId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(160).optional(),
          overrideText: z.string().trim().max(4000).optional(),
        })
        .strict(),
      execute: async (input) =>
        withLifecycle(hooks, 'workflowRun', 'Running saved workflow', async () => {
          const permissionError = ensureActionPermission(runtime, 'workflow-authoring', 'execute');
          if (permissionError) {
            return permissionError;
          }
          const reference = input.workflowId ?? input.name?.trim();
          if (!reference) {
            return buildEnvelope({
              success: false,
              summary: 'Workflow execution needs a workflow id or workflow name.',
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user which saved workflow should be run.',
            });
          }
          const session = buildRuntimeWorkflowSession(runtime);
          const workflowsService = loadDesktopWorkflowsService();
          const resolved = await workflowsService.resolveVisibleWorkflow(session, reference);
          if (resolved.status === 'not_found') {
            return buildEnvelope({
              success: false,
              summary: `No saved workflow matched "${reference}".`,
              errorKind: 'missing_input',
              retryable: false,
              userAction:
                'Ask the user for the exact workflow name or tell them to list saved workflows first.',
            });
          }
          if (resolved.status === 'ambiguous') {
            return buildEnvelope({
              success: false,
              summary: `Multiple saved workflows matched "${reference}":\n${summarizeWorkflowCandidates(resolved.candidates as Array<Record<string, unknown>>)}`,
              errorKind: 'missing_input',
              retryable: false,
              userAction: 'Ask the user which exact saved workflow should run.',
              fullPayload: resolved,
            });
          }
          const run = await workflowsService.runNow(
            session,
            asString(asRecord(resolved.workflow)?.id) ?? reference,
            input.overrideText ?? null,
          );
          return buildEnvelope({
            success: asString(run.status) !== 'failed',
            summary:
              asString(run.resultSummary) ??
              (asString(run.errorSummary)
                ? `Workflow run finished with an issue: ${asString(run.errorSummary)}`
                : `Started workflow "${asString(asRecord(resolved.workflow)?.name) ?? reference}".`),
            keyData: {
              workflowId: run.workflowId,
              runId: run.runId,
              status: run.status,
              threadId: run.threadId,
            },
            fullPayload: {
              resolved,
              run,
            },
            ...(asString(run.status) === 'failed'
              ? { errorKind: 'api_failure' as const, retryable: true }
              : {}),
          });
        }),
    }),

    skillSearch: tool({
      description:
        'Use this before tool execution when a request is workflow-like or the correct tool path is not obvious. searchSkills finds the right workflow guide; readSkill loads the full operating instructions so you can confidently choose the real domain tool and continue the task.',
      inputSchema: z.object({
        operation: z.enum(['searchSkills', 'readSkill']),
        query: z.string().optional(),
        skillId: z.string().optional(),
        skillSlug: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (input) =>
        withLifecycle(
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
                summary:
                  skills.length > 0
                    ? `Found ${skills.length} relevant skill${skills.length === 1 ? '' : 's'}.`
                    : 'No relevant skills matched the request.',
                keyData: {
                  skills,
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
                summary:
                  'The requested skill was not found in the visible global or department skill scope.',
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
      description:
        'Remote GitHub repository discovery and file retrieval. Do not use for the local open workspace.',
      inputSchema: z.object({
        operation: z.enum(['discoverRepositories', 'inspectRepository', 'retrieveFile']),
        repoQuery: z.string().optional(),
        repoRef: z.string().optional(),
        targetFilePath: z.string().optional(),
        targetFileName: z.string().optional(),
        filePath: z.string().optional(),
        requireRoot: z.boolean().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'repo', 'Inspecting GitHub repositories', async () => {
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
              citations: [
                {
                  id: result.repo.fullName,
                  title: result.repo.fullName,
                  url: result.repo.htmlUrl,
                  kind: 'repository',
                  sourceType: 'github',
                  sourceId: result.repo.fullName,
                },
              ],
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
            citations: [
              {
                id: `${artifact.repo.fullName}:${artifact.path}`,
                title: artifact.path,
                url: artifact.htmlUrl,
                kind: 'file',
                sourceType: 'github',
                sourceId: artifact.repo.fullName,
              },
            ],
          });
        }),
    }),

    coding: tool({
      description:
        "Primary executable local coding tool for the active workspace. Use this for real local workspace work, not as the first step for uploaded/company document retrieval. If the request is about uploaded files or internal company docs, use the internal document tools first. When a workspace is connected, ambiguous file and folder requests refer to LOCAL files by default, not Google Drive or other cloud integrations, unless the user explicitly names a cloud service. These operations execute through workspace policy and approval when needed; they are not suggestion-only plans. The terminal path is the universal local-workspace executor: if a task can be done with shell commands in the active workspace, use runCommand with the exact command. Use inspectWorkspace to list files in the workspace root or a specific subdirectory, readFiles to read exact files, writeFile when you already have the full target path and exact file content, createDirectory to create directories, deletePath to remove files or folders, and runCommand when you need an exact terminal command such as moving, renaming, organizing files, running Python, tests, shell utilities, git, package installs, or multi-file operations. To inspect a folder, call inspectWorkspace with that exact folder path. Never infer a subdirectory's contents from the root listing. Use verifyResult after an approved local action finishes, and verify destructive or mutating actions before reporting success. Legacy aliases like planCommand, runScriptPlan, runScript, writeFilePlan, mkdirPlan, and deletePathPlan are still accepted. Do not call writeFile without contentPlan.path and contentPlan.content. Do not call runCommand without an exact command.",
      inputSchema: z.discriminatedUnion('operation', [
        z.object({
          operation: z.literal('inspectWorkspace'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().optional(),
        }),
        z.object({
          operation: z.literal('readFiles'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          paths: z.array(z.string()).min(1),
        }),
        z.object({
          operation: z.literal('runCommand'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('planCommand'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          command: z.string().min(1),
        }),
        z.object({
          operation: z.literal('runScript'),
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
          operation: z.literal('writeFile'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          contentPlan: z.object({
            path: z.string().min(1),
            content: z.string().min(1),
          }),
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
          operation: z.literal('createDirectory'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('mkdirPlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('deletePath'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('deletePathPlan'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          path: z.string().min(1),
        }),
        z.object({
          operation: z.literal('verifyResult'),
          objective: z.string().min(1),
          workspaceRoot: z.string().optional(),
          expectedOutputs: z.array(z.string()).optional(),
        }),
      ]),
      execute: async (input) =>
        withLifecycle(hooks, 'coding', getCodingActivityTitle(input.operation), async () => {
          const workspaceRoot = input.workspaceRoot?.trim() || runtime.workspace?.path;
          if (!workspaceRoot) {
            return buildEnvelope({
              success: false,
              summary: 'No open workspace is available for local coding actions.',
              errorKind: 'missing_input',
            });
          }

          const executeLarkRemoteLocalAction = async (
            action: RemoteDesktopLocalAction,
            actionGroup: ToolActionGroup,
            successSummary: string,
          ): Promise<VercelToolEnvelope> => {
            const gateway = loadDesktopWsGateway();
            const policy = gateway.getPolicyDecision(runtime.userId, runtime.companyId, action);
            if (
              policy.status === 'none' ||
              policy.status === 'ambiguous' ||
              policy.status === 'deny'
            ) {
              return buildRemoteLocalExecutionUnavailableEnvelope(policy.status);
            }
            if (policy.status === 'ask') {
              return createPendingDesktopRemoteApproval({
                runtime,
                action,
                actionGroup,
                operation: input.operation,
                summary: summarizeRemoteLocalAction(action),
                explanation: input.objective,
              });
            }

            const result = await gateway.dispatchRemoteLocalAction({
              userId: runtime.userId,
              companyId: runtime.companyId,
              action,
              reason: input.objective,
            });
            return buildEnvelope({
              success: result.ok,
              summary: result.ok ? successSummary : result.summary,
              keyData: {
                workspaceRoot: policy.session?.activeWorkspace?.path ?? workspaceRoot,
                actionKind: action.kind,
              },
              fullPayload: {
                action,
                result,
              },
              ...(result.ok ? {} : { errorKind: 'api_failure', retryable: true }),
            });
          };

          if (runtime.channel === 'lark') {
            if (input.operation === 'inspectWorkspace') {
              const result = await executeLarkRemoteLocalAction(
                { kind: 'list_files', ...(input.path?.trim() ? { path: input.path.trim() } : {}) },
                'read',
                `Inspected workspace entries in ${input.path?.trim() ? input.path.trim() : workspaceRoot}.`,
              );
              if (!result.success) {
                return result;
              }
              const payload = asRecord(result.fullPayload?.result?.payload);
              const items = asArray(payload?.items)
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry));
              const resolvedPath = asString(payload?.path) ?? workspaceRoot;
              return buildEnvelope({
                success: true,
                summary: `Inspected ${items.length} workspace entries in ${resolvedPath}.`,
                keyData: {
                  workspaceRoot: resolvedPath,
                  files: items,
                },
                fullPayload: { items },
              });
            }

            if (input.operation === 'readFiles') {
              const files: Array<{ path: string; content: string }> = [];
              for (const filePath of input.paths) {
                const result = await executeLarkRemoteLocalAction(
                  { kind: 'read_file', path: filePath },
                  'read',
                  `Read workspace file ${filePath}.`,
                );
                if (!result.success) {
                  return result;
                }
                const payload = asRecord(result.fullPayload?.result?.payload);
                const content = asString(payload?.content);
                const resolvedPath = asString(payload?.path) ?? filePath;
                if (content === undefined) {
                  return buildEnvelope({
                    success: false,
                    summary: `Remote desktop read succeeded but returned no file content for ${filePath}.`,
                    errorKind: 'api_failure',
                    retryable: true,
                  });
                }
                files.push({
                  path: resolvedPath,
                  content,
                });
              }
              return buildEnvelope({
                success: true,
                summary: `Read ${files.length} workspace file(s).`,
                keyData: {
                  workspaceRoot,
                  files: files.map((item) => item.path),
                },
                fullPayload: { files },
              });
            }

            if (input.operation === 'verifyResult') {
              return summarizeActionResult(runtime, input.expectedOutputs);
            }

            if (
              input.operation === 'runCommand' ||
              input.operation === 'planCommand' ||
              input.operation === 'runScript' ||
              input.operation === 'runScriptPlan'
            ) {
              return executeLarkRemoteLocalAction(
                { kind: 'run_command', command: input.command.trim() },
                'execute',
                `Executed shell command: ${input.command.trim()}`,
              );
            }

            if (input.operation === 'writeFile' || input.operation === 'writeFilePlan') {
              return executeLarkRemoteLocalAction(
                {
                  kind: 'write_file',
                  path: input.contentPlan.path,
                  content: input.contentPlan.content,
                },
                'write',
                `Wrote file ${input.contentPlan.path}.`,
              );
            }

            if (input.operation === 'createDirectory' || input.operation === 'mkdirPlan') {
              return executeLarkRemoteLocalAction(
                { kind: 'mkdir', path: input.path },
                'write',
                `Created directory ${input.path}.`,
              );
            }

            if (input.operation === 'deletePath' || input.operation === 'deletePathPlan') {
              return executeLarkRemoteLocalAction(
                { kind: 'delete_path', path: input.path },
                'delete',
                `Deleted ${input.path}.`,
              );
            }
          }

          if (input.operation === 'inspectWorkspace') {
            const items = await inspectWorkspace(workspaceRoot, input.path?.trim());
            const inspectedPath = input.path?.trim()
              ? resolveWorkspacePath(runtime, input.path.trim())
              : workspaceRoot;
            return buildEnvelope({
              success: true,
              summary: `Inspected ${items.length} workspace entries in ${inspectedPath}.`,
              keyData: {
                workspaceRoot: inspectedPath,
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

          if (
            input.operation === 'runCommand' ||
            input.operation === 'planCommand' ||
            input.operation === 'runScript' ||
            input.operation === 'runScriptPlan'
          ) {
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

          if (input.operation === 'writeFile' || input.operation === 'writeFilePlan') {
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

          if (input.operation === 'createDirectory' || input.operation === 'mkdirPlan') {
            const targetPath = input.path;
            return buildEnvelope({
              success: true,
              summary: `Proposed directory creation: ${targetPath}`,
              keyData: { workspaceRoot },
              pendingApprovalAction: {
                kind: 'create_directory',
                path: targetPath,
                explanation: input.objective,
              },
            });
          }

          if (input.operation === 'deletePath' || input.operation === 'deletePathPlan') {
            const targetPath = input.path;
            return buildEnvelope({
              success: true,
              summary: `Proposed path deletion: ${targetPath}`,
              keyData: { workspaceRoot },
              pendingApprovalAction: {
                kind: 'delete_path',
                path: targetPath,
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
      description:
        'Use the connected Google account to list, read, draft, and send Gmail messages.',
      inputSchema: z.object({
        operation: z.enum([
          'listMessages',
          'getMessage',
          'getThread',
          'createDraft',
          'sendMessage',
          'sendDraft',
        ]),
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
      execute: async (input) =>
        withLifecycle(hooks, 'googleMail', 'Running Gmail workflow', async () => {
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
          const requiresDraft =
            input.operation === 'createDraft' || input.operation === 'sendDraft';
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
            const items = asArray(payload.messages)
              .map((entry) => asRecord(entry))
              .filter(Boolean);
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
      description:
        'Use the connected Google account to list, read, download, and upload Drive files. Do not use this as the first path for uploaded/company documents when the internal document tools can handle the request. If a desktop workspace is connected, ambiguous file and folder requests should go to the LOCAL workspace instead of Google Drive unless the user explicitly says "Drive" or otherwise names Google Drive.',
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
        withLifecycle(hooks, 'googleDrive', 'Running Google Drive workflow', async () => {
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
          const defaultFields =
            'files(id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(emailAddress,displayName))';

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
            const items = asArray(payload.files)
              .map((entry) => asRecord(entry))
              .filter(Boolean);
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
            url.searchParams.set(
              'fields',
              input.fields ??
                'id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(emailAddress,displayName)',
            );
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
              metaUrl.searchParams.set(
                'fields',
                'id,name,webContentLink,webViewLink,mimeType,size',
              );
              const metaResponse = await fetch(metaUrl, {
                headers: { Authorization: `Bearer ${access.accessToken}` },
              });
              const metaPayload = (await metaResponse.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
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
      description:
        'Use the connected Google account to list, read, create, update, and delete Google Calendar events.',
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
        withLifecycle(hooks, 'googleCalendar', 'Running Google Calendar workflow', async () => {
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
            const response = await fetch(
              'https://www.googleapis.com/calendar/v3/users/me/calendarList',
              {
                headers: { Authorization: `Bearer ${access.accessToken}` },
              },
            );
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
            const items = asArray(payload.items)
              .map((entry) => asRecord(entry))
              .filter(Boolean);
            return buildEnvelope({
              success: true,
              summary: `Found ${items.length} Google calendar(s).`,
              keyData: { calendars: items },
              fullPayload: payload,
            });
          }

          if (input.operation === 'listEvents') {
            const url = new URL(
              `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
            );
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
            const items = asArray(payload.items)
              .map((entry) => asRecord(entry))
              .filter(Boolean);
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
            const response = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
              {
                headers: { Authorization: `Bearer ${access.accessToken}` },
              },
            );
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
                  ...(input.attendees?.length
                    ? { attendees: input.attendees.map((email) => ({ email })) }
                    : {}),
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
              ...(input.attendees?.length
                ? { attendees: input.attendees.map((email) => ({ email })) }
                : {}),
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
      description:
        'Read Zoho Books organizations, finance records, reports, comments, templates, attachments, record documents, bank data, and raw email/report metadata.',
      inputSchema: z.object({
        operation: z.enum([
          'listOrganizations',
          'listRecords',
          'getRecord',
          'getRecordDocument',
          'summarizeModule',
          'getReport',
          'listTemplates',
          'listComments',
          'getBooksAttachment',
          'buildOverdueReport',
          'mapCustomerPayments',
          'reconcileVendorStatement',
          'reconcileBankClosing',
          'getLastImportedStatement',
          'getMatchingBankTransactions',
          'getInvoiceEmailContent',
          'getInvoicePaymentReminderContent',
          'getEstimateEmailContent',
          'getCreditNoteEmailContent',
          'getSalesOrderEmailContent',
          'getPurchaseOrderEmailContent',
          'getContactStatementEmailContent',
          'getVendorPaymentEmailContent',
        ]),
        module: z.string().optional(),
        recordId: z.string().optional(),
        organizationId: z.string().optional(),
        accountId: z.string().optional(),
        transactionId: z.string().optional(),
        invoiceId: z.string().optional(),
        creditNoteId: z.string().optional(),
        salesOrderId: z.string().optional(),
        purchaseOrderId: z.string().optional(),
        estimateId: z.string().optional(),
        contactId: z.string().optional(),
        vendorPaymentId: z.string().optional(),
        commentId: z.string().optional(),
        reportName: z.string().optional(),
        templateId: z.string().optional(),
        documentFormat: z.enum(['pdf', 'html']).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        asOfDate: z.string().optional(),
        minOverdueDays: z.number().int().min(0).max(3650).optional(),
        amountTolerance: z.number().min(0).max(1_000_000).optional(),
        dateToleranceDays: z.number().int().min(0).max(3650).optional(),
        customerId: z.string().optional(),
        vendorId: z.string().optional(),
        vendorName: z.string().optional(),
        statementRows: z
          .array(
            z.object({
              rowId: z.string().optional(),
              date: z.string().optional(),
              description: z.string().optional(),
              reference: z.string().optional(),
              amount: z.number().optional(),
              debit: z.number().optional(),
              credit: z.number().optional(),
              balance: z.number().optional(),
              invoiceNumber: z.string().optional(),
              vendorName: z.string().optional(),
              customerName: z.string().optional(),
            }),
          )
          .optional(),
        filters: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'booksRead', 'Running Zoho Books read workflow', async () => {
          const readPermissionError = ensureAnyActionPermission(
            runtime,
            ['zoho-books-read', 'zoho-books-agent'],
            'read',
            'booksRead',
          );
          if (readPermissionError) {
            return readPermissionError;
          }
          const zohoGateway = loadZohoGatewayService();
          const gatewayRequester = buildZohoGatewayRequester(runtime);
          const requireBooksCompanyScope = async (
            operation: string,
          ): Promise<VercelToolEnvelope | null> => {
            const scope =
              asRecord(
                await zohoGateway.resolveScopeContext({
                  companyId: runtime.companyId,
                  requesterEmail: runtime.requesterEmail,
                  requesterAiRole: runtime.requesterAiRole,
                  departmentZohoReadScope: runtime.departmentZohoReadScope,
                  domain: 'books',
                }),
              ) ?? {};
            if (scope.scopeMode === 'company_scoped') {
              return null;
            }
            return buildEnvelope({
              success: false,
              summary: `${operation} requires company-scoped Zoho Books access.`,
              errorKind: 'permission',
              retryable: false,
            });
          };

          if (input.operation === 'listOrganizations') {
            const companyScopeError = await requireBooksCompanyScope('listOrganizations');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const organizations = await loadZohoBooksClient().listOrganizations({
                companyId: runtime.companyId,
              });
              return buildEnvelope({
                success: true,
                summary:
                  organizations.length > 0
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
              const summary =
                error instanceof Error ? error.message : 'Failed to list Zoho Books organizations.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          const moduleName = resolveZohoBooksModuleFromRuntime(
            runtime,
            input.module,
            input.operation,
          );
          const recordId = resolveZohoBooksRecordIdFromRuntime(runtime, moduleName, input.recordId);
          const invoiceId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'invoices',
            input.invoiceId,
          );
          const estimateId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'estimates',
            input.estimateId,
          );
          const creditNoteId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'creditnotes',
            input.creditNoteId,
          );
          const salesOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'salesorders',
            input.salesOrderId,
          );
          const purchaseOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'purchaseorders',
            input.purchaseOrderId,
          );
          const contactId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'contacts',
            input.contactId,
          );
          const vendorPaymentId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'vendorpayments',
            input.vendorPaymentId,
          );
          if (
            input.operation !== 'getLastImportedStatement' &&
            input.operation !== 'getMatchingBankTransactions' &&
            input.operation !== 'getInvoiceEmailContent' &&
            input.operation !== 'getInvoicePaymentReminderContent' &&
            input.operation !== 'getEstimateEmailContent' &&
            input.operation !== 'getContactStatementEmailContent' &&
            input.operation !== 'getVendorPaymentEmailContent' &&
            input.operation !== 'buildOverdueReport' &&
            input.operation !== 'mapCustomerPayments' &&
            input.operation !== 'reconcileVendorStatement' &&
            input.operation !== 'reconcileBankClosing' &&
            !moduleName
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires a supported Zoho Books module such as contacts, invoices, estimates, creditnotes, bills, salesorders, purchaseorders, customerpayments, vendorpayments, bankaccounts, or banktransactions.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          if (input.operation === 'buildOverdueReport') {
            const companyScopeError = await requireBooksCompanyScope('buildOverdueReport');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const report = await loadZohoFinanceOpsService().buildOverdueReport({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                asOfDate: input.asOfDate?.trim(),
                limit: input.limit,
                minOverdueDays: input.minOverdueDays,
              });
              return buildEnvelope({
                success: true,
                summary: asString(report.summary) ?? 'Built Zoho overdue report.',
                keyData: {
                  organizationId: asString(report.organizationId),
                  invoiceCount: asNumber(report.invoiceCount),
                  totalOutstanding: asNumber(report.totalOutstanding),
                },
                fullPayload: report,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to build overdue report.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'mapCustomerPayments') {
            const companyScopeError = await requireBooksCompanyScope('mapCustomerPayments');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const mapping = await loadZohoFinanceOpsService().mapCustomerPayments({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                amountTolerance: input.amountTolerance,
                dateToleranceDays: input.dateToleranceDays,
                limit: input.limit,
                customerId: input.customerId?.trim(),
              });
              return buildEnvelope({
                success: true,
                summary: asString(mapping.summary) ?? 'Mapped customer payments.',
                keyData: {
                  organizationId: asString(mapping.organizationId),
                  exactMatchCount: Array.isArray(mapping.exactMatches)
                    ? mapping.exactMatches.length
                    : undefined,
                  probableMatchCount: Array.isArray(mapping.probableMatches)
                    ? mapping.probableMatches.length
                    : undefined,
                },
                fullPayload: mapping,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to map customer payments.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'reconcileVendorStatement') {
            if (!input.statementRows || input.statementRows.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'reconcileVendorStatement requires statementRows.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('reconcileVendorStatement');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const reconciliation = await loadZohoFinanceOpsService().reconcileVendorStatement({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                statementRows: input.statementRows,
                vendorId: input.vendorId?.trim(),
                vendorName: input.vendorName?.trim(),
                amountTolerance: input.amountTolerance,
                dateToleranceDays: input.dateToleranceDays,
                limit: input.limit,
              });
              return buildEnvelope({
                success: true,
                summary: asString(reconciliation.summary) ?? 'Reconciled vendor statement.',
                keyData: {
                  organizationId: asString(reconciliation.organizationId),
                  matchedCount: Array.isArray(reconciliation.matched)
                    ? reconciliation.matched.length
                    : undefined,
                  probableMatchCount: Array.isArray(reconciliation.probableMatches)
                    ? reconciliation.probableMatches.length
                    : undefined,
                },
                fullPayload: reconciliation,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to reconcile vendor statement.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'reconcileBankClosing') {
            if (!input.statementRows || input.statementRows.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'reconcileBankClosing requires statementRows.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('reconcileBankClosing');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const reconciliation = await loadZohoFinanceOpsService().reconcileBankClosing({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                accountId: input.accountId?.trim(),
                statementRows: input.statementRows,
                amountTolerance: input.amountTolerance,
                dateToleranceDays: input.dateToleranceDays,
                limit: input.limit,
              });
              return buildEnvelope({
                success: true,
                summary: asString(reconciliation.summary) ?? 'Reconciled bank closing.',
                keyData: {
                  organizationId: asString(reconciliation.organizationId),
                  matchedCount: Array.isArray(reconciliation.matched)
                    ? reconciliation.matched.length
                    : undefined,
                  probableMatchCount: Array.isArray(reconciliation.probableMatches)
                    ? reconciliation.probableMatches.length
                    : undefined,
                },
                fullPayload: reconciliation,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to reconcile bank closing.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getLastImportedStatement') {
            if (!input.accountId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getLastImportedStatement requires accountId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('getLastImportedStatement');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getLastImportedBankStatement({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                accountId: input.accountId.trim(),
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched last imported statement for bank account ${input.accountId.trim()}.`,
                keyData: {
                  accountId: input.accountId.trim(),
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch last imported bank statement.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getMatchingBankTransactions') {
            if (!input.transactionId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getMatchingBankTransactions requires transactionId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('getMatchingBankTransactions');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getMatchingBankTransactions({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                transactionId: input.transactionId.trim(),
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books match suggestions for bank transaction ${input.transactionId.trim()}.`,
                keyData: {
                  transactionId: input.transactionId.trim(),
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch matching bank transactions.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getInvoiceEmailContent') {
            if (!invoiceId) {
              return buildEnvelope({
                success: false,
                summary: 'getInvoiceEmailContent requires invoiceId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'invoices',
                    recordId: invoiceId,
                    childType: 'email_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this invoice email content.',
                );
              }
              const result = await loadZohoBooksClient().getInvoiceEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                invoiceId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched invoice email content for ${invoiceId}.`,
                keyData: {
                  invoiceId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch invoice email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getInvoicePaymentReminderContent') {
            if (!invoiceId) {
              return buildEnvelope({
                success: false,
                summary: 'getInvoicePaymentReminderContent requires invoiceId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'invoices',
                    recordId: invoiceId,
                    childType: 'payment_reminder_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this invoice reminder content.',
                );
              }
              const result = await loadZohoBooksClient().getInvoicePaymentReminderContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                invoiceId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched payment reminder email content for invoice ${invoiceId}.`,
                keyData: {
                  invoiceId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch invoice payment reminder content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getEstimateEmailContent') {
            if (!estimateId) {
              return buildEnvelope({
                success: false,
                summary: 'getEstimateEmailContent requires estimateId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'estimates',
                    recordId: estimateId,
                    childType: 'email_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this estimate email content.',
                );
              }
              const result = await loadZohoBooksClient().getEstimateEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                estimateId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched estimate email content for ${estimateId}.`,
                keyData: {
                  estimateId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch estimate email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getCreditNoteEmailContent') {
            if (!creditNoteId) {
              return buildEnvelope({
                success: false,
                summary: 'getCreditNoteEmailContent requires creditNoteId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'creditnotes',
                    recordId: creditNoteId,
                    childType: 'email_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this credit note email content.',
                );
              }
              const result = await loadZohoBooksClient().getCreditNoteEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                creditNoteId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched credit note email content for ${creditNoteId}.`,
                keyData: {
                  creditNoteId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch credit note email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getSalesOrderEmailContent') {
            if (!salesOrderId) {
              return buildEnvelope({
                success: false,
                summary: 'getSalesOrderEmailContent requires salesOrderId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'salesorders',
                    recordId: salesOrderId,
                    childType: 'email_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this sales order email content.',
                );
              }
              const result = await loadZohoBooksClient().getSalesOrderEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                salesOrderId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched sales order email content for ${salesOrderId}.`,
                keyData: {
                  salesOrderId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch sales order email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getPurchaseOrderEmailContent') {
            if (!purchaseOrderId) {
              return buildEnvelope({
                success: false,
                summary: 'getPurchaseOrderEmailContent requires purchaseOrderId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope(
              'getPurchaseOrderEmailContent',
            );
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getPurchaseOrderEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                purchaseOrderId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched purchase order email content for ${purchaseOrderId}.`,
                keyData: {
                  purchaseOrderId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch purchase order email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listTemplates') {
            if (!moduleName) {
              return buildEnvelope({
                success: false,
                summary: 'listTemplates requires a supported Zoho Books module.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('listTemplates');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().listTemplates?.({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books templates for ${moduleName}.`,
                keyData: {
                  module: moduleName,
                  organizationId: result?.organizationId,
                },
                fullPayload: result?.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books templates.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getBooksAttachment') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'getBooksAttachment requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: moduleName,
                    recordId,
                    childType: 'attachments',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this Zoho Books attachment.',
                );
              }
              const result = await loadZohoBooksClient().getAttachment?.({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName,
                recordId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books attachment for ${moduleName} ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: result?.organizationId,
                  sizeBytes: asNumber(asRecord(result?.payload)?.sizeBytes),
                  contentType: asString(asRecord(result?.payload)?.contentType),
                },
                fullPayload: result?.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books attachment.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getRecordDocument') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'getRecordDocument requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: moduleName,
                    recordId,
                    childType: 'record_document',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this Zoho Books document.',
                );
              }
              const result = await loadZohoBooksClient().getRecordDocument?.({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName,
                recordId,
                accept: input.documentFormat ?? 'pdf',
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books ${input.documentFormat ?? 'pdf'} document for ${moduleName} ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: result?.organizationId,
                  format: input.documentFormat ?? 'pdf',
                  sizeBytes: asNumber(asRecord(result?.payload)?.sizeBytes),
                  contentType: asString(asRecord(result?.payload)?.contentType),
                },
                fullPayload: result?.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch Zoho Books record document.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getContactStatementEmailContent') {
            if (!contactId) {
              return buildEnvelope({
                success: false,
                summary: 'getContactStatementEmailContent requires contactId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'contacts',
                    recordId: contactId,
                    childType: 'statement_email_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this contact statement email content.',
                );
              }
              const result = await loadZohoBooksClient().getContactStatementEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                contactId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched contact statement email content for ${contactId}.`,
                keyData: {
                  contactId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch contact statement email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getVendorPaymentEmailContent') {
            if (!vendorPaymentId) {
              return buildEnvelope({
                success: false,
                summary: 'getVendorPaymentEmailContent requires vendorPaymentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope(
              'getVendorPaymentEmailContent',
            );
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getVendorPaymentEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                vendorPaymentId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched vendor payment email content for ${vendorPaymentId}.`,
                keyData: {
                  vendorPaymentId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch vendor payment email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listComments') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'listComments requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: moduleName,
                    recordId,
                    childType: 'comments',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access these Zoho Books comments.',
                );
              }
              const result = await loadZohoBooksClient().listComments({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName: moduleName as
                  | 'invoices'
                  | 'estimates'
                  | 'creditnotes'
                  | 'bills'
                  | 'salesorders'
                  | 'purchaseorders',
                recordId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched comments for Zoho Books ${moduleName} ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books comments.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getReport') {
            if (!input.reportName?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getReport requires reportName.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('getReport');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getReport({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                reportName: input.reportName.trim(),
                filters: input.filters,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books report ${input.reportName.trim()}.`,
                keyData: {
                  reportName: input.reportName.trim(),
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books report.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getRecord') {
            if (!recordId) {
              return buildEnvelope({
                success: false,
                summary: 'getRecord requires recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedRecord({
                    domain: 'books',
                    module: moduleName,
                    recordId,
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access Zoho Books ${moduleName} ${recordId}.`,
                );
              }
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books ${moduleName} record ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: asString(auth.organizationId),
                },
                fullPayload: {
                  organizationId: asString(auth.organizationId),
                  record: asRecord(auth.payload) ?? {},
                },
                citations: [
                  {
                    id: `books-${moduleName}-${recordId}`,
                    title: `${moduleName}:${recordId}`,
                    kind: 'record',
                    sourceType: moduleName,
                    sourceId: recordId,
                  },
                ],
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books record.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          try {
            const auth =
              asRecord(
                await zohoGateway.listAuthorizedRecords({
                  domain: 'books',
                  module: moduleName,
                  requester: gatewayRequester,
                  organizationId: input.organizationId?.trim(),
                  filters: input.filters,
                  limit: input.limit,
                  query: input.query?.trim(),
                }),
              ) ?? {};
            if (auth.allowed !== true) {
              return buildZohoGatewayDeniedEnvelope(
                auth,
                `You are not allowed to read Zoho Books ${moduleName}.`,
              );
            }
            const resultPayload = asRecord(auth.payload) ?? {};
            const resultItems = asArray(resultPayload.records)
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => Boolean(entry));
            const organizationId = asString(auth.organizationId);

            if (input.operation === 'summarizeModule') {
              const statusCounts = resultItems.reduce<Record<string, number>>((acc, item) => {
                const status = asString(item.status) ?? 'unknown';
                acc[status] = (acc[status] ?? 0) + 1;
                return acc;
              }, {});
              return buildEnvelope({
                success: true,
                summary:
                  resultItems.length > 0
                    ? `Summarized ${resultItems.length} Zoho Books ${moduleName} record(s).`
                    : `No Zoho Books ${moduleName} records matched the current filters.`,
                keyData: {
                  module: moduleName,
                  organizationId,
                  recordCount: resultItems.length,
                  statusCounts,
                },
                fullPayload: {
                  organizationId,
                  statusCounts,
                  records: resultItems,
                  raw: asRecord(resultPayload.raw),
                },
              });
            }

            return buildEnvelope({
              success: true,
              summary:
                resultItems.length > 0
                  ? `Found ${resultItems.length} Zoho Books ${moduleName} record(s).`
                  : `No Zoho Books ${moduleName} records matched the current filters.`,
              keyData: {
                module: moduleName,
                organizationId,
                recordCount: resultItems.length,
              },
              fullPayload: {
                organizationId,
                records: resultItems,
                raw: asRecord(resultPayload.raw),
              },
              citations: resultItems.flatMap((record, index) => {
                const recordId =
                  asString(record.contact_id) ??
                  asString(record.vendor_payment_id) ??
                  asString(record.account_id) ??
                  asString(record.invoice_id) ??
                  asString(record.estimate_id) ??
                  asString(record.creditnote_id) ??
                  asString(record.bill_id) ??
                  asString(record.salesorder_id) ??
                  asString(record.purchaseorder_id) ??
                  asString(record.payment_id) ??
                  asString(record.bank_transaction_id) ??
                  asString(record.transaction_id);
                if (!recordId) {
                  return [];
                }
                return [
                  {
                    id: `books-${moduleName}-${index + 1}`,
                    title: `${moduleName}:${recordId}`,
                    kind: 'record',
                    sourceType: moduleName,
                    sourceId: recordId,
                  },
                ];
              }),
            });
          } catch (error) {
            const summary =
              error instanceof Error ? error.message : 'Failed to read Zoho Books records.';
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
      description:
        'Create, update, delete, reconcile, categorize, email, attach files, apply templates, remind, and status-change Zoho Books records through approval-gated actions.',
      inputSchema: z.object({
        operation: z.enum([
          'createRecord',
          'updateRecord',
          'deleteRecord',
          'importBankStatement',
          'activateBankAccount',
          'deactivateBankAccount',
          'matchBankTransaction',
          'unmatchBankTransaction',
          'excludeBankTransaction',
          'restoreBankTransaction',
          'uncategorizeBankTransaction',
          'categorizeBankTransaction',
          'categorizeBankTransactionAsExpense',
          'categorizeBankTransactionAsVendorPayment',
          'categorizeBankTransactionAsCustomerPayment',
          'categorizeBankTransactionAsCreditNoteRefund',
          'emailInvoice',
          'remindInvoice',
          'enableInvoicePaymentReminder',
          'disableInvoicePaymentReminder',
          'writeOffInvoice',
          'cancelInvoiceWriteOff',
          'markInvoiceSent',
          'voidInvoice',
          'markInvoiceDraft',
          'submitInvoice',
          'approveInvoice',
          'emailEstimate',
          'emailCreditNote',
          'openCreditNote',
          'voidCreditNote',
          'refundCreditNote',
          'emailSalesOrder',
          'openSalesOrder',
          'voidSalesOrder',
          'submitSalesOrder',
          'approveSalesOrder',
          'createInvoiceFromSalesOrder',
          'emailPurchaseOrder',
          'openPurchaseOrder',
          'billPurchaseOrder',
          'cancelPurchaseOrder',
          'rejectPurchaseOrder',
          'submitPurchaseOrder',
          'approvePurchaseOrder',
          'enableContactPaymentReminder',
          'disableContactPaymentReminder',
          'markEstimateSent',
          'acceptEstimate',
          'declineEstimate',
          'submitEstimate',
          'approveEstimate',
          'voidBill',
          'openBill',
          'submitBill',
          'approveBill',
          'emailContact',
          'emailContactStatement',
          'emailVendorPayment',
          'applyBooksTemplate',
          'uploadBooksAttachment',
          'deleteBooksAttachment',
          'addBooksComment',
          'updateBooksComment',
          'deleteBooksComment',
        ]),
        module: z.string().optional(),
        recordId: z.string().optional(),
        organizationId: z.string().optional(),
        accountId: z.string().optional(),
        transactionId: z.string().optional(),
        invoiceId: z.string().optional(),
        creditNoteId: z.string().optional(),
        salesOrderId: z.string().optional(),
        purchaseOrderId: z.string().optional(),
        billId: z.string().optional(),
        estimateId: z.string().optional(),
        contactId: z.string().optional(),
        vendorPaymentId: z.string().optional(),
        commentId: z.string().optional(),
        templateId: z.string().optional(),
        fileName: z.string().optional(),
        contentType: z.string().optional(),
        contentBase64: z.string().optional(),
        body: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'booksWrite', 'Running Zoho Books write workflow', async () => {
          const moduleName = resolveZohoBooksModuleFromRuntime(
            runtime,
            input.module,
            input.operation,
          );
          const recordId = resolveZohoBooksRecordIdFromRuntime(runtime, moduleName, input.recordId);
          const invoiceId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'invoices',
            input.invoiceId,
          );
          const estimateId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'estimates',
            input.estimateId,
          );
          const creditNoteId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'creditnotes',
            input.creditNoteId,
          );
          const salesOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'salesorders',
            input.salesOrderId,
          );
          const purchaseOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'purchaseorders',
            input.purchaseOrderId,
          );
          const billId = resolveZohoBooksRecordIdFromRuntime(runtime, 'bills', input.billId);
          const contactId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'contacts',
            input.contactId,
          );
          const vendorPaymentId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'vendorpayments',
            input.vendorPaymentId,
          );
          const body = resolvePendingBooksWriteBodyFromRuntime({
            runtime,
            operation: input.operation,
            moduleName,
            recordId,
            explicitBody: input.body,
          });
          const isRecordCrudOperation = ['createRecord', 'updateRecord', 'deleteRecord'].includes(
            input.operation,
          );
          if (isRecordCrudOperation && !moduleName) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires a supported Zoho Books module such as contacts, invoices, estimates, creditnotes, bills, salesorders, purchaseorders, customerpayments, vendorpayments, bankaccounts, or banktransactions.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const actionGroup: ToolActionGroup =
            input.operation === 'createRecord' || input.operation === 'importBankStatement'
              ? 'create'
              : input.operation === 'updateRecord' ||
                  input.operation === 'activateBankAccount' ||
                  input.operation === 'deactivateBankAccount' ||
                  input.operation === 'matchBankTransaction' ||
                  input.operation === 'unmatchBankTransaction' ||
                  input.operation === 'excludeBankTransaction' ||
                  input.operation === 'restoreBankTransaction' ||
                  input.operation === 'uncategorizeBankTransaction' ||
                  input.operation === 'categorizeBankTransaction' ||
                  input.operation === 'categorizeBankTransactionAsExpense' ||
                  input.operation === 'categorizeBankTransactionAsVendorPayment' ||
                  input.operation === 'categorizeBankTransactionAsCustomerPayment' ||
                  input.operation === 'categorizeBankTransactionAsCreditNoteRefund' ||
                  input.operation === 'enableInvoicePaymentReminder' ||
                  input.operation === 'disableInvoicePaymentReminder' ||
                  input.operation === 'writeOffInvoice' ||
                  input.operation === 'cancelInvoiceWriteOff' ||
                  input.operation === 'markInvoiceSent' ||
                  input.operation === 'voidInvoice' ||
                  input.operation === 'markInvoiceDraft' ||
                  input.operation === 'submitInvoice' ||
                  input.operation === 'approveInvoice' ||
                  input.operation === 'openCreditNote' ||
                  input.operation === 'voidCreditNote' ||
                  input.operation === 'refundCreditNote' ||
                  input.operation === 'openSalesOrder' ||
                  input.operation === 'voidSalesOrder' ||
                  input.operation === 'submitSalesOrder' ||
                  input.operation === 'approveSalesOrder' ||
                  input.operation === 'createInvoiceFromSalesOrder' ||
                  input.operation === 'openPurchaseOrder' ||
                  input.operation === 'billPurchaseOrder' ||
                  input.operation === 'cancelPurchaseOrder' ||
                  input.operation === 'rejectPurchaseOrder' ||
                  input.operation === 'submitPurchaseOrder' ||
                  input.operation === 'approvePurchaseOrder' ||
                  input.operation === 'enableContactPaymentReminder' ||
                  input.operation === 'disableContactPaymentReminder' ||
                  input.operation === 'markEstimateSent' ||
                  input.operation === 'acceptEstimate' ||
                  input.operation === 'declineEstimate' ||
                  input.operation === 'submitEstimate' ||
                  input.operation === 'approveEstimate' ||
                  input.operation === 'voidBill' ||
                  input.operation === 'openBill' ||
                  input.operation === 'submitBill' ||
                  input.operation === 'approveBill' ||
                  input.operation === 'applyBooksTemplate' ||
                  input.operation === 'updateBooksComment'
                ? 'update'
                : input.operation === 'deleteRecord' ||
                    input.operation === 'deleteBooksAttachment' ||
                    input.operation === 'deleteBooksComment'
                  ? 'delete'
                  : 'send';
          const permissionError = ensureAnyActionPermission(
            runtime,
            ['zoho-books-write', 'zoho-books-agent'],
            actionGroup,
            'booksWrite',
          );
          if (permissionError) {
            return permissionError;
          }

          if (input.operation === 'updateRecord' || input.operation === 'deleteRecord') {
            if (!recordId) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires recordId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
          }
          if (
            (input.operation === 'createRecord' ||
              input.operation === 'updateRecord' ||
              input.operation === 'importBankStatement' ||
              input.operation === 'matchBankTransaction' ||
              input.operation === 'categorizeBankTransaction' ||
              input.operation === 'categorizeBankTransactionAsExpense' ||
              input.operation === 'categorizeBankTransactionAsVendorPayment' ||
              input.operation === 'categorizeBankTransactionAsCustomerPayment' ||
              input.operation === 'categorizeBankTransactionAsCreditNoteRefund' ||
              input.operation === 'emailCreditNote' ||
              input.operation === 'refundCreditNote' ||
              input.operation === 'createInvoiceFromSalesOrder' ||
              input.operation === 'addBooksComment' ||
              input.operation === 'updateBooksComment') &&
            !body
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires body.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            (input.operation === 'activateBankAccount' ||
              input.operation === 'deactivateBankAccount' ||
              input.operation === 'importBankStatement') &&
            !input.accountId?.trim()
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires accountId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            [
              'matchBankTransaction',
              'unmatchBankTransaction',
              'excludeBankTransaction',
              'restoreBankTransaction',
              'uncategorizeBankTransaction',
              'categorizeBankTransaction',
              'categorizeBankTransactionAsExpense',
              'categorizeBankTransactionAsVendorPayment',
              'categorizeBankTransactionAsCustomerPayment',
              'categorizeBankTransactionAsCreditNoteRefund',
            ].includes(input.operation) &&
            !input.transactionId?.trim()
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires transactionId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            [
              'emailInvoice',
              'remindInvoice',
              'enableInvoicePaymentReminder',
              'disableInvoicePaymentReminder',
              'writeOffInvoice',
              'cancelInvoiceWriteOff',
              'markInvoiceSent',
              'voidInvoice',
              'markInvoiceDraft',
              'submitInvoice',
              'approveInvoice',
            ].includes(input.operation) &&
            !invoiceId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires invoiceId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            [
              'emailEstimate',
              'markEstimateSent',
              'acceptEstimate',
              'declineEstimate',
              'submitEstimate',
              'approveEstimate',
            ].includes(input.operation) &&
            !estimateId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires estimateId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            ['emailCreditNote', 'openCreditNote', 'voidCreditNote', 'refundCreditNote'].includes(
              input.operation,
            ) &&
            !creditNoteId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires creditNoteId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            [
              'emailSalesOrder',
              'openSalesOrder',
              'voidSalesOrder',
              'submitSalesOrder',
              'approveSalesOrder',
              'createInvoiceFromSalesOrder',
            ].includes(input.operation) &&
            !salesOrderId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires salesOrderId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            [
              'emailPurchaseOrder',
              'openPurchaseOrder',
              'billPurchaseOrder',
              'cancelPurchaseOrder',
              'rejectPurchaseOrder',
              'submitPurchaseOrder',
              'approvePurchaseOrder',
            ].includes(input.operation) &&
            !purchaseOrderId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires purchaseOrderId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            ['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(input.operation) &&
            !billId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires billId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            (input.operation === 'emailContact' || input.operation === 'emailContactStatement') &&
            !contactId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires contactId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            ['enableContactPaymentReminder', 'disableContactPaymentReminder'].includes(
              input.operation,
            ) &&
            !contactId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires contactId.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (input.operation === 'emailVendorPayment' && !vendorPaymentId) {
            return buildEnvelope({
              success: false,
              summary: 'emailVendorPayment requires vendorPaymentId.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (
            ['addBooksComment', 'updateBooksComment', 'deleteBooksComment'].includes(
              input.operation,
            )
          ) {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires a supported module and recordId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'updateBooksComment' ||
                input.operation === 'deleteBooksComment') &&
              !input.commentId?.trim()
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires commentId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
          }
          if (
            ['applyBooksTemplate', 'uploadBooksAttachment', 'deleteBooksAttachment'].includes(
              input.operation,
            )
          ) {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires a supported module and recordId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (input.operation === 'applyBooksTemplate' && !input.templateId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'applyBooksTemplate requires templateId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              input.operation === 'uploadBooksAttachment' &&
              (!input.fileName?.trim() || !input.contentBase64?.trim())
            ) {
              return buildEnvelope({
                success: false,
                summary: 'uploadBooksAttachment requires fileName and contentBase64.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
          }

          const booksMutationAuth =
            asRecord(
              await loadZohoGatewayService().executeAuthorizedMutation({
                ...buildBooksMutationAuthorizationTarget({
                  operation: input.operation,
                  moduleName,
                  recordId,
                  accountId: input.accountId?.trim(),
                  transactionId: input.transactionId?.trim(),
                  invoiceId,
                  estimateId,
                  creditNoteId,
                  salesOrderId,
                  purchaseOrderId,
                  billId,
                  contactId,
                  vendorPaymentId,
                  organizationId: input.organizationId?.trim(),
                }),
                requester: buildZohoGatewayRequester(runtime),
              }),
            ) ?? {};
          if (booksMutationAuth.allowed !== true) {
            return buildZohoGatewayDeniedEnvelope(
              booksMutationAuth,
              `You are not allowed to mutate Zoho Books ${moduleName ?? input.operation}.`,
            );
          }

          let subject =
            input.operation === 'createRecord'
              ? `Create Zoho Books ${moduleName}`
              : input.operation === 'updateRecord'
                ? `Update Zoho Books ${moduleName} ${recordId ?? ''}`.trim()
                : input.operation === 'deleteRecord'
                  ? `Delete Zoho Books ${moduleName} ${recordId ?? ''}`.trim()
                  : input.operation === 'importBankStatement'
                    ? `Import bank statement for account ${input.accountId?.trim() ?? ''}`.trim()
                    : input.operation === 'activateBankAccount'
                      ? `Activate Zoho Books bank account ${input.accountId?.trim() ?? ''}`.trim()
                      : input.operation === 'deactivateBankAccount'
                        ? `Deactivate Zoho Books bank account ${input.accountId?.trim() ?? ''}`.trim()
                        : input.operation === 'matchBankTransaction'
                          ? `Match Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                          : input.operation === 'unmatchBankTransaction'
                            ? `Unmatch Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                            : input.operation === 'excludeBankTransaction'
                              ? `Exclude Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                              : input.operation === 'restoreBankTransaction'
                                ? `Restore Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                                : input.operation === 'uncategorizeBankTransaction'
                                  ? `Uncategorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                                  : input.operation === 'categorizeBankTransaction'
                                    ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                                    : input.operation === 'categorizeBankTransactionAsExpense'
                                      ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as expense`.trim()
                                      : input.operation ===
                                          'categorizeBankTransactionAsVendorPayment'
                                        ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as vendor payment`.trim()
                                        : input.operation ===
                                            'categorizeBankTransactionAsCustomerPayment'
                                          ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as customer payment`.trim()
                                          : input.operation ===
                                              'categorizeBankTransactionAsCreditNoteRefund'
                                            ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as credit note refund`.trim()
                                            : input.operation === 'emailInvoice'
                                              ? `Email Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                              : input.operation === 'remindInvoice'
                                                ? `Send payment reminder for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                : input.operation === 'enableInvoicePaymentReminder'
                                                  ? `Enable payment reminder for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                  : input.operation ===
                                                      'disableInvoicePaymentReminder'
                                                    ? `Disable payment reminder for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                    : input.operation === 'writeOffInvoice'
                                                      ? `Write off Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                      : input.operation === 'cancelInvoiceWriteOff'
                                                        ? `Cancel write off for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                        : input.operation === 'markInvoiceSent'
                                                          ? `Mark Zoho Books invoice ${invoiceId ?? ''} as sent`.trim()
                                                          : input.operation === 'voidInvoice'
                                                            ? `Void Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                            : input.operation === 'markInvoiceDraft'
                                                              ? `Mark Zoho Books invoice ${invoiceId ?? ''} as draft`.trim()
                                                              : input.operation === 'submitInvoice'
                                                                ? `Submit Zoho Books invoice ${invoiceId ?? ''} for approval`.trim()
                                                                : input.operation ===
                                                                    'approveInvoice'
                                                                  ? `Approve Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                                  : input.operation ===
                                                                      'emailEstimate'
                                                                    ? `Email Zoho Books estimate ${estimateId ?? ''}`.trim()
                                                                    : input.operation ===
                                                                        'enableContactPaymentReminder'
                                                                      ? `Enable payment reminders for Zoho Books contact ${contactId ?? ''}`.trim()
                                                                      : input.operation ===
                                                                          'disableContactPaymentReminder'
                                                                        ? `Disable payment reminders for Zoho Books contact ${contactId ?? ''}`.trim()
                                                                        : input.operation ===
                                                                            'markEstimateSent'
                                                                          ? `Mark Zoho Books estimate ${estimateId ?? ''} as sent`.trim()
                                                                          : input.operation ===
                                                                              'acceptEstimate'
                                                                            ? `Mark Zoho Books estimate ${estimateId ?? ''} as accepted`.trim()
                                                                            : input.operation ===
                                                                                'declineEstimate'
                                                                              ? `Mark Zoho Books estimate ${estimateId ?? ''} as declined`.trim()
                                                                              : input.operation ===
                                                                                  'submitEstimate'
                                                                                ? `Submit Zoho Books estimate ${estimateId ?? ''} for approval`.trim()
                                                                                : input.operation ===
                                                                                    'approveEstimate'
                                                                                  ? `Approve Zoho Books estimate ${estimateId ?? ''}`.trim()
                                                                                  : input.operation ===
                                                                                      'voidBill'
                                                                                    ? `Void Zoho Books bill ${billId ?? ''}`.trim()
                                                                                    : input.operation ===
                                                                                        'openBill'
                                                                                      ? `Mark Zoho Books bill ${billId ?? ''} as open`.trim()
                                                                                      : input.operation ===
                                                                                          'submitBill'
                                                                                        ? `Submit Zoho Books bill ${billId ?? ''} for approval`.trim()
                                                                                        : input.operation ===
                                                                                            'approveBill'
                                                                                          ? `Approve Zoho Books bill ${billId ?? ''}`.trim()
                                                                                          : input.operation ===
                                                                                              'emailContact'
                                                                                            ? `Email Zoho Books contact ${contactId ?? ''}`.trim()
                                                                                            : input.operation ===
                                                                                                'emailContactStatement'
                                                                                              ? `Email Zoho Books contact statement ${contactId ?? ''}`.trim()
                                                                                              : `Email Zoho Books vendor payment ${vendorPaymentId ?? ''}`.trim();
          let summary =
            input.operation === 'createRecord'
              ? `Approval required to create a Zoho Books ${moduleName} record.`
              : input.operation === 'updateRecord'
                ? `Approval required to update Zoho Books ${moduleName} ${recordId ?? ''}.`.trim()
                : input.operation === 'deleteRecord'
                  ? `Approval required to delete Zoho Books ${moduleName} ${recordId ?? ''}.`.trim()
                  : input.operation === 'importBankStatement'
                    ? `Approval required to import a bank statement into account ${input.accountId?.trim() ?? ''}.`.trim()
                    : input.operation === 'activateBankAccount'
                      ? `Approval required to activate Zoho Books bank account ${input.accountId?.trim() ?? ''}.`.trim()
                      : input.operation === 'deactivateBankAccount'
                        ? `Approval required to deactivate Zoho Books bank account ${input.accountId?.trim() ?? ''}.`.trim()
                        : input.operation === 'matchBankTransaction'
                          ? `Approval required to match Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                          : input.operation === 'unmatchBankTransaction'
                            ? `Approval required to unmatch Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                            : input.operation === 'excludeBankTransaction'
                              ? `Approval required to exclude Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                              : input.operation === 'restoreBankTransaction'
                                ? `Approval required to restore Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                                : input.operation === 'uncategorizeBankTransaction'
                                  ? `Approval required to uncategorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                                  : input.operation === 'categorizeBankTransaction'
                                    ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                                    : input.operation === 'categorizeBankTransactionAsExpense'
                                      ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as an expense.`.trim()
                                      : input.operation ===
                                          'categorizeBankTransactionAsVendorPayment'
                                        ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as a vendor payment.`.trim()
                                        : input.operation ===
                                            'categorizeBankTransactionAsCustomerPayment'
                                          ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as a customer payment.`.trim()
                                          : input.operation ===
                                              'categorizeBankTransactionAsCreditNoteRefund'
                                            ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as a credit note refund.`.trim()
                                            : input.operation === 'emailInvoice'
                                              ? `Approval required to email Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                              : input.operation === 'remindInvoice'
                                                ? `Approval required to send a payment reminder for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                : input.operation === 'enableInvoicePaymentReminder'
                                                  ? `Approval required to enable payment reminders for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                  : input.operation ===
                                                      'disableInvoicePaymentReminder'
                                                    ? `Approval required to disable payment reminders for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                    : input.operation === 'writeOffInvoice'
                                                      ? `Approval required to write off Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                      : input.operation === 'cancelInvoiceWriteOff'
                                                        ? `Approval required to cancel the write off for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                        : input.operation === 'markInvoiceSent'
                                                          ? `Approval required to mark Zoho Books invoice ${invoiceId ?? ''} as sent.`.trim()
                                                          : input.operation === 'voidInvoice'
                                                            ? `Approval required to void Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                            : input.operation === 'markInvoiceDraft'
                                                              ? `Approval required to mark Zoho Books invoice ${invoiceId ?? ''} as draft.`.trim()
                                                              : input.operation === 'submitInvoice'
                                                                ? `Approval required to submit Zoho Books invoice ${invoiceId ?? ''} for approval.`.trim()
                                                                : input.operation ===
                                                                    'approveInvoice'
                                                                  ? `Approval required to approve Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                                  : input.operation ===
                                                                      'emailEstimate'
                                                                    ? `Approval required to email Zoho Books estimate ${estimateId ?? ''}.`.trim()
                                                                    : input.operation ===
                                                                        'enableContactPaymentReminder'
                                                                      ? `Approval required to enable payment reminders for Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                      : input.operation ===
                                                                          'disableContactPaymentReminder'
                                                                        ? `Approval required to disable payment reminders for Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                        : input.operation ===
                                                                            'markEstimateSent'
                                                                          ? `Approval required to mark Zoho Books estimate ${estimateId ?? ''} as sent.`.trim()
                                                                          : input.operation ===
                                                                              'acceptEstimate'
                                                                            ? `Approval required to mark Zoho Books estimate ${estimateId ?? ''} as accepted.`.trim()
                                                                            : input.operation ===
                                                                                'declineEstimate'
                                                                              ? `Approval required to mark Zoho Books estimate ${estimateId ?? ''} as declined.`.trim()
                                                                              : input.operation ===
                                                                                  'submitEstimate'
                                                                                ? `Approval required to submit Zoho Books estimate ${estimateId ?? ''} for approval.`.trim()
                                                                                : input.operation ===
                                                                                    'approveEstimate'
                                                                                  ? `Approval required to approve Zoho Books estimate ${estimateId ?? ''}.`.trim()
                                                                                  : input.operation ===
                                                                                      'voidBill'
                                                                                    ? `Approval required to void Zoho Books bill ${billId ?? ''}.`.trim()
                                                                                    : input.operation ===
                                                                                        'openBill'
                                                                                      ? `Approval required to mark Zoho Books bill ${billId ?? ''} as open.`.trim()
                                                                                      : input.operation ===
                                                                                          'submitBill'
                                                                                        ? `Approval required to submit Zoho Books bill ${billId ?? ''} for approval.`.trim()
                                                                                        : input.operation ===
                                                                                            'approveBill'
                                                                                          ? `Approval required to approve Zoho Books bill ${billId ?? ''}.`.trim()
                                                                                          : input.operation ===
                                                                                              'emailContact'
                                                                                            ? `Approval required to email Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                                            : input.operation ===
                                                                                                'emailContactStatement'
                                                                                              ? `Approval required to email a statement to Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                                              : `Approval required to email Zoho Books vendor payment ${vendorPaymentId ?? ''}.`.trim();

          if (input.operation === 'emailCreditNote') {
            subject = `Email Zoho Books credit note ${creditNoteId ?? ''}`.trim();
            summary =
              `Approval required to email Zoho Books credit note ${creditNoteId ?? ''}.`.trim();
          } else if (input.operation === 'openCreditNote') {
            subject = `Mark Zoho Books credit note ${creditNoteId ?? ''} as open`.trim();
            summary =
              `Approval required to mark Zoho Books credit note ${creditNoteId ?? ''} as open.`.trim();
          } else if (input.operation === 'voidCreditNote') {
            subject = `Void Zoho Books credit note ${creditNoteId ?? ''}`.trim();
            summary =
              `Approval required to void Zoho Books credit note ${creditNoteId ?? ''}.`.trim();
          } else if (input.operation === 'refundCreditNote') {
            subject = `Refund Zoho Books credit note ${creditNoteId ?? ''}`.trim();
            summary =
              `Approval required to refund Zoho Books credit note ${creditNoteId ?? ''}.`.trim();
          } else if (input.operation === 'emailSalesOrder') {
            subject = `Email Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to email Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'openSalesOrder') {
            subject = `Mark Zoho Books sales order ${salesOrderId ?? ''} as open`.trim();
            summary =
              `Approval required to mark Zoho Books sales order ${salesOrderId ?? ''} as open.`.trim();
          } else if (input.operation === 'voidSalesOrder') {
            subject = `Void Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to void Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'submitSalesOrder') {
            subject = `Submit Zoho Books sales order ${salesOrderId ?? ''} for approval`.trim();
            summary =
              `Approval required to submit Zoho Books sales order ${salesOrderId ?? ''} for approval.`.trim();
          } else if (input.operation === 'approveSalesOrder') {
            subject = `Approve Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to approve Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'createInvoiceFromSalesOrder') {
            subject = `Create invoice from Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to create an invoice from Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'emailPurchaseOrder') {
            subject = `Email Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to email Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'openPurchaseOrder') {
            subject = `Mark Zoho Books purchase order ${purchaseOrderId ?? ''} as open`.trim();
            summary =
              `Approval required to mark Zoho Books purchase order ${purchaseOrderId ?? ''} as open.`.trim();
          } else if (input.operation === 'billPurchaseOrder') {
            subject = `Mark Zoho Books purchase order ${purchaseOrderId ?? ''} as billed`.trim();
            summary =
              `Approval required to mark Zoho Books purchase order ${purchaseOrderId ?? ''} as billed.`.trim();
          } else if (input.operation === 'cancelPurchaseOrder') {
            subject = `Cancel Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to cancel Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'rejectPurchaseOrder') {
            subject = `Reject Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to reject Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'submitPurchaseOrder') {
            subject =
              `Submit Zoho Books purchase order ${purchaseOrderId ?? ''} for approval`.trim();
            summary =
              `Approval required to submit Zoho Books purchase order ${purchaseOrderId ?? ''} for approval.`.trim();
          } else if (input.operation === 'approvePurchaseOrder') {
            subject = `Approve Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to approve Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'addBooksComment') {
            subject = `Add Zoho Books comment on ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to add a comment to Zoho Books ${moduleName} ${recordId ?? ''}.`.trim();
          } else if (input.operation === 'updateBooksComment') {
            subject = `Update Zoho Books comment ${input.commentId?.trim() ?? ''}`.trim();
            summary =
              `Approval required to update Zoho Books comment ${input.commentId?.trim() ?? ''}.`.trim();
          } else if (input.operation === 'deleteBooksComment') {
            subject = `Delete Zoho Books comment ${input.commentId?.trim() ?? ''}`.trim();
            summary =
              `Approval required to delete Zoho Books comment ${input.commentId?.trim() ?? ''}.`.trim();
          } else if (input.operation === 'applyBooksTemplate') {
            subject =
              `Apply Zoho Books template ${input.templateId?.trim() ?? ''} to ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to apply Zoho Books template ${input.templateId?.trim() ?? ''} to ${moduleName} ${recordId ?? ''}.`.trim();
          } else if (input.operation === 'uploadBooksAttachment') {
            subject = `Upload attachment to Zoho Books ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to upload an attachment to Zoho Books ${moduleName} ${recordId ?? ''}.`.trim();
          } else if (input.operation === 'deleteBooksAttachment') {
            subject = `Delete attachment from Zoho Books ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to delete the attachment from Zoho Books ${moduleName} ${recordId ?? ''}.`.trim();
          }

          return createPendingRemoteApproval({
            runtime,
            toolId: 'zoho-books-write',
            actionGroup,
            operation: input.operation,
            summary,
            subject,
            explanation:
              'Zoho Books mutations are approval-gated. Review the module, organization, record target, and payload before proceeding.',
            payload: {
              operation: input.operation,
              module: moduleName,
              recordId,
              organizationId: input.organizationId?.trim(),
              accountId: input.accountId?.trim(),
              transactionId: input.transactionId?.trim(),
              invoiceId,
              billId,
              estimateId,
              creditNoteId,
              salesOrderId,
              purchaseOrderId,
              contactId,
              vendorPaymentId,
              commentId: input.commentId?.trim(),
              templateId: input.templateId?.trim(),
              fileName: input.fileName?.trim(),
              contentType: input.contentType?.trim(),
              contentBase64: input.contentBase64?.trim(),
              body,
            },
          });
        }),
    }),

    larkMessage: tool({
      description:
        'Lark messaging tool for teammate lookup, recipient resolution, and direct-message sends.',
      inputSchema: z.object({
        operation: z.enum(['searchUsers', 'resolveRecipients', 'sendDm']),
        query: z.string().optional(),
        recipientNames: z.array(z.string()).optional(),
        recipientOpenIds: z.array(z.string()).optional(),
        assignToMe: z.boolean().optional(),
        message: z.string().optional(),
        skipConfirmation: z.boolean().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkMessage', 'Running Lark messaging workflow', async () => {
          const formatPersonLabel = (person: Record<string, unknown>): string =>
            asString(person.displayName) ??
            asString(person.email) ??
            asString(person.externalUserId) ??
            asString(person.larkOpenId) ??
            'Unknown teammate';
          const formatPersonStableId = (person: Record<string, unknown>): string =>
            asString(person.larkOpenId) ??
            asString(person.externalUserId) ??
            asString(person.larkUserId) ??
            'unknown';
          const dedupePeople = (
            people: Array<Record<string, unknown>>,
          ): Array<Record<string, unknown>> => {
            const seen = new Set<string>();
            return people.filter((person) => {
              const key = formatPersonStableId(person);
              if (!key || seen.has(key)) {
                return false;
              }
              seen.add(key);
              return true;
            });
          };
          const allPeople = async (): Promise<Array<Record<string, unknown>>> =>
            loadListLarkPeople()({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
            });
          const resolvePeople = async (): Promise<{
            people: Array<Record<string, unknown>>;
            unresolved: string[];
            ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
          }> =>
            loadResolveLarkPeople()({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
              assigneeNames: input.recipientNames,
              assignToMe: input.assignToMe,
            });
          const findPeopleByOpenIds = async (
            recipientOpenIds: string[],
          ): Promise<Array<Record<string, unknown>>> => {
            if (recipientOpenIds.length === 0) {
              return [];
            }
            const people = await allPeople();
            const wanted = new Set(recipientOpenIds.map((value) => value.trim()).filter(Boolean));
            return people.filter((person) => wanted.has(formatPersonStableId(person)));
          };

          if (input.operation === 'searchUsers') {
            const permissionError = ensureActionPermission(runtime, 'lark-message-read', 'read');
            if (permissionError) {
              return permissionError;
            }
            const people = await allPeople();
            const normalizedQuery = input.query?.trim().toLowerCase();
            const filtered = normalizedQuery
              ? people.filter((person) =>
                  [
                    asString(person.displayName),
                    asString(person.email),
                    asString(person.externalUserId),
                    asString(person.larkOpenId),
                    asString(person.larkUserId),
                  ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
                )
              : people;
            return buildEnvelope({
              success: true,
              summary:
                filtered.length > 0
                  ? `Found ${filtered.length} Lark teammate(s).`
                  : 'No Lark teammates matched the request.',
              keyData: {
                people: filtered,
              },
              fullPayload: {
                people: filtered,
              },
            });
          }

          if (input.operation === 'resolveRecipients') {
            const permissionError = ensureActionPermission(runtime, 'lark-message-read', 'read');
            if (permissionError) {
              return permissionError;
            }
            const resolved = await resolvePeople();
            return buildEnvelope({
              success: resolved.unresolved.length === 0 && resolved.ambiguous.length === 0,
              summary:
                resolved.unresolved.length === 0 && resolved.ambiguous.length === 0
                  ? `Resolved ${resolved.people.length} Lark recipient(s).`
                  : resolved.ambiguous.length > 0
                    ? `Recipient resolution is ambiguous for ${resolved.ambiguous.map((entry) => `"${entry.query}"`).join(', ')}.`
                    : `No Lark teammate matched ${resolved.unresolved.map((entry) => `"${entry}"`).join(', ')}.`,
              errorKind:
                resolved.unresolved.length > 0 || resolved.ambiguous.length > 0
                  ? 'validation'
                  : undefined,
              retryable: false,
              userAction:
                resolved.ambiguous.length > 0
                  ? 'Please tell me which teammate you mean.'
                  : resolved.unresolved.length > 0
                    ? 'Please provide a more specific teammate name, email, or Lark ID.'
                    : undefined,
              keyData: {
                resolved: resolved.people.map((person) => ({
                  label: formatPersonLabel(person),
                  openId: formatPersonStableId(person),
                })),
                ambiguous: resolved.ambiguous.map((entry) => ({
                  query: entry.query,
                  matches: entry.matches.map((person) => ({
                    label: formatPersonLabel(person),
                    openId: formatPersonStableId(person),
                  })),
                })),
                unresolved: resolved.unresolved,
              },
              fullPayload: {
                resolved,
              },
            });
          }

          const sendPermissionError = ensureActionPermission(runtime, 'lark-message-write', 'send');
          if (sendPermissionError) {
            return sendPermissionError;
          }
          const message = input.message?.trim();
          if (!message) {
            return buildEnvelope({
              success: false,
              summary: 'Lark DM send requires a message body.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const directRecipientOpenIds = uniqueDefinedStrings(input.recipientOpenIds ?? []);
          const resolvedRecipients =
            (input.recipientNames?.length ?? 0) > 0 || input.assignToMe
              ? await resolvePeople()
              : {
                  people: [],
                  unresolved: [],
                  ambiguous: [] as Array<{
                    query: string;
                    matches: Array<Record<string, unknown>>;
                  }>,
                };
          if (resolvedRecipients.unresolved.length > 0) {
            return buildEnvelope({
              success: false,
              summary: `No Lark teammate matched ${resolvedRecipients.unresolved.map((entry) => `"${entry}"`).join(', ')}.`,
              errorKind: 'validation',
              retryable: false,
              userAction: 'Please provide a more specific teammate name, email, or Lark ID.',
            });
          }
          if (resolvedRecipients.ambiguous.length > 0) {
            const first = resolvedRecipients.ambiguous[0]!;
            const options = first.matches
              .map((person) => `${formatPersonLabel(person)} (${formatPersonStableId(person)})`)
              .join(', ');
            return buildEnvelope({
              success: false,
              summary: `"${first.query}" matched multiple Lark teammates (${options}). Please be more specific.`,
              errorKind: 'validation',
              retryable: false,
              userAction: 'Please tell me which teammate you mean.',
              keyData: {
                ambiguous: resolvedRecipients.ambiguous,
              },
            });
          }

          const directRecipients = await findPeopleByOpenIds(directRecipientOpenIds);
          const resolvedPeople = dedupePeople([...directRecipients, ...resolvedRecipients.people]);
          const recipientOpenIds = uniqueDefinedStrings([
            ...directRecipientOpenIds,
            ...resolvedPeople.map((person) => formatPersonStableId(person)),
          ]);
          if (recipientOpenIds.length === 0) {
            return buildEnvelope({
              success: false,
              summary: 'Please tell me who should receive the Lark DM.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const recipientLabels = recipientOpenIds.map((openId) => {
            const match = resolvedPeople.find((person) => formatPersonStableId(person) === openId);
            return match ? `${formatPersonLabel(match)} (${openId})` : openId;
          });
          const summary = `Approval required to send ${recipientOpenIds.length} Lark DM(s) to ${recipientLabels.join(', ')}.`;
          const preview = message.length > 180 ? `${message.slice(0, 177)}...` : message;

          if (input.skipConfirmation) {
            if (directRecipientOpenIds.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'Workflow-driven Lark DM sends require fixed recipient open IDs.',
                errorKind: 'validation',
                retryable: false,
              });
            }
            const larkMessagingService = loadLarkMessagingService();
            const deliveries = await Promise.all(
              recipientOpenIds.map((recipientOpenId) =>
                withLarkTenantFallback(runtime, (auth) =>
                  larkMessagingService.sendDirectTextMessage({
                    ...(auth as {
                      companyId?: string;
                      larkTenantKey?: string;
                      appUserId?: string;
                      credentialMode?: 'tenant' | 'user_linked';
                    }),
                    recipientOpenId,
                    text: message,
                  }),
                ),
              ),
            );
            return buildEnvelope({
              success: true,
              summary: `Sent ${deliveries.length} Lark DM(s) to ${recipientLabels.join(', ')}.`,
              keyData: {
                recipients: recipientLabels,
              },
              fullPayload: {
                recipients: recipientLabels,
                recipientOpenIds,
                deliveries,
                preview,
              },
            });
          }

          return createPendingRemoteApproval({
            runtime,
            toolId: 'lark-message-write',
            actionGroup: 'send',
            operation: 'sendDm',
            summary,
            subject: `Send Lark DM to ${recipientLabels.join(', ')}`,
            explanation: `Send this Lark DM message: "${preview}"`,
            payload: {
              operation: 'sendDm',
              recipientOpenIds,
              recipientLabels,
              message,
              skipConfirmation: false,
            },
          });
        }),
    }),

    larkTask: tool({
      description:
        'Lark Tasks tool for personal task lookup, tasklist reads, single-task lookup, and task mutations. For personal reads, prefer listMine for "my tasks", listOpenMine for "my open tasks", list for broader tasklist reads, and current only for the latest referenced or single current task.',
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
        ]),
        taskId: z.string().optional(),
        tasklistId: z.string().optional(),
        query: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        completed: z.boolean().optional(),
        onlyMine: z.boolean().optional(),
        onlyOpen: z.boolean().optional(),
        dueTs: z.string().optional(),
        assigneeIds: z.array(z.string()).optional(),
        assigneeNames: z.array(z.string()).optional(),
        assignToMe: z.boolean().optional(),
        extra: z.record(z.unknown()).optional(),
        customFields: z.array(z.unknown()).optional(),
        repeatRule: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkTask', 'Running Lark Tasks workflow', async () => {
          const larkTasksService = loadLarkTasksService();
          logger.info('vercel.lark.task.invoke', {
            executionId: runtime.executionId,
            threadId: runtime.threadId,
            companyId: runtime.companyId,
            userId: runtime.userId,
            operation: input.operation,
            authProvider: runtime.authProvider,
            credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
            hasLarkTenantKey: Boolean(runtime.larkTenantKey),
            hasLarkOpenId: Boolean(runtime.larkOpenId),
            hasLarkUserId: Boolean(runtime.larkUserId),
          });
          const defaults = await getLarkDefaults(runtime);
          const conversationKey = buildConversationKey(runtime.threadId);
          const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
          const normalizeLarkTimestamp = loadNormalizeLarkTimestamp();
          const currentIdentityTokens = uniqueDefinedStrings([
            runtime.larkOpenId,
            runtime.larkUserId,
          ]).map((value) => value.toLowerCase());
          const readObjectStrings = (value: unknown, depth = 0): string[] => {
            if (depth > 4) return [];
            if (typeof value === 'string' && value.trim()) return [value.trim()];
            if (Array.isArray(value)) {
              return value.flatMap((entry) => readObjectStrings(entry, depth + 1));
            }
            const record = asRecord(value);
            if (!record) return [];
            return Object.entries(record).flatMap(([key, entry]) => {
              const lowered = key.toLowerCase();
              if (
                lowered.includes('member') ||
                lowered.includes('assignee') ||
                lowered.includes('owner') ||
                lowered === 'id' ||
                lowered.endsWith('_id') ||
                lowered.endsWith('id') ||
                lowered.includes('open_id') ||
                lowered.includes('user_id')
              ) {
                return readObjectStrings(entry, depth + 1);
              }
              return [];
            });
          };
          const taskMatchesCurrentUser = (task: Record<string, unknown>): boolean => {
            if (currentIdentityTokens.length === 0) return false;
            const candidateValues = uniqueDefinedStrings(
              readObjectStrings(task).map((value) => value.toLowerCase()),
            );
            return currentIdentityTokens.some((token) => candidateValues.includes(token));
          };
          const taskIsOpen = (task: Record<string, unknown>): boolean => {
            const completed = task.completed;
            if (typeof completed === 'boolean') {
              return !completed;
            }
            const status = asString(task.status)?.toLowerCase();
            if (!status) {
              return true;
            }
            return !['completed', 'done', 'closed'].includes(status);
          };
          const listVisibleTasks = async (
            preferredTasklistId?: string,
          ): Promise<Array<Record<string, unknown>>> => {
            const explicitTasklistId = preferredTasklistId?.trim() || defaults?.defaultTasklistId;
            const seen = new Map<string, Record<string, unknown>>();
            const collectFromTasklist = async (tasklistId?: string) => {
              const result = await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.listTasks({
                  ...auth,
                  tasklistId,
                  pageSize: 100,
                }),
              );
              for (const item of result.items) {
                const key = asString(item.taskGuid) ?? asString(item.taskId);
                if (!key) continue;
                seen.set(key, item as unknown as Record<string, unknown>);
              }
            };

            if (explicitTasklistId) {
              await collectFromTasklist(explicitTasklistId);
              return Array.from(seen.values());
            }

            const tasklistsResult = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.listTasklists({
                ...auth,
                pageSize: 50,
              }),
            );
            const tasklistIds = uniqueDefinedStrings(
              tasklistsResult.items.map((item) => asString(item.tasklistId)),
            );
            if (tasklistIds.length === 0) {
              await collectFromTasklist(undefined);
              return Array.from(seen.values());
            }
            for (const tasklistId of tasklistIds) {
              await collectFromTasklist(tasklistId);
            }
            return Array.from(seen.values());
          };
          const filterVisibleTasks = (
            items: Array<Record<string, unknown>>,
            inputQuery?: string,
            options?: {
              onlyMine?: boolean;
              onlyOpen?: boolean;
            },
          ): Array<Record<string, unknown>> => {
            const normalizedQuery = inputQuery?.trim().toLowerCase();
            return items.filter((item) => {
              if (options?.onlyMine && !taskMatchesCurrentUser(item)) {
                return false;
              }
              if (options?.onlyOpen && !taskIsOpen(item)) {
                return false;
              }
              if (!normalizedQuery) {
                return true;
              }
              return `${asString(item.taskId) ?? ''} ${asString(item.summary) ?? ''}`
                .toLowerCase()
                .includes(normalizedQuery);
            });
          };
          const normalizeTaskSummary = (value?: string | null): string =>
            (value ?? '')
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
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
          const extractTaskAssigneeIds = (task: Record<string, unknown>): string[] => {
            const readMemberId = (value: unknown): string | undefined => {
              const record = asRecord(value);
              if (!record) {
                return asString(value);
              }
              return (
                asString(record.id) ??
                asString(record.member_id) ??
                asString(record.member_open_id) ??
                asString(record.open_id) ??
                asString(record.user_id) ??
                asString(record.memberUserId) ??
                asString(record.memberOpenId) ??
                asString(record.larkOpenId) ??
                asString(record.externalUserId)
              );
            };
            const candidateCollections = [
              asArray(task.members),
              asArray(asRecord(task.raw)?.members),
              asArray(task.assignees),
              asArray(asRecord(task.raw)?.assignees),
            ];
            return uniqueDefinedStrings(
              candidateCollections.flatMap((collection) =>
                collection.map((entry) => readMemberId(entry)),
              ),
            );
          };
          const syncTaskAssignees = async (inputArgs: {
            taskGuid: string;
            desiredAssigneeIds: string[];
          }): Promise<{
            task: Record<string, unknown>;
            addedIds: string[];
            removedIds: string[];
            currentAssigneeIds: string[];
          }> => {
            const currentTask = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.getTask({
                ...auth,
                taskGuid: inputArgs.taskGuid,
              }),
            );
            const currentAssigneeIds = extractTaskAssigneeIds(currentTask);
            const desiredAssigneeIds = uniqueDefinedStrings(inputArgs.desiredAssigneeIds);
            const toAdd = desiredAssigneeIds.filter((id) => !currentAssigneeIds.includes(id));
            const toRemove = currentAssigneeIds.filter((id) => !desiredAssigneeIds.includes(id));

            if (toAdd.length > 0) {
              await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.addMembers({
                  ...auth,
                  taskGuid: inputArgs.taskGuid,
                  members: toAdd.map((id) => ({
                    id,
                    type: 'user',
                    role: 'assignee',
                  })),
                }),
              );
            }

            if (toRemove.length > 0) {
              await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.removeMembers({
                  ...auth,
                  taskGuid: inputArgs.taskGuid,
                  members: toRemove.map((id) => ({
                    id,
                    type: 'user',
                    role: 'assignee',
                  })),
                }),
              );
            }

            const refreshedTask =
              toAdd.length > 0 || toRemove.length > 0
                ? await withLarkTenantFallback(runtime, (auth) =>
                    larkTasksService.getTask({
                      ...auth,
                      taskGuid: inputArgs.taskGuid,
                    }),
                  )
                : currentTask;

            return {
              task: refreshedTask,
              addedIds: toAdd,
              removedIds: toRemove,
              currentAssigneeIds,
            };
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
            const lookup = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.listTasks({
                ...auth,
                tasklistId: input.tasklistId ?? defaults?.defaultTasklistId,
                pageSize: 100,
              }),
            );
            const match = lookup.items.find(
              (item) =>
                asString(item.taskId) === trimmed ||
                asString(item.taskGuid) === trimmed ||
                asString(item.summary)?.toLowerCase() === trimmed.toLowerCase(),
            );
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
                  const haystack =
                    `${asString(item.tasklistId) ?? ''} ${asString(item.summary) ?? ''}`.toLowerCase();
                  return haystack.includes(normalizedQuery);
                })
              : tasklistsResult.items;
            return buildEnvelope({
              success: true,
              summary:
                items.length > 0
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
            const enriched = filtered.map((person) => {
              const record = asRecord(person) ?? {};
              const assigneeId = asString(record.larkOpenId) ?? asString(record.externalUserId);
              return {
                ...record,
                ...(assigneeId ? { assigneeId } : {}),
              };
            });
            return buildEnvelope({
              success: true,
              summary:
                enriched.length > 0
                  ? `Found ${enriched.length} assignable Lark teammate(s).`
                  : 'No assignable Lark teammates matched the request.',
              keyData: {
                people: enriched,
              },
              fullPayload: { people: enriched },
            });
          }

          if (input.operation === 'current') {
            if (latestTask?.taskGuid) {
              const task = await withLarkTenantFallback(runtime, (auth) =>
                larkTasksService.getTask({
                  ...auth,
                  taskGuid: latestTask.taskGuid,
                }),
              );
              rememberTask(task);
              return buildEnvelope({
                success: true,
                summary: `Fetched current Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
                keyData: { task },
                fullPayload: { task },
              });
            }
            const latestVisible = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.listTasks({
                ...auth,
                tasklistId: input.tasklistId?.trim() || defaults?.defaultTasklistId,
                pageSize: 25,
              }),
            );
            const sorted = [...latestVisible.items].sort(
              (a, b) => Number(asString(b.updatedAt) ?? '0') - Number(asString(a.updatedAt) ?? '0'),
            );
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
            const task = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.getTask({
                ...auth,
                taskGuid,
              }),
            );
            rememberTask(task);
            return buildEnvelope({
              success: true,
              summary: `Fetched Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}.`,
              keyData: { task },
              fullPayload: { task },
            });
          }

          if (
            input.operation === 'list' ||
            input.operation === 'listMine' ||
            input.operation === 'listOpenMine'
          ) {
            const visibleTasks = await listVisibleTasks(input.tasklistId);
            const items = filterVisibleTasks(visibleTasks, input.query, {
              onlyMine:
                input.operation === 'listMine' ||
                input.operation === 'listOpenMine' ||
                input.onlyMine,
              onlyOpen: input.operation === 'listOpenMine' || input.onlyOpen,
            });
            items.forEach(rememberTask);
            return buildEnvelope({
              success: true,
              summary:
                items.length > 0
                  ? input.operation === 'listOpenMine' || input.onlyOpen
                    ? `Found ${items.length} open Lark task(s) for the current user.`
                    : input.operation === 'listMine' || input.onlyMine
                      ? `Found ${items.length} Lark task(s) for the current user.`
                      : `Found ${items.length} Lark task(s).`
                  : input.operation === 'listOpenMine' || input.onlyOpen
                    ? 'No open Lark tasks matched the request for the current user.'
                    : input.operation === 'listMine' || input.onlyMine
                      ? 'No Lark tasks matched the request for the current user.'
                      : 'No Lark tasks matched the request.',
              keyData: { items },
              fullPayload: {
                items,
                filteredForCurrentUser:
                  input.operation === 'listMine' ||
                  input.operation === 'listOpenMine' ||
                  input.onlyMine ||
                  false,
                filteredForOpen: input.operation === 'listOpenMine' || input.onlyOpen || false,
              },
            });
          }

          const tasklistId = input.tasklistId?.trim() || defaults?.defaultTasklistId;
          const resolvedAssignees =
            input.assignToMe || (input.assigneeNames?.length ?? 0) > 0
              ? await loadResolveLarkTaskAssignees()({
                  companyId: runtime.companyId,
                  appUserId: runtime.userId,
                  requestLarkOpenId: runtime.larkOpenId,
                  assigneeNames: input.assigneeNames,
                  assignToMe: input.assignToMe,
                })
              : null;
          const canonicalizedAssigneeIds =
            (input.assigneeIds?.length ?? 0) > 0
              ? await loadCanonicalizeLarkPersonIds()({
                  companyId: runtime.companyId,
                  appUserId: runtime.userId,
                  requestLarkOpenId: runtime.larkOpenId,
                  assigneeIds: input.assigneeIds,
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
              .map(
                (person) =>
                  asString(asRecord(person)?.displayName) ??
                  asString(asRecord(person)?.email) ??
                  asString(asRecord(person)?.externalUserId),
              )
              .filter((value): value is string => Boolean(value))
              .join(', ');
            return buildEnvelope({
              success: false,
              summary: `"${first.query}" matched multiple teammates (${options}). Please be more specific.`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          if (canonicalizedAssigneeIds?.unresolvedIds.length) {
            return buildEnvelope({
              success: false,
              summary: `No assignable teammate matched id ${canonicalizedAssigneeIds.unresolvedIds.map((value) => `"${value}"`).join(', ')}.`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          if (canonicalizedAssigneeIds?.ambiguousIds.length) {
            const first = canonicalizedAssigneeIds.ambiguousIds[0];
            const options = first.matches
              .map(
                (person) =>
                  asString(asRecord(person)?.displayName) ??
                  asString(asRecord(person)?.email) ??
                  asString(asRecord(person)?.externalUserId),
              )
              .filter((value): value is string => Boolean(value))
              .join(', ');
            return buildEnvelope({
              success: false,
              summary: `Assignee id "${first.query}" matched multiple teammates (${options}). Please be more specific.`,
              errorKind: 'validation',
              retryable: false,
            });
          }
          if (input.operation === 'delete') {
            const taskGuid = await resolveTaskGuid(input.taskId);
            if (!taskGuid) {
              return buildEnvelope({
                success: false,
                summary:
                  'No current task was found in this conversation. Read or create the task first, or provide a task ID.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.deleteTask({
                ...auth,
                taskGuid,
              }),
            );
            return buildEnvelope({
              success: true,
              summary: `Deleted Lark task ${input.taskId?.trim() ?? taskGuid}.`,
              keyData: { task: { taskGuid } },
            });
          }

          const resolvedMembers = (resolvedAssignees?.people ?? [])
            .map((person) => {
              const record = asRecord(person) ?? {};
              return {
                id: asString(record.larkOpenId) ?? asString(record.externalUserId),
                role: 'assignee',
                type: 'user',
              };
            })
            .filter((person) => typeof person.id === 'string');
          const desiredAssigneeIds = uniqueDefinedStrings([
            ...resolvedMembers.map((person) => person.id),
            ...(canonicalizedAssigneeIds?.resolvedIds ?? []),
          ]);
          const assigneeChangeRequested = desiredAssigneeIds.length > 0;
          const desiredAssigneeMembers = desiredAssigneeIds.map((id) => ({
            id,
            role: 'assignee',
            type: 'user',
          }));

          const baseBody: Record<string, unknown> = {
            ...(tasklistId ? { tasklist_id: tasklistId } : {}),
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.dueTs
              ? { due: { timestamp: normalizeLarkTimestamp(input.dueTs, getLarkTimeZone()) } }
              : {}),
            ...(input.operation === 'complete' || input.completed !== undefined
              ? {
                  completed_at:
                    input.operation === 'complete' || input.completed ? String(Date.now()) : '0',
                }
              : {}),
            ...(input.extra ? { extra: input.extra } : {}),
            ...(input.customFields ? { custom_fields: input.customFields } : {}),
            ...(input.repeatRule ? { repeat_rule: input.repeatRule } : {}),
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
            if (!assigneeChangeRequested) {
              return buildEnvelope({
                success: false,
                summary:
                  'Lark task create requires an assignee. Tell me whether this task is for you or name the teammate who should own it.',
                errorKind: 'missing_input',
                retryable: false,
                userAction:
                  'Please tell me whether this task is for you or who it should be assigned to.',
              });
            }
            const requestedSummary = normalizeTaskSummary(input.summary);
            const visibleTasks = await listVisibleTasks(tasklistId);
            const existingTask = visibleTasks.find(
              (item) =>
                requestedSummary.length > 0 &&
                normalizeTaskSummary(asString(item.summary)) === requestedSummary &&
                taskIsOpen(item),
            );
            if (existingTask) {
              let task = existingTask;
              let assigneeSyncSummary: string | null = null;
              const existingTaskGuid =
                asString(existingTask.taskGuid) ??
                asString(existingTask.task_guid) ??
                asString(existingTask.guid);
              if (existingTaskGuid && assigneeChangeRequested) {
                const assigneeSync = await syncTaskAssignees({
                  taskGuid: existingTaskGuid,
                  desiredAssigneeIds,
                });
                task = assigneeSync.task;
                assigneeSyncSummary =
                  assigneeSync.addedIds.length > 0 || assigneeSync.removedIds.length > 0
                    ? `assignees +${assigneeSync.addedIds.length}/-${assigneeSync.removedIds.length}`
                    : 'assignees unchanged';
              }
              rememberTask(task);
              return buildEnvelope({
                success: true,
                summary: `Reused existing Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}${assigneeSyncSummary ? ` (${assigneeSyncSummary})` : ''}.`,
                keyData: { task, deduped: true },
                fullPayload: { task, deduped: true },
              });
            }
            let task = await larkTasksService.createTask({
              ...getLarkAuthInput(runtime),
              body: {
                ...baseBody,
                ...(desiredAssigneeMembers.length > 0 ? { members: desiredAssigneeMembers } : {}),
              },
            });
            let assigneeSyncSummary: string | null = null;
            const createdTaskGuid =
              asString(task.taskGuid) ?? asString(task.task_guid) ?? asString(task.guid);
            if (createdTaskGuid && assigneeChangeRequested) {
              const assigneeSync = await syncTaskAssignees({
                taskGuid: createdTaskGuid,
                desiredAssigneeIds,
              });
              task = assigneeSync.task;
              assigneeSyncSummary =
                assigneeSync.addedIds.length > 0 || assigneeSync.removedIds.length > 0
                  ? `assignees +${assigneeSync.addedIds.length}/-${assigneeSync.removedIds.length}`
                  : 'assignees unchanged';
            }
            rememberTask(task);
            return buildEnvelope({
              success: true,
              summary: `Created Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}${assigneeSyncSummary ? ` (${assigneeSyncSummary})` : ''}.`,
              keyData: { task },
              fullPayload: { task },
            });
          }

          const taskGuid = await resolveTaskGuid(input.taskId);
          if (!taskGuid) {
            return buildEnvelope({
              success: false,
              summary:
                'No current task was found in this conversation. Read or create the task first, or provide a task ID.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const taskPayload = Object.fromEntries(
            Object.entries(baseBody).filter(([key]) => key !== 'tasklist_id'),
          );
          const updateFields = Object.keys(taskPayload)
            .map((field) => (field === 'completed' ? 'completed_at' : field))
            .filter((field) =>
              [
                'description',
                'extra',
                'start',
                'due',
                'completed_at',
                'summary',
                'repeat_rule',
                'custom_fields',
              ].includes(field),
            );
          if (updateFields.length === 0 && !assigneeChangeRequested) {
            return buildEnvelope({
              success: false,
              summary: 'Lark task update requires at least one field to change.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          let task = await withLarkTenantFallback(runtime, (auth) =>
            larkTasksService.getTask({
              ...auth,
              taskGuid,
            }),
          );
          if (updateFields.length > 0) {
            task = await withLarkTenantFallback(runtime, (auth) =>
              larkTasksService.updateTask({
                ...auth,
                taskGuid,
                body: {
                  task: taskPayload,
                  update_fields: updateFields,
                },
              }),
            );
          }
          let assigneeSyncSummary: string | null = null;
          if (assigneeChangeRequested) {
            const assigneeSync = await syncTaskAssignees({
              taskGuid,
              desiredAssigneeIds,
            });
            task = assigneeSync.task;
            assigneeSyncSummary =
              assigneeSync.addedIds.length > 0 || assigneeSync.removedIds.length > 0
                ? `assignees +${assigneeSync.addedIds.length}/-${assigneeSync.removedIds.length}`
                : 'assignees unchanged';
          }
          rememberTask(task);
          return buildEnvelope({
            success: true,
            summary: `${input.operation === 'reassign' ? 'Reassigned' : 'Updated'} Lark task: ${asString(task.summary) ?? asString(task.taskId) ?? 'task'}${assigneeSyncSummary ? ` (${assigneeSyncSummary})` : ''}.`,
            keyData: { task },
            fullPayload: { task },
          });
        }),
    }),

    larkCalendar: tool({
      description:
        'Comprehensive Lark Calendar tool for day lookups, attendee-aware scheduling, availability checks, and event mutations.',
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
        location: z.string().optional(),
        attendeeNames: z.array(z.string()).optional(),
        attendeeIds: z.array(z.string()).optional(),
        includeMe: z.boolean().optional(),
        needNotification: z.boolean().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkCalendar', 'Running Lark Calendar workflow', async () => {
          const calendarService = loadLarkCalendarService();
          const defaults = await getLarkDefaults(runtime);
          const normalizeLarkTimestamp = loadNormalizeLarkTimestamp();
          const resolveLarkPeople = loadResolveLarkPeople();
          const timeZone = getLarkTimeZone();
          const conversationKey = buildConversationKey(runtime.threadId);
          const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
          const effectiveDateScope = input.dateScope ?? runtime.dateScope;
          const latestUserMessage = runtime.latestUserMessage?.trim() ?? '';
          const authInput = getLarkAuthInput(runtime);
          const extractAttendeeNamesFromMessage = (message: string): string[] => {
            if (!message) return [];
            const attendeeBlock =
              message.match(
                /\battendees?\s+(.+?)(?=\s*(?:$| at\b| on\b| tomorrow\b| today\b))/i,
              )?.[1] ??
              message.match(/\bwith\s+(.+?)(?=\s*(?:$| at\b| on\b| tomorrow\b| today\b))/i)?.[1] ??
              '';
            if (!attendeeBlock) return [];
            return attendeeBlock
              .split(/,|\band\b/gi)
              .map((value) => value.trim())
              .filter(
                (value) => value.length > 0 && !/^(me|myself|us|ourselves|our team)$/i.test(value),
              );
          };
          const extractCalendarSummaryFromMessage = (message: string): string | undefined => {
            if (!message) return undefined;
            const quoted = message.match(/['"]([^'"]{3,120})['"]/);
            if (quoted?.[1]) {
              return quoted[1].trim();
            }
            const titled = message.match(/(.+?)\s+is\s+the\s+title\b/i);
            if (titled?.[1]) {
              return titled[1].trim().replace(/^["']|["']$/g, '');
            }
            const summaryAfterLabel = message.match(/\btitle\s*(?:is|:)\s*([^,\n]+)/i);
            if (summaryAfterLabel?.[1]) {
              return summaryAfterLabel[1].trim().replace(/^["']|["']$/g, '');
            }
            return undefined;
          };
          const extractCalendarStartTimeFromMessage = (message: string): string | undefined => {
            if (!message) return undefined;
            const explicitAt = message.match(
              /\bat\s+([^,\n]+?)(?=\s*(?:,|attendees?\b|with\b|for\b|$))/i,
            );
            if (explicitAt?.[1]) {
              return explicitAt[1].trim();
            }
            return undefined;
          };
          const resolvedAttendeeNames = (
            input.attendeeNames?.length
              ? input.attendeeNames
              : extractAttendeeNamesFromMessage(latestUserMessage)
          )
            .map((value) => value.trim())
            .filter(Boolean);
          const resolvedIncludeMe =
            input.includeMe ??
            /\b(me|myself|us|our calendars?|our calendar)\b/i.test(latestUserMessage);
          const attendeeAwareScheduling =
            input.operation === 'scheduleMeeting' ||
            (input.operation === 'createEvent' &&
              (resolvedAttendeeNames.length > 0 || Boolean(input.attendeeIds?.length)));
          const resolvedSummary =
            input.summary?.trim() || extractCalendarSummaryFromMessage(latestUserMessage);
          const resolvedStartTimeInput =
            input.startTime ??
            (input.operation === 'createEvent' ||
            input.operation === 'scheduleMeeting' ||
            input.operation === 'listAvailability'
              ? extractCalendarStartTimeFromMessage(latestUserMessage)
              : undefined);
          const toEpochMs = (value?: string): number | null => {
            const normalized = normalizeLarkTimestamp(value, timeZone);
            if (!normalized) {
              return null;
            }
            const parsed = Number(normalized);
            return Number.isFinite(parsed) ? parsed * 1000 : null;
          };
          const toRfc3339 = (value?: string): string | null => {
            const epochMs = toEpochMs(value);
            return epochMs ? new Date(epochMs).toISOString() : null;
          };
          const formatEpoch = (epochMs: number): string => new Date(epochMs).toISOString();
          const mergeBusyIntervals = (
            items: Array<{ startMs: number; endMs: number }>,
          ): Array<{ startMs: number; endMs: number }> => {
            const sorted = [...items]
              .filter(
                (item) =>
                  Number.isFinite(item.startMs) &&
                  Number.isFinite(item.endMs) &&
                  item.endMs > item.startMs,
              )
              .sort((left, right) => left.startMs - right.startMs);
            const merged: Array<{ startMs: number; endMs: number }> = [];
            for (const item of sorted) {
              const last = merged[merged.length - 1];
              if (!last || item.startMs > last.endMs) {
                merged.push({ ...item });
                continue;
              }
              last.endMs = Math.max(last.endMs, item.endMs);
            }
            return merged;
          };
          const findEarliestCommonSlot = (inputArgs: {
            windowStartMs: number;
            windowEndMs: number;
            durationMinutes: number;
            busyIntervals: Array<{ startMs: number; endMs: number }>;
          }): { startMs: number; endMs: number } | null => {
            const merged = mergeBusyIntervals(inputArgs.busyIntervals);
            const durationMs = inputArgs.durationMinutes * 60_000;
            let cursor = inputArgs.windowStartMs;
            for (const busy of merged) {
              if (busy.startMs - cursor >= durationMs) {
                return { startMs: cursor, endMs: cursor + durationMs };
              }
              cursor = Math.max(cursor, busy.endMs);
            }
            if (inputArgs.windowEndMs - cursor >= durationMs) {
              return { startMs: cursor, endMs: cursor + durationMs };
            }
            return null;
          };
          const resolveAttendees = async (): Promise<{
            people: Array<Record<string, unknown>>;
            unresolved: string[];
            ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
            desiredIds: string[];
          }> => {
            const resolved = await resolveLarkPeople({
              companyId: runtime.companyId,
              appUserId: runtime.userId,
              requestLarkOpenId: runtime.larkOpenId,
              assigneeNames: resolvedAttendeeNames,
              assignToMe: resolvedIncludeMe,
            });
            const desiredIds = uniqueDefinedStrings([
              ...resolved.people.map(
                (person) =>
                  asString(asRecord(person)?.larkOpenId) ??
                  asString(asRecord(person)?.externalUserId),
              ),
              ...(input.attendeeIds ?? []),
            ]);
            return {
              ...resolved,
              desiredIds,
            };
          };

          if (input.operation === 'listCalendars') {
            const result = await calendarService.listCalendars({
              ...authInput,
              pageSize: 50,
            });
            const normalizedQuery = input.calendarName?.trim().toLowerCase();
            const calendars = normalizedQuery
              ? result.items.filter((item) =>
                  `${asString(item.calendarId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                    .toLowerCase()
                    .includes(normalizedQuery),
                )
              : result.items;
            return buildEnvelope({
              success: true,
              summary:
                calendars.length > 0
                  ? `Found ${calendars.length} Lark calendar(s).`
                  : 'No Lark calendars matched the request.',
              keyData: { calendars },
              fullPayload: { ...result, items: calendars },
            });
          }
          let resolvedCalendarId =
            input.calendarId?.trim() || defaults?.defaultCalendarId || latestEvent?.calendarId;
          if (!resolvedCalendarId && input.calendarName?.trim()) {
            const lookup = await calendarService.listCalendars({
              ...authInput,
              pageSize: 50,
            });
            const candidates = lookup.items.filter((item) =>
              `${asString(item.calendarId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                .toLowerCase()
                .includes(input.calendarName!.trim().toLowerCase()),
            );
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
          if (!resolvedCalendarId && input.operation !== 'listAvailability') {
            try {
              const primary = await calendarService.getPrimaryCalendar(authInput);
              resolvedCalendarId = asString(primary.calendarId);
            } catch {
              return buildEnvelope({
                success: false,
                summary:
                  'No default Lark calendar is configured and no primary calendar could be resolved. Provide calendarId or calendarName.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
          }
          if (input.operation === 'listEvents' || input.operation === 'getEvent') {
            const result = await calendarService.listEvents({
              ...authInput,
              calendarId: resolvedCalendarId,
              pageSize: 100,
              startTime: normalizeLarkTimestamp(input.startTime ?? effectiveDateScope, timeZone),
              endTime: normalizeLarkTimestamp(input.endTime, timeZone),
            });
            const normalizedQuery = (
              input.operation === 'getEvent' ? input.eventId : effectiveDateScope
            )
              ?.trim()
              .toLowerCase();
            const events = normalizedQuery
              ? result.items.filter((item) =>
                  `${asString(item.eventId) ?? ''} ${asString(item.summary) ?? ''} ${asString(item.description) ?? ''}`
                    .toLowerCase()
                    .includes(normalizedQuery),
                )
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
              summary:
                events.length > 0
                  ? `Found ${events.length} Lark calendar event(s).`
                  : 'No Lark calendar events matched the request.',
              keyData: {
                calendar: { calendarId: resolvedCalendarId },
                events,
                event: events[0],
              },
              fullPayload: { ...result, items: events },
            });
          }
          if (input.operation === 'listAvailability' || attendeeAwareScheduling) {
            const resolvedAttendees = await resolveAttendees();
            if (resolvedAttendees.unresolved.length > 0) {
              return buildEnvelope({
                success: false,
                summary: `No Lark teammate matched ${resolvedAttendees.unresolved.map((value) => `"${value}"`).join(', ')}.`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            if (resolvedAttendees.ambiguous.length > 0) {
              const first = resolvedAttendees.ambiguous[0];
              const options = first.matches
                .map(
                  (person) =>
                    asString(asRecord(person)?.displayName) ??
                    asString(asRecord(person)?.email) ??
                    asString(asRecord(person)?.externalUserId),
                )
                .filter((value): value is string => Boolean(value))
                .join(', ');
              return buildEnvelope({
                success: false,
                summary: `"${first.query}" matched multiple teammates (${options}). Please be more specific.`,
                errorKind: 'validation',
                retryable: false,
              });
            }
            if (resolvedAttendees.desiredIds.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'Please tell me who should be included in the meeting.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }

            const explicitStartRfc3339 = toRfc3339(resolvedStartTimeInput);
            const explicitEndRfc3339 = toRfc3339(input.endTime);
            const inferredDurationMinutes =
              input.durationMinutes ??
              (explicitStartRfc3339 && explicitEndRfc3339
                ? Math.max(
                    1,
                    Math.round(
                      (Date.parse(explicitEndRfc3339) - Date.parse(explicitStartRfc3339)) / 60_000,
                    ),
                  )
                : undefined);
            const defaultMeetingDurationMinutes = 30;
            const effectiveDurationMinutes =
              inferredDurationMinutes ??
              (attendeeAwareScheduling && explicitStartRfc3339
                ? defaultMeetingDurationMinutes
                : undefined);
            const inferredExactEndRfc3339 =
              !explicitEndRfc3339 && explicitStartRfc3339 && effectiveDurationMinutes
                ? new Date(
                    Date.parse(explicitStartRfc3339) + effectiveDurationMinutes * 60_000,
                  ).toISOString()
                : explicitEndRfc3339;

            const searchStartTime =
              input.searchStartTime ?? resolvedStartTimeInput ?? effectiveDateScope;
            const searchEndTime =
              input.searchEndTime ??
              input.endTime ??
              (attendeeAwareScheduling && explicitStartRfc3339
                ? (inferredExactEndRfc3339 ??
                  new Date(
                    Date.parse(explicitStartRfc3339) + defaultMeetingDurationMinutes * 60_000,
                  ).toISOString())
                : undefined);
            const searchStartRfc3339 = input.searchStartTime
              ? toRfc3339(input.searchStartTime)
              : (explicitStartRfc3339 ?? toRfc3339(searchStartTime));
            const searchEndRfc3339 = input.searchEndTime
              ? toRfc3339(input.searchEndTime)
              : (toRfc3339(searchEndTime) ?? inferredExactEndRfc3339);
            if (!searchStartRfc3339 || !searchEndRfc3339) {
              return buildEnvelope({
                success: false,
                summary:
                  input.operation === 'listAvailability'
                    ? 'Availability lookup requires searchStartTime and searchEndTime.'
                    : 'Scheduling a meeting requires a concrete start time, or a search window. Provide startTime, or searchStartTime and searchEndTime.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const windowStartMs = Date.parse(searchStartRfc3339);
            const windowEndMs = Date.parse(searchEndRfc3339);
            if (
              !Number.isFinite(windowStartMs) ||
              !Number.isFinite(windowEndMs) ||
              windowEndMs <= windowStartMs
            ) {
              return buildEnvelope({
                success: false,
                summary:
                  'The requested scheduling window is invalid. searchEndTime must be after searchStartTime.',
                errorKind: 'validation',
                retryable: false,
              });
            }

            const freebusyByPerson = await Promise.all(
              resolvedAttendees.desiredIds.map(async (userId) => {
                const busy = await withLarkTenantFallback(runtime, (auth) =>
                  calendarService.listFreebusy({
                    ...auth,
                    userId,
                    userIdType: 'open_id',
                    timeMin: searchStartRfc3339,
                    timeMax: searchEndRfc3339,
                    includeExternalCalendar: true,
                    onlyBusy: true,
                  }),
                );
                return {
                  userId,
                  busy,
                };
              }),
            );

            const busyIntervals = freebusyByPerson.flatMap((entry) =>
              entry.busy
                .map((slot) => {
                  const record = asRecord(slot) ?? {};
                  return {
                    userId: entry.userId,
                    startMs: Date.parse(
                      asString(record.startTime) ?? asString(record.start_time) ?? '',
                    ),
                    endMs: Date.parse(asString(record.endTime) ?? asString(record.end_time) ?? ''),
                  };
                })
                .filter((slot) => Number.isFinite(slot.startMs) && Number.isFinite(slot.endMs)),
            );

            const availability = freebusyByPerson.map((entry) => {
              const person = resolvedAttendees.people.find(
                (candidate) =>
                  (asString(asRecord(candidate)?.larkOpenId) ??
                    asString(asRecord(candidate)?.externalUserId)) === entry.userId,
              );
              return {
                userId: entry.userId,
                displayName:
                  asString(asRecord(person)?.displayName) ??
                  asString(asRecord(person)?.email) ??
                  entry.userId,
                busy: entry.busy,
              };
            });

            if (input.operation === 'listAvailability') {
              return buildEnvelope({
                success: true,
                summary: `Fetched availability for ${availability.length} attendee(s).`,
                keyData: {
                  availability,
                  window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
                },
                fullPayload: {
                  availability,
                  busyIntervals,
                  window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
                },
              });
            }

            const durationMinutes = effectiveDurationMinutes;
            if (!resolvedSummary) {
              return buildEnvelope({
                success: false,
                summary: 'Meeting scheduling requires a summary/title.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (!durationMinutes && !(explicitStartRfc3339 && inferredExactEndRfc3339)) {
              return buildEnvelope({
                success: false,
                summary:
                  'Meeting scheduling requires a concrete startTime, or durationMinutes plus a search window.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }

            const chosenSlot = explicitStartRfc3339
              ? {
                  startMs: Date.parse(explicitStartRfc3339),
                  endMs: Date.parse(inferredExactEndRfc3339 as string),
                }
              : findEarliestCommonSlot({
                  windowStartMs,
                  windowEndMs,
                  durationMinutes: durationMinutes as number,
                  busyIntervals,
                });

            if (!chosenSlot) {
              return buildEnvelope({
                success: false,
                summary:
                  'No common free slot was found for the requested attendees in that time window.',
                errorKind: 'validation',
                retryable: false,
                fullPayload: {
                  availability,
                  window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
                },
              });
            }

            const eventBody = {
              summary: resolvedSummary,
              ...(input.description?.trim() ? { description: input.description.trim() } : {}),
              start_time: { timestamp: String(Math.floor(chosenSlot.startMs / 1000)) },
              end_time: { timestamp: String(Math.floor(chosenSlot.endMs / 1000)) },
            };
            const event = await calendarService.createEvent({
              ...authInput,
              calendarId: resolvedCalendarId,
              body: eventBody,
            });

            const attendeesToAdd = resolvedAttendees.people
              .filter((person) => !Boolean(asRecord(person)?.isCurrentUser))
              .map((person) => ({
                type: 'user',
                attendee_id:
                  asString(asRecord(person)?.larkOpenId) ??
                  asString(asRecord(person)?.externalUserId),
              }))
              .filter((item) => typeof item.attendee_id === 'string');

            let attendeeResult: Record<string, unknown> | null = null;
            if (attendeesToAdd.length > 0 && asString(event.eventId)) {
              attendeeResult = await calendarService.addEventAttendees({
                ...authInput,
                calendarId: resolvedCalendarId,
                eventId: asString(event.eventId),
                userIdType: 'open_id',
                needNotification: input.needNotification ?? true,
                attendees: attendeesToAdd,
              });
            }

            conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
              eventId: asString(event.eventId) ?? '',
              calendarId: resolvedCalendarId,
              summary: asString(event.summary) ?? resolvedSummary,
              startTime: asString(event.startTime) ?? formatEpoch(chosenSlot.startMs),
              endTime: asString(event.endTime) ?? formatEpoch(chosenSlot.endMs),
              url: asString(event.url),
            });
            return buildEnvelope({
              success: true,
              summary: `Scheduled Lark meeting "${resolvedSummary}" for ${availability.length} attendee(s).`,
              keyData: {
                event,
                scheduledStartTime: formatEpoch(chosenSlot.startMs),
                scheduledEndTime: formatEpoch(chosenSlot.endMs),
                attendees: availability,
              },
              fullPayload: {
                event,
                attendeeResult,
                attendees: availability,
                chosenSlot: {
                  startTime: formatEpoch(chosenSlot.startMs),
                  endTime: formatEpoch(chosenSlot.endMs),
                },
                window: { startTime: searchStartRfc3339, endTime: searchEndRfc3339 },
              },
            });
          }
          const resolvedEventId = input.eventId?.trim() || latestEvent?.eventId;
          if (
            (input.operation === 'updateEvent' || input.operation === 'deleteEvent') &&
            !resolvedEventId
          ) {
            return buildEnvelope({
              success: false,
              summary: `No current event was found in this conversation. Read or create the event first, or provide an event ID.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          if (input.operation === 'deleteEvent') {
            await calendarService.deleteEvent({
              ...authInput,
              calendarId: resolvedCalendarId,
              eventId: resolvedEventId as string,
            });
            return buildEnvelope({
              success: true,
              summary: `Deleted Lark calendar event ${resolvedEventId as string}.`,
              keyData: { event: { eventId: resolvedEventId } },
            });
          }
          const inferredCreateStartTime = resolvedStartTimeInput ?? effectiveDateScope;
          const inferredCreateEndTime =
            input.endTime ??
            (inferredCreateStartTime && normalizeLarkTimestamp(inferredCreateStartTime, timeZone)
              ? new Date(
                  (Number(normalizeLarkTimestamp(inferredCreateStartTime, timeZone)) + 30 * 60) *
                    1000,
                ).toISOString()
              : undefined);
          if (
            input.operation === 'createEvent' &&
            (!resolvedSummary || !inferredCreateStartTime || !inferredCreateEndTime)
          ) {
            return buildEnvelope({
              success: false,
              summary: 'Lark calendar create requires summary, startTime, and endTime.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }
          const body = {
            ...(resolvedSummary ? { summary: resolvedSummary } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(inferredCreateStartTime
              ? {
                  start_time: {
                    timestamp: normalizeLarkTimestamp(inferredCreateStartTime, timeZone),
                  },
                }
              : {}),
            ...(inferredCreateEndTime
              ? { end_time: { timestamp: normalizeLarkTimestamp(inferredCreateEndTime, timeZone) } }
              : {}),
          };
          const event =
            input.operation === 'createEvent'
              ? await calendarService.createEvent({
                  ...authInput,
                  calendarId: resolvedCalendarId,
                  body,
                })
              : await calendarService.updateEvent({
                  ...authInput,
                  calendarId: resolvedCalendarId,
                  eventId: resolvedEventId as string,
                  body,
                });
          conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
            eventId: asString(event.eventId) ?? '',
            calendarId: resolvedCalendarId,
            summary: asString(event.summary) ?? resolvedSummary,
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
      description:
        'Read-only Lark meeting and minute lookup. Use calendar for day-based meeting discovery.',
      inputSchema: z.object({
        operation: z.enum(['list', 'get', 'getMinute']),
        meetingId: z.string().optional(),
        meetingNo: z.string().optional(),
        minuteToken: z.string().optional(),
        query: z.string().optional(),
        dateScope: z.string().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'larkMeeting', 'Running Lark Meeting workflow', async () => {
          const effectiveDateScope = input.dateScope ?? runtime.dateScope;
          if (input.operation === 'list' && effectiveDateScope) {
            return buildEnvelope({
              success: false,
              summary:
                'Day-based meeting discovery is unsupported in the VC meetings API. Use larkCalendar for date-scoped meeting lookup.',
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
                `${asString(item.meetingId) ?? ''} ${asString(item.topic) ?? ''}`
                  .toLowerCase()
                  .includes(normalizedQuery),
              )
            : result.items;
          return buildEnvelope({
            success: true,
            summary:
              items.length > 0
                ? `Found ${items.length} Lark meeting(s).`
                : 'No Lark meetings matched the request.',
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
      execute: async (input) =>
        withLifecycle(hooks, 'larkApproval', 'Running Lark Approvals workflow', async () => {
          const approvalsService = loadLarkApprovalsService();
          const defaults = await getLarkDefaults(runtime);
          logger.info('vercel.lark.approval.invoke', {
            executionId: runtime.executionId,
            threadId: runtime.threadId,
            companyId: runtime.companyId,
            userId: runtime.userId,
            operation: input.operation,
            authProvider: runtime.authProvider,
            credentialMode: runtime.authProvider === 'lark' ? 'user_linked' : 'tenant',
            hasLarkTenantKey: Boolean(runtime.larkTenantKey),
            hasLarkOpenId: Boolean(runtime.larkOpenId),
            hasLarkUserId: Boolean(runtime.larkUserId),
            hasApprovalCode: Boolean(input.approvalCode?.trim() || defaults?.defaultApprovalCode),
            status: input.status ?? null,
          });
          if (input.operation === 'getInstance') {
            if (!input.instanceCode?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getInstance requires instanceCode.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const instance = await withLarkTenantFallback(runtime, (auth) =>
              approvalsService.getInstance({
                ...auth,
                instanceCode: input.instanceCode.trim(),
              }),
            );
            return buildEnvelope({
              success: true,
              summary: `Fetched Lark approval instance ${asString(instance.title) ?? asString(instance.instanceCode) ?? 'instance'}.`,
              keyData: { instance },
              fullPayload: { instance },
            });
          }
          if (input.operation === 'listInstances') {
            try {
              const result = await withLarkTenantFallback(runtime, (auth) =>
                approvalsService.listInstances({
                  ...auth,
                  approvalCode: input.approvalCode?.trim() || defaults?.defaultApprovalCode,
                  status: input.status,
                  pageSize: input.pageSize,
                }),
              );
              return buildEnvelope({
                success: true,
                summary:
                  result.items.length > 0
                    ? `Found ${result.items.length} Lark approval instance(s).`
                    : 'No Lark approval instances matched the request.',
                keyData: { items: result.items },
                fullPayload: result as unknown as Record<string, unknown>,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Lark approval list failed';
              if (message.toLowerCase().includes('field validation failed')) {
                logger.warn('vercel.lark.approval.list.degraded', {
                  executionId: runtime.executionId,
                  threadId: runtime.threadId,
                  companyId: runtime.companyId,
                  userId: runtime.userId,
                  approvalCode: input.approvalCode?.trim() || defaults?.defaultApprovalCode || null,
                  status: input.status ?? null,
                  error: message,
                });
                return buildEnvelope({
                  success: true,
                  summary:
                    'Approval-instance data is unavailable for this workspace configuration. Continue with the digest using the remaining sources and mention that approval-risk context is limited.',
                  keyData: { items: [] },
                  fullPayload: {
                    items: [],
                    degraded: true,
                    reason: 'approval_list_validation_failed',
                  },
                });
              }
              throw error;
            }
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
          const instance = await withLarkTenantFallback(runtime, (auth) =>
            approvalsService.createInstance({
              ...auth,
              body: {
                ...body,
                ...(input.approvalCode?.trim() || defaults?.defaultApprovalCode
                  ? { approval_code: input.approvalCode?.trim() || defaults?.defaultApprovalCode }
                  : {}),
              },
            }),
          );
          return buildEnvelope({
            success: true,
            summary: `Created Lark approval instance ${asString(instance.title) ?? asString(instance.instanceCode) ?? 'instance'}.`,
            keyData: { instance },
            fullPayload: { instance },
          });
        }),
    }),

    larkBase: tool({
      description:
        'Comprehensive Lark Base tool for structured company tables and records in Lark Base (Bitable). Use this for Base apps/tables/records, not for personal memory or general chat recall.',
      inputSchema: z.object({
        operation: z.enum([
          'listApps',
          'listTables',
          'listViews',
          'listFields',
          'listRecords',
          'getRecord',
          'createRecord',
          'updateRecord',
          'deleteRecord',
        ]),
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
      execute: async (input) =>
        withLifecycle(hooks, 'larkBase', 'Running Lark Base workflow', async () => {
          const defaults = await getLarkDefaults(runtime);
          const appToken = input.appToken?.trim() || defaults?.defaultBaseAppToken;
          const tableId = input.tableId?.trim() || defaults?.defaultBaseTableId;
          const viewId = input.viewId?.trim() || defaults?.defaultBaseViewId;
          const baseService = loadLarkBaseService();
          const LarkRuntimeClientError = loadLarkRuntimeClientError();
          const baseConfigHint = [
            'If this keeps failing, check Company Admin -> Lark operational config for default Base app/table/view ids and verify the connected Lark app has Base permissions.',
            appToken
              ? `Current app token: ${appToken}.`
              : 'No Base app token is currently resolved.',
            tableId ? `Current table id: ${tableId}.` : 'No Base table id is currently resolved.',
            viewId ? `Current view id: ${viewId}.` : undefined,
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join(' ');
          const runWithLarkBaseAuth = <T>(
            run: (auth: Record<string, unknown>) => Promise<T>,
          ): Promise<T> => withLarkTenantFallback(runtime, run);

          try {
            if (input.operation === 'listApps') {
              const candidateTokens = Array.from(
                new Set(
                  [input.appToken?.trim(), defaults?.defaultBaseAppToken].filter(
                    (value): value is string => Boolean(value),
                  ),
                ),
              );
              if (candidateTokens.length === 0) {
                return buildEnvelope({
                  success: false,
                  summary:
                    'Automatic Lark Base app discovery is not available in this runtime. Provide appToken or configure a default Base app token in Company Admin.',
                  errorKind: 'missing_input',
                  retryable: false,
                });
              }
              const items = candidateTokens.map((token, index) => ({
                appToken: token,
                name:
                  index === 0 && token === defaults?.defaultBaseAppToken
                    ? 'Configured default Lark Base app'
                    : 'Provided Lark Base app',
                raw: { app_token: token },
              }));
              return buildEnvelope({
                success: true,
                summary: `Resolved ${items.length} Lark Base app token(s) from configured defaults or provided input.`,
                keyData: { items },
                fullPayload: { items },
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
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listTables({
                  ...auth,
                  appToken,
                  pageSize: 50,
                }),
              );
              return buildEnvelope({
                success: true,
                summary:
                  result.items.length > 0
                    ? `Found ${result.items.length} Lark Base table(s).`
                    : 'No Lark Base tables were found.',
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
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listViews({
                  ...auth,
                  appToken,
                  tableId,
                  pageSize: 50,
                }),
              );
              return buildEnvelope({
                success: true,
                summary:
                  result.items.length > 0
                    ? `Found ${result.items.length} Lark Base view(s).`
                    : 'No Lark Base views were found.',
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
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listFields({
                  ...auth,
                  appToken,
                  tableId,
                  pageSize: 200,
                }),
              );
              const filteredItems =
                input.fieldNames && input.fieldNames.length > 0
                  ? result.items.filter((item) =>
                      input.fieldNames?.some(
                        (fieldName) =>
                          (asString(item.fieldName) ?? '').toLowerCase() ===
                          fieldName.toLowerCase(),
                      ),
                    )
                  : result.items;
              return buildEnvelope({
                success: true,
                summary:
                  filteredItems.length > 0
                    ? `Found ${filteredItems.length} Lark Base field(s).`
                    : 'No Lark Base fields matched the request.',
                keyData: { app: { appToken }, table: { tableId }, items: filteredItems },
                fullPayload: { ...result, items: filteredItems },
              });
            }

            if (input.operation === 'getRecord') {
              if (!appToken || !tableId || !input.recordId?.trim()) {
                return buildEnvelope({
                  success: false,
                  summary:
                    'getRecord requires appToken, tableId, and recordId, or configured app/table defaults.',
                  errorKind: 'missing_input',
                });
              }
              const record = await runWithLarkBaseAuth((auth) =>
                baseService.getRecord({
                  ...auth,
                  appToken,
                  tableId,
                  recordId: input.recordId.trim(),
                }),
              );
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
                  summary:
                    'deleteRecord requires appToken, tableId, and recordId, or configured app/table defaults.',
                  errorKind: 'missing_input',
                });
              }
              await runWithLarkBaseAuth((auth) =>
                baseService.deleteRecord({
                  ...auth,
                  appToken,
                  tableId,
                  recordId: input.recordId.trim(),
                }),
              );
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
              const result = await runWithLarkBaseAuth((auth) =>
                baseService.listRecords({
                  ...auth,
                  appToken,
                  tableId,
                  viewId,
                  pageSize: 50,
                }),
              );
              const normalizedQuery = input.query?.trim().toLowerCase();
              const items = normalizedQuery
                ? result.items.filter((item) =>
                    `${asString(item.recordId) ?? ''} ${JSON.stringify(asRecord(item.fields) ?? {})}`
                      .toLowerCase()
                      .includes(normalizedQuery),
                  )
                : result.items;
              return buildEnvelope({
                success: true,
                summary:
                  items.length > 0
                    ? `Found ${items.length} Lark Base record(s).`
                    : 'No Lark Base records matched the request.',
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
            const record =
              input.operation === 'createRecord'
                ? await runWithLarkBaseAuth((auth) =>
                    baseService.createRecord({
                      ...auth,
                      appToken,
                      tableId,
                      fields: input.fields,
                    }),
                  )
                : await runWithLarkBaseAuth((auth) =>
                    baseService.updateRecord({
                      ...auth,
                      appToken,
                      tableId,
                      recordId: input.recordId?.trim() ?? '',
                      fields: input.fields,
                    }),
                  );
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
          } catch (error) {
            const summary =
              input.operation === 'listApps'
                ? 'Automatic Lark Base app discovery is not available in this runtime. Provide appToken or configure a default Base app token in Company Admin.'
                : error instanceof LarkRuntimeClientError
                  ? `Lark Base ${input.operation} failed: ${error.message}. ${baseConfigHint}`
                  : `Lark Base ${input.operation} failed: ${error instanceof Error ? error.message : 'unknown error'}. ${baseConfigHint}`;
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: false,
            });
          }
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
      execute: async (input) =>
        withLifecycle(hooks, 'larkDoc', 'Running Lark Docs workflow', async () => {
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
                summary:
                  'No prior Lark Doc was found in this conversation. Please provide documentId.',
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
              summary:
                'No prior Lark Doc was found in this conversation. Please provide documentId.',
              errorKind: 'missing_input',
            });
          }
          try {
            const larkDocsService = loadLarkDocsService();
            const result =
              input.operation === 'read'
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
              summary:
                input.operation === 'read'
                  ? `Read Lark Doc ${documentId}.`
                  : `Inspected Lark Doc ${documentId}.`,
              keyData: {
                documentId,
                docUrl: asString(result.url),
                blockCount: typeof result.blockCount === 'number' ? result.blockCount : undefined,
                headings: asArray(result.headings).filter(
                  (value): value is string => typeof value === 'string',
                ),
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
      description:
        'Comprehensive Zoho CRM tool for context search, grounded reads, field metadata, attachment content reads, and approval-gated mutations.',
      inputSchema: z.object({
        operation: z.enum([
          'searchContext',
          'readRecords',
          'summarizePipeline',
          'getRecord',
          'listNotes',
          'getNote',
          'listAttachments',
          'getAttachmentContent',
          'listFields',
          'createRecord',
          'updateRecord',
          'deleteRecord',
          'createNote',
          'updateNote',
          'deleteNote',
          'uploadAttachment',
          'deleteAttachment',
        ]),
        query: z.string().optional(),
        module: z.string().optional(),
        recordId: z.string().optional(),
        noteId: z.string().optional(),
        attachmentId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
        fields: z.record(z.unknown()).optional(),
        trigger: z.array(z.string()).optional(),
        fileName: z.string().optional(),
        contentType: z.string().optional(),
        contentBase64: z.string().optional(),
        attachmentUrl: z.string().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'zoho', 'Running Zoho workflow', async () => {
          const readPermissionError = ensureAnyActionPermission(
            runtime,
            ['search-zoho-context', 'read-zoho-records', 'zoho-agent', 'zoho-read'],
            'read',
            'zoho',
          );
          const sourceType = normalizeZohoSourceType(input.module);
          const crmModuleName = normalizeZohoCrmModuleName(input.module);

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
              const zohoGateway = loadZohoGatewayService();
              const requester = buildZohoGatewayRequester(runtime);
              const modules = crmModuleName
                ? [crmModuleName]
                : ['Leads', 'Contacts', 'Accounts', 'Deals', 'Cases'];
              const normalizedMatches: Array<{
                type?: string;
                id?: string;
                score?: number;
                data: Record<string, unknown>;
              }> = [];
              let denialReason: string | undefined;

              for (const moduleName of modules) {
                const auth =
                  asRecord(
                    await zohoGateway.listAuthorizedRecords({
                      domain: 'crm',
                      module: moduleName,
                      requester,
                      filters: input.filters,
                      query: input.query.trim(),
                      limit: 5,
                    }),
                  ) ?? {};
                if (auth.allowed !== true) {
                  denialReason = asString(auth.denialReason) ?? denialReason;
                  continue;
                }
                const records = asArray(asRecord(auth.payload)?.records)
                  .map((entry) => asRecord(entry))
                  .filter((entry): entry is Record<string, unknown> => Boolean(entry));
                for (const record of records) {
                  normalizedMatches.push({
                    type: moduleName,
                    id: asString(record.id),
                    data: record,
                  });
                  if (normalizedMatches.length >= 5) {
                    break;
                  }
                }
                if (normalizedMatches.length >= 5) {
                  break;
                }
              }
              if (normalizedMatches.length === 0 && denialReason) {
                return buildZohoGatewayDeniedEnvelope(
                  { denialReason },
                  'You are not allowed to search Zoho CRM records.',
                );
              }
              const citations = normalizedMatches.flatMap((entry, index) => {
                const sourceType = entry.type;
                const sourceId = entry.id;
                if (!sourceType || !sourceId) return [];
                return [
                  {
                    id: `zoho-${index + 1}`,
                    title: `${sourceType}:${sourceId}`,
                    kind: 'record',
                    sourceType,
                    sourceId,
                  },
                ];
              });
              return buildEnvelope({
                success: true,
                summary:
                  normalizedMatches.length > 0
                    ? `Found ${normalizedMatches.length} relevant Zoho record(s).`
                    : 'No Zoho records matched the context search.',
                keyData: {
                  recordId: normalizedMatches[0]?.id,
                  recordType: normalizedMatches[0]?.type ?? input.module,
                },
                fullPayload: {
                  records: normalizedMatches,
                },
                citations,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Zoho context search failed.';
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
            if (!crmModuleName || !input.recordId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getRecord requires module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedRecord({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access Zoho ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho ${input.module?.trim() ?? 'record'} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  recordType: sourceType ?? crmModuleName,
                },
                fullPayload: {
                  record: asRecord(auth.payload) ?? {},
                },
                citations: [
                  {
                    id: `zoho-record-${input.recordId.trim()}`,
                    title: `${sourceType ?? crmModuleName}:${input.recordId.trim()}`,
                    kind: 'record',
                    sourceType: sourceType ?? crmModuleName,
                    sourceId: input.recordId.trim(),
                  },
                ],
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho record.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listNotes') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'listNotes requires module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedChildResource({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    childType: 'notes',
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access notes for ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              const notes = sourceType
                ? ((await loadZohoDataClient().listNotes?.({
                    companyId: runtime.companyId,
                    sourceType,
                    sourceId: input.recordId.trim(),
                  })) ?? [])
                : await loadZohoDataClient().listModuleNotes({
                    companyId: runtime.companyId,
                    moduleName: crmModuleName,
                    recordId: input.recordId.trim(),
                  });
              return buildEnvelope({
                success: true,
                summary:
                  notes.length > 0
                    ? `Found ${notes.length} Zoho note(s) for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`
                    : `No Zoho notes were found for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  noteCount: notes.length,
                  recordType: sourceType ?? crmModuleName,
                },
                fullPayload: {
                  notes,
                },
              });
            } catch (error) {
              const summary = error instanceof Error ? error.message : 'Failed to list Zoho notes.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getNote') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!input.noteId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getNote requires noteId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyId = await loadCompanyContextResolver().resolveCompanyId({
              companyId: runtime.companyId,
              larkTenantKey: runtime.larkTenantKey,
            });
            if (runtime.departmentZohoReadScope !== 'show_all') {
              return buildEnvelope({
                success: false,
                summary: 'getNote requires company-scoped Zoho CRM access.',
                errorKind: 'permission',
                retryable: false,
              });
            }
            try {
              const note = await loadZohoDataClient().getNote?.({
                companyId: runtime.companyId,
                noteId: input.noteId.trim(),
              });
              if (!note) {
                return buildEnvelope({
                  success: false,
                  summary: `No Zoho note was found for ${input.noteId.trim()}.`,
                  errorKind: 'validation',
                  retryable: false,
                });
              }
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho note ${input.noteId.trim()}.`,
                keyData: {
                  noteId: input.noteId.trim(),
                },
                fullPayload: {
                  note,
                },
              });
            } catch (error) {
              const summary = error instanceof Error ? error.message : 'Failed to fetch Zoho note.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listAttachments') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'listAttachments requires module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedChildResource({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    childType: 'attachments',
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access attachments for ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              const attachments = sourceType
                ? ((await loadZohoDataClient().listAttachments?.({
                    companyId: runtime.companyId,
                    sourceType,
                    sourceId: input.recordId.trim(),
                  })) ?? [])
                : await loadZohoDataClient().listModuleAttachments({
                    companyId: runtime.companyId,
                    moduleName: crmModuleName,
                    recordId: input.recordId.trim(),
                  });
              return buildEnvelope({
                success: true,
                summary:
                  attachments.length > 0
                    ? `Found ${attachments.length} Zoho attachment(s) for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`
                    : `No Zoho attachments were found for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  attachmentCount: attachments.length,
                  recordType: sourceType ?? crmModuleName,
                },
                fullPayload: {
                  attachments,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to list Zoho attachments.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getAttachmentContent') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim() || !input.attachmentId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getAttachmentContent requires module, recordId, and attachmentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedChildResource({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    childType: 'attachment_content',
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access attachment content for ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              const attachment = sourceType
                ? ((await loadZohoDataClient().getAttachmentContent?.({
                    companyId: runtime.companyId,
                    sourceType,
                    sourceId: input.recordId.trim(),
                    attachmentId: input.attachmentId.trim(),
                  })) ?? {})
                : ((await loadZohoDataClient().getModuleAttachmentContent?.({
                    companyId: runtime.companyId,
                    moduleName: crmModuleName,
                    recordId: input.recordId.trim(),
                    attachmentId: input.attachmentId.trim(),
                  })) ?? {});
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho attachment content ${input.attachmentId.trim()} for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  attachmentId: input.attachmentId.trim(),
                  recordType: sourceType ?? crmModuleName,
                  sizeBytes: asNumber(asRecord(attachment)?.sizeBytes),
                  contentType: asString(asRecord(attachment)?.contentType),
                },
                fullPayload: attachment,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho attachment content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listFields') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName) {
              return buildEnvelope({
                success: false,
                summary: 'listFields requires a supported Zoho CRM module.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const fields =
                (await loadZohoDataClient().listModuleFields?.({
                  companyId: runtime.companyId,
                  moduleName: crmModuleName,
                })) ?? [];
              return buildEnvelope({
                success: true,
                summary:
                  fields.length > 0
                    ? `Fetched ${fields.length} Zoho field definition(s) for ${crmModuleName}.`
                    : `No Zoho field definitions were returned for ${crmModuleName}.`,
                keyData: {
                  module: crmModuleName,
                  fieldCount: fields.length,
                },
                fullPayload: {
                  module: crmModuleName,
                  fields,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho field metadata.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'readRecords' || input.operation === 'summarizePipeline') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName) {
              return buildEnvelope({
                success: false,
                summary: 'readRecords requires a supported Zoho CRM module.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().listAuthorizedRecords({
                    domain: 'crm',
                    module: crmModuleName,
                    requester: buildZohoGatewayRequester(runtime),
                    filters: input.filters,
                    query: input.query?.trim(),
                    limit: 50,
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to read Zoho ${crmModuleName}.`,
                );
              }
              const filtered = asArray(asRecord(auth.payload)?.records)
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry));
              if (input.operation === 'summarizePipeline') {
                const statusCounts = filtered.reduce<Record<string, number>>((acc, record) => {
                  const status =
                    asString(record.Stage) ??
                    asString(record.stage) ??
                    asString(record.Status) ??
                    asString(record.status) ??
                    'unknown';
                  acc[status] = (acc[status] ?? 0) + 1;
                  return acc;
                }, {});
                return buildEnvelope({
                  success: true,
                  summary:
                    filtered.length > 0
                      ? `Summarized ${filtered.length} Zoho ${crmModuleName} record(s).`
                      : `No Zoho ${crmModuleName} records matched the current filters.`,
                  keyData: {
                    module: crmModuleName,
                    recordCount: filtered.length,
                    statusCounts,
                  },
                  fullPayload: {
                    module: crmModuleName,
                    statusCounts,
                    records: filtered,
                  },
                });
              }
              return buildEnvelope({
                success: true,
                summary:
                  filtered.length > 0
                    ? `Found ${filtered.length} Zoho ${crmModuleName} record(s).`
                    : `No Zoho ${crmModuleName} records matched the current filters.`,
                keyData: {
                  module: crmModuleName,
                  recordCount: filtered.length,
                },
                fullPayload: {
                  module: crmModuleName,
                  records: filtered,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : `Failed to read Zoho ${crmModuleName} records.`;
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (
            input.operation === 'createRecord' ||
            input.operation === 'updateRecord' ||
            input.operation === 'deleteRecord' ||
            input.operation === 'createNote' ||
            input.operation === 'updateNote' ||
            input.operation === 'deleteNote' ||
            input.operation === 'uploadAttachment' ||
            input.operation === 'deleteAttachment'
          ) {
            const actionGroup: ToolActionGroup =
              input.operation === 'createRecord' ||
              input.operation === 'createNote' ||
              input.operation === 'uploadAttachment'
                ? 'create'
                : input.operation === 'updateRecord' || input.operation === 'updateNote'
                  ? 'update'
                  : 'delete';
            const permissionError = ensureAnyActionPermission(
              runtime,
              ['zoho-write', 'zoho-agent'],
              actionGroup,
              'zoho',
            );
            if (permissionError) {
              return permissionError;
            }
            if (
              (input.operation === 'createRecord' ||
                input.operation === 'updateRecord' ||
                input.operation === 'deleteRecord' ||
                input.operation === 'createNote' ||
                input.operation === 'uploadAttachment' ||
                input.operation === 'deleteAttachment') &&
              !crmModuleName
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires a supported Zoho CRM module such as Leads, Contacts, Accounts, Deals, Cases, Tasks, Events, Calls, Products, Quotes, or Sales_Orders.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'updateRecord' ||
                input.operation === 'deleteRecord' ||
                input.operation === 'createNote' ||
                input.operation === 'uploadAttachment' ||
                input.operation === 'deleteAttachment') &&
              !input.recordId?.trim()
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires recordId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'createRecord' ||
                input.operation === 'updateRecord' ||
                input.operation === 'createNote' ||
                input.operation === 'updateNote') &&
              !input.fields
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires fields.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'updateNote' || input.operation === 'deleteNote') &&
              !input.noteId?.trim()
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires noteId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (input.operation === 'deleteAttachment' && !input.attachmentId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'deleteAttachment requires attachmentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              input.operation === 'uploadAttachment' &&
              !input.attachmentUrl?.trim() &&
              (!input.fileName?.trim() || !input.contentBase64?.trim())
            ) {
              return buildEnvelope({
                success: false,
                summary:
                  'uploadAttachment requires either attachmentUrl or both fileName and contentBase64.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const crmMutationAuth =
              asRecord(
                await loadZohoGatewayService().executeAuthorizedMutation({
                  ...buildCrmMutationAuthorizationTarget({
                    operation: input.operation,
                    moduleName: crmModuleName,
                    recordId: input.recordId?.trim(),
                  }),
                  requester: buildZohoGatewayRequester(runtime),
                }),
              ) ?? {};
            if (crmMutationAuth.allowed !== true) {
              return buildZohoGatewayDeniedEnvelope(
                crmMutationAuth,
                `You are not allowed to mutate Zoho ${crmModuleName ?? input.module?.trim() ?? input.operation}.`,
              );
            }
            const subject =
              input.operation === 'createRecord'
                ? `Create Zoho ${input.module?.trim() ?? sourceType}`
                : input.operation === 'updateRecord'
                  ? `Update Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                  : input.operation === 'deleteRecord'
                    ? `Delete Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                    : input.operation === 'createNote'
                      ? `Create Zoho note on ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                      : input.operation === 'updateNote'
                        ? `Update Zoho note ${input.noteId?.trim() ?? ''}`.trim()
                        : input.operation === 'deleteNote'
                          ? `Delete Zoho note ${input.noteId?.trim() ?? ''}`.trim()
                          : input.operation === 'uploadAttachment'
                            ? `Upload Zoho attachment to ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                            : `Delete Zoho attachment ${input.attachmentId?.trim() ?? ''}`.trim();
            const summary =
              input.operation === 'createRecord'
                ? `Approval required to create a Zoho ${input.module?.trim() ?? sourceType}.`
                : input.operation === 'updateRecord'
                  ? `Approval required to update Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                  : input.operation === 'deleteRecord'
                    ? `Approval required to delete Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                    : input.operation === 'createNote'
                      ? `Approval required to create a Zoho note on ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                      : input.operation === 'updateNote'
                        ? `Approval required to update Zoho note ${input.noteId?.trim() ?? ''}.`.trim()
                        : input.operation === 'deleteNote'
                          ? `Approval required to delete Zoho note ${input.noteId?.trim() ?? ''}.`.trim()
                          : input.operation === 'uploadAttachment'
                            ? `Approval required to upload an attachment to Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                            : `Approval required to delete Zoho attachment ${input.attachmentId?.trim() ?? ''} from ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim();
            return createPendingRemoteApproval({
              runtime,
              toolId: 'zoho-write',
              actionGroup,
              operation: input.operation,
              summary,
              subject,
              explanation:
                'Zoho CRM mutations are approval-gated. Review the module, record target, and field payload before proceeding.',
              payload: {
                operation: input.operation,
                module: input.module?.trim(),
                sourceType,
                recordId: input.recordId?.trim(),
                noteId: input.noteId?.trim(),
                attachmentId: input.attachmentId?.trim(),
                fields: input.fields,
                trigger: input.trigger,
                fileName: input.fileName?.trim(),
                contentType: input.contentType?.trim(),
                contentBase64: input.contentBase64?.trim(),
                attachmentUrl: input.attachmentUrl?.trim(),
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
          const sourceRefs = asArray(result?.sourceRefs)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          const citations = sourceRefs.flatMap((entry, index) => {
            const id = asString(entry.id);
            if (!id) return [];
            const [sourceType, rest] = id.split(':', 2);
            return [
              {
                id: `zoho-read-${index + 1}`,
                title: id,
                kind: 'record',
                sourceType,
                sourceId: rest ?? id,
              },
            ];
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
      execute: async (input) =>
        withLifecycle(hooks, 'outreach', 'Running Outreach workflow', async () => {
          if (input.operation === 'getCampaign') {
            return buildEnvelope({
              success: false,
              summary:
                'Outreach campaign lookup is not implemented in the current outreach integration. Use searchPublishers or summarizeInventory instead.',
              errorKind: 'unsupported',
              retryable: false,
            });
          }
          const agentResult = await loadOutreachReadAgent().invoke(
            buildAgentInvokeInput(runtime, 'outreach-read', input.query, {
              filters: input.filters,
              rawFilterString:
                typeof input.filters?.rawFilterString === 'string'
                  ? input.filters.rawFilterString
                  : undefined,
            }),
          );
          const result = asRecord(asRecord(agentResult)?.result);
          const records = asArray(result?.records)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          const citations = records.flatMap((entry, index) => {
            const website = asString(entry.website);
            const id = asString(entry.id) ?? website;
            if (!id) return [];
            return [
              {
                id: `outreach-${index + 1}`,
                title: website ?? id,
                url: website ? `https://${website.replace(/^https?:\/\//i, '')}` : undefined,
                kind: 'record',
                sourceType: 'outreach',
                sourceId: id,
              },
            ];
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

  const filteredEntries = Object.entries(tools).filter(([toolName]) =>
    isVercelToolAllowed(runtime, toolName),
  );

  logger.info('vercel.tools.filtered', {
    threadId: runtime.threadId,
    executionId: runtime.executionId,
    requesterAiRole: runtime.requesterAiRole,
    allowedToolIds: runtime.allowedToolIds,
    runExposedToolIds: runtime.runExposedToolIds ?? runtime.allowedToolIds,
    plannerCandidateToolIds: runtime.plannerCandidateToolIds ?? [],
    plannerChosenToolId: runtime.plannerChosenToolId ?? null,
    plannerChosenOperationClass: runtime.plannerChosenOperationClass ?? null,
    toolSelectionReason: runtime.toolSelectionReason ?? null,
    exposedTools: filteredEntries.map(([toolName]) => toolName),
  });

  return Object.fromEntries(filteredEntries);
};

export type VercelDesktopTools = Record<string, any>;
