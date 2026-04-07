import path from 'path';

import type { MemberSessionDTO } from '../../../modules/member-auth/member-auth.service';

export type LarkOperationalConfigLike = {
  findByCompanyId: (companyId: string) => Promise<{
    defaultBaseAppToken?: string;
    defaultBaseTableId?: string;
    defaultBaseViewId?: string;
    defaultTasklistId?: string;
    defaultCalendarId?: string;
    defaultApprovalCode?: string;
  } | null>;
};

const resolveModulePath = (modulePath: string): string => path.resolve(__dirname, modulePath);

export const loadModuleExport = <T>(modulePath: string, exportName: string): T => {
  const moduleRecord = require(resolveModulePath(modulePath)) as Record<string, unknown>;
  return moduleRecord[exportName] as T;
};

export const loadLarkDocsService = (): {
  createMarkdownDoc: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  editMarkdownDoc: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  inspectDocument: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readDocument: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-docs.service', 'larkDocsService');

export const loadLarkTasksService = (): {
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

export const loadLarkCalendarService = (): {
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

export const loadLarkMeetingsService = (): {
  listMeetings: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getMeeting: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-meetings.service', 'larkMeetingsService');

export const loadLarkMinutesService = (): {
  getMinute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-minutes.service', 'larkMinutesService');

export const loadLarkApprovalsService = (): {
  listInstances: (
    input: Record<string, unknown>,
  ) => Promise<{ items: Array<Record<string, unknown>>; pageToken?: string; hasMore: boolean }>;
  getInstance: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createInstance: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-approvals.service', 'larkApprovalsService');

export const loadLarkMessagingService = (): {
  sendDirectTextMessage: (input: {
    companyId?: string;
    larkTenantKey?: string;
    appUserId?: string;
    credentialMode?: 'tenant' | 'user_linked';
    recipientOpenId: string;
    text: string;
  }) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../channels/lark/lark-messaging.service', 'larkMessagingService');

export const loadLarkBaseService = (): {
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

export const loadLarkOperationalConfigRepository = (): LarkOperationalConfigLike =>
  loadModuleExport<LarkOperationalConfigLike>(
    '../../channels/lark/lark-operational-config.repository',
    'larkOperationalConfigRepository',
  );

export const loadLarkRuntimeClientError = (): { new (...args: any[]): Error } =>
  loadModuleExport('../../channels/lark/lark-runtime-client', 'LarkRuntimeClientError');

export const loadResolveLarkTaskAssignees = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) => loadModuleExport('./lark-helpers', 'resolveLarkTaskAssignees');

export const loadListLarkTaskAssignablePeople = (): ((
  input: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>) =>
  loadModuleExport('./lark-helpers', 'listLarkTaskAssignablePeople');

export const loadCanonicalizeLarkPersonIds = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  resolvedIds: string[];
  unresolvedIds: string[];
  ambiguousIds: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) => loadModuleExport('./lark-helpers', 'canonicalizeLarkPersonIds');

export const loadResolveLarkPeople = (): ((input: Record<string, unknown>) => Promise<{
  people: Array<Record<string, unknown>>;
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: Array<Record<string, unknown>> }>;
}>) => loadModuleExport('./lark-helpers', 'resolveLarkPeople');

export const loadListLarkPeople = (): ((
  input: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>) =>
  loadModuleExport('./lark-helpers', 'listLarkPeople');

export const loadNormalizeLarkTimestamp = (): ((
  value?: string,
  timeZone?: string,
) => string | undefined) => loadModuleExport('./lark-helpers', 'normalizeLarkTimestamp');

export const loadWebSearchService = (): {
  search: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/search/web-search.service', 'webSearchService');

export const loadChannelIdentityRepository = (): {
  searchLarkContacts: (input: {
    companyId: string;
    query: string;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../channels/channel-identity.repository', 'channelIdentityRepository');

export const loadSearchIntegrationError = (): { new (...args: any[]): Error } =>
  loadModuleExport('../../integrations/search/web-search.service', 'SearchIntegrationError');

export const loadFileUploadService = (): {
  listVisibleFiles: (input: {
    companyId: string;
    requesterUserId: string;
    requesterChannelIdentityId?: string;
    requesterAiRole: string;
    requesterEmail?: string;
    isAdmin?: boolean;
  }) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../../modules/file-upload/file-upload.service', 'fileUploadService');

export const loadOutboundArtifactService = (): {
  materializeFromUploadedFile: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  materializeFromZohoBooksDocument: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getArtifactForSend: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../artifacts/outbound-artifact.service', 'outboundArtifactService');

export const loadEmailComposeService = (): {
  composeEmail: (input: Record<string, unknown>) => Promise<{
    subject: string;
    body: string;
    isHtml: boolean;
    composedBy: 'model' | 'fallback';
  }>;
} => loadModuleExport('../email-compose.service', 'emailComposeService');

export const loadDesktopWorkflowsService = (): {
  createDraft: (
    session: MemberSessionDTO,
    input?: { name?: string | null; departmentId?: string | null; originChatId?: string | null },
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

export const loadWorkflowValidatorService = (): {
  validateDefinition: (input: Record<string, unknown>) => Record<string, unknown>;
} =>
  loadModuleExport(
    '../../scheduled-workflows/workflow-validator.service',
    'workflowValidatorService',
  );

export const loadWorkflowScheduleHelpers = (): {
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

export const loadDocumentTextHelpers = (): {
  extractTextFromBuffer: (buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
  normalizeExtractedText: (rawText: string, maxWords?: number) => string;
} =>
  require(resolveModulePath('../../../modules/file-upload/document-text-extractor')) as {
    extractTextFromBuffer: (buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
    normalizeExtractedText: (rawText: string, maxWords?: number) => string;
  };

export const loadFileRetrievalService = (): {
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

export const loadPersonalVectorMemoryService = (): {
  query: (input: {
    companyId: string;
    requesterUserId: string;
    text: string;
    limit?: number;
    conversationKey?: string;
  }) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../integrations/vector/personal-vector-memory.service', 'personalVectorMemoryService');

export const loadVectorDocumentRepository = (): {
  fetchChunkByKey: (input: {
    companyId: string;
    sourceType: string;
    sourceId: string;
    chunkIndex: number;
  }) => Promise<{
    text: string | null;
    createdAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    payload?: Record<string, unknown> | null;
  }>;
  findChunkByText: (input: {
    companyId: string;
    sourceType: string;
    sourceId: string;
    chunkText: string;
  }) => Promise<{
    chunkIndex: number;
    text: string | null;
    createdAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    payload?: Record<string, unknown> | null;
  } | null>;
} => loadModuleExport('../../integrations/vector/vector-document.repository', 'vectorDocumentRepository');

export const loadZohoReadAgent = (): {
  invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => new (loadModuleExport('../../agents/implementations/zoho-read.agent', 'ZohoReadAgent'))();

export const loadOutreachReadAgent = (): {
  invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} =>
  new (loadModuleExport('../../agents/implementations/outreach-read.agent', 'OutreachReadAgent'))();

export const loadCompanyContextResolver = (): {
  resolveCompanyId: (input?: { companyId?: unknown; larkTenantKey?: unknown }) => Promise<string>;
} => loadModuleExport('../../agents/support/company-context.resolver', 'companyContextResolver');

export const loadZohoRetrievalService = (): {
  query: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
} => loadModuleExport('../../agents/support/zoho-retrieval.service', 'zohoRetrievalService');

export const loadZohoDataClient = (): {
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

export const loadZohoBooksClient = (): {
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

export const loadZohoFinanceOpsService = (): {
  buildOverdueReport: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  mapCustomerPayments: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reconcileVendorStatement: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  reconcileBankClosing: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/zoho/zoho-finance-ops.service', 'zohoFinanceOpsService');

export const loadZohoGatewayService = (): {
  resolveScopeContext: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listAuthorizedRecords: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getAuthorizedRecord: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getAuthorizedChildResource: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  executeAuthorizedMutation: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
} => loadModuleExport('../../integrations/zoho/zoho-gateway.service', 'zohoGatewayService');
