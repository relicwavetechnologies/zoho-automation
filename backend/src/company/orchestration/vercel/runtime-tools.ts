import { randomUUID } from 'crypto';
import { tool } from 'ai';
import { ZodError, z } from 'zod';

import { contextSearchBrokerService } from '../../retrieval/context-search-broker.service';
import { type ToolActionGroup } from '../../tools/tool-action-groups';
import { toCanonicalToolId } from '../../tools/canonical-tool-id';
import type {
  PendingApprovalAction,
  VercelCitation,
  VercelRuntimeRequestContext,
  VercelRuntimeToolHooks,
  VercelToolEnvelope,
} from './types';
import { buildCompositeRuntimeTools } from './tools/families/composites.runtime';
import { buildContextSearchRuntimeTools } from './tools/families/context-search.runtime';
import { buildDocumentRuntimeTools } from './tools/families/documents.runtime';
import { buildGoogleRuntimeTools } from './tools/families/google.runtime';
import {
  buildRemoteLocalExecutionUnavailableEnvelope,
  getCodingActivityTitle,
  inspectWorkspace,
  readWorkspaceFiles,
  resolveWorkspacePath,
  summarizeActionResult,
  summarizeRemoteLocalAction,
} from './tools/families/coding.shared';
import {
  extractFileText,
  listVisibleRuntimeFiles,
  rankRuntimeFileMatches,
  resolveRuntimeFile,
} from './tools/families/files.shared';
import {
  fetchGoogleApiJsonWithRetry,
  fetchGoogleApiResponseWithRetry,
  normalizeGmailMessage,
  resolveGoogleAccess,
} from './tools/families/google.shared';
import {
  getLarkAuthInput,
  getLarkDefaults,
  getLarkTimeZone,
  withLarkTenantFallback,
} from './tools/families/lark-auth.shared';
import { buildLarkRuntimeTools } from './tools/families/lark.runtime';
import {
  buildLarkItemsEnvelope,
  LARK_LARGE_RESULT_THRESHOLD,
  projectLarkItem,
} from './tools/families/lark.shared';
import { buildOutreachRuntimeTools } from './tools/families/outreach.runtime';
import { buildRepoCodingRuntimeTools } from './tools/families/repo-coding.runtime';
import { buildWorkflowRuntimeTools } from './tools/families/workflow.runtime';
import { buildCanonicalRuntimeWrappers } from './tools/families/wrappers.runtime';
import { buildZohoBooksRuntimeTools } from './tools/families/zoho-books.runtime';
import { buildZohoCrmRuntimeTools } from './tools/families/zoho.runtime';
import {
  parseInvoiceDocument,
  parseStatementDocument,
} from './tools/families/documents.shared';
import {
  buildBooksMutationAuthorizationTarget,
  buildCrmMutationAuthorizationTarget,
  isZohoBooksContactStatementModuleAlias,
  normalizeZohoBooksModule,
  normalizeZohoCrmModuleName,
  normalizeZohoSourceType,
  resolvePendingBooksWriteBodyFromRuntime,
  resolveZohoBooksModuleFromRuntime,
  resolveZohoBooksModuleScopedExplicitRecordId,
  resolveZohoBooksRecordIdFromRuntime,
} from './tools/families/zoho.shared';
import { buildBooksReadRecordsEnvelope } from './tools/families/zoho-books.shared';
import type { MemberSessionDTO } from '../../../modules/member-auth/member-auth.service';
import { discoverRepositories, inspectRepository, retrieveRepositoryFile } from './repo-tool';
import { formatZohoGatewayDeniedMessage } from '../../integrations/zoho/zoho-gateway-denials';
import { redDebug } from '../../../utils/red-debug';
import { filterRuntimeToolMap } from './runtime-permissions';
import {
  buildBooksWriteRepairHints,
  buildWorkflowValidationRepairHints,
  createPendingDesktopRemoteApproval,
  createPendingRemoteApproval,
  ensureActionPermission,
  ensureAnyActionPermission,
  getAllowedActionGroups,
} from './runtime-approvals';
import {
  loadChannelIdentityRepository,
  loadCompanyContextResolver,
  loadDesktopWorkflowsService,
  loadDocumentTextHelpers,
  loadEmailComposeService,
  loadFileRetrievalService,
  loadFileUploadService,
  loadLarkApprovalsService,
  loadLarkBaseService,
  loadLarkCalendarService,
  loadLarkDocsService,
  loadLarkMeetingsService,
  loadLarkMessagingService,
  loadLarkMinutesService,
  loadLarkOperationalConfigRepository,
  loadLarkRuntimeClientError,
  loadLarkTasksService,
  loadListLarkPeople,
  loadListLarkTaskAssignablePeople,
  loadModuleExport,
  loadNormalizeLarkTimestamp,
  loadOutboundArtifactService,
  loadOutreachReadAgent,
  loadPersonalVectorMemoryService,
  loadResolveLarkPeople,
  loadResolveLarkTaskAssignees,
  loadSearchIntegrationError,
  loadVectorDocumentRepository,
  loadWebSearchService,
  loadWorkflowScheduleHelpers,
  loadWorkflowValidatorService,
  loadZohoBooksClient,
  loadZohoDataClient,
  loadZohoFinanceOpsService,
  loadZohoGatewayService,
  loadZohoReadAgent,
  loadZohoRetrievalService,
  loadCanonicalizeLarkPersonIds,
} from './runtime-loaders';
import type { RuntimeToolMap, RuntimeVercelToolFamilies } from './tools/contracts';

export {
  BOOKS_LARGE_RESULT_THRESHOLD,
  buildBooksReadRecordsEnvelope,
  projectRecord,
} from './tools/families/zoho-books.shared';

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
    kind: z.enum(['desktop_inbox', 'desktop_thread', 'lark_chat', 'lark_current_chat', 'lark_self_dm']),
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
  if (runtime.channel === 'lark') {
    return [
      {
        kind: 'lark_self_dm',
        label: 'My personal Lark DM',
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

const toWorkflowOutputConfig = (
  destinations: Array<z.infer<typeof workflowDestinationSchema>>,
  runtime: VercelRuntimeRequestContext,
) => {
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
    if (destination.kind === 'lark_current_chat') {
      return {
        id: 'lark_current_chat',
        kind: 'lark_current_chat' as const,
        label: destination.label || 'Current Lark chat',
      };
    }
    if (destination.kind === 'lark_self_dm') {
      return {
        id: 'lark_self_dm',
        kind: 'lark_self_dm' as const,
        label: destination.label || 'My personal Lark DM',
        openId: destination.value || runtime.larkOpenId || '',
        ...(runtime.larkTenantKey ? { tenantKey: runtime.larkTenantKey } : {}),
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

const workflowUsesCurrentLarkChat = (outputConfig: unknown): boolean =>
  asArray(asRecord(outputConfig)?.destinations)
    .map((entry) => asRecord(entry))
    .some((entry) => entry?.kind === 'lark_current_chat');

const resolveWorkflowOriginChatId = (input: {
  runtime: VercelRuntimeRequestContext;
  current?: Record<string, unknown> | null;
  outputConfig: ReturnType<typeof toWorkflowOutputConfig> | Record<string, unknown>;
  preferRuntimeForCurrentChat?: boolean;
}): string | null => {
  if (!workflowUsesCurrentLarkChat(input.outputConfig)) {
    return asString(input.current?.originChatId) ?? null;
  }
  const currentOriginChatId = asString(input.current?.originChatId) ?? null;
  if (input.preferRuntimeForCurrentChat) {
    return input.runtime.chatId ?? currentOriginChatId;
  }
  return currentOriginChatId ?? input.runtime.chatId ?? null;
};

const validateWorkflowSaveDestinations = (input: {
  outputConfig: ReturnType<typeof toWorkflowOutputConfig> | Record<string, unknown>;
  originChatId?: string | null;
}) => {
  const outputRecord = asRecord(input.outputConfig);
  const destinations = asArray(outputRecord?.destinations)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (destinations.length === 0) {
    return buildEnvelope({
      success: false,
      summary: 'Saving a workflow requires at least one delivery destination.',
      errorKind: 'missing_input',
      retryable: false,
      userAction: 'Ask the user where workflow results should be delivered before saving it.',
      missingFields: ['destinations'],
    });
  }
  if (
    destinations.some((destination) => destination.kind === 'lark_current_chat')
    && !(input.originChatId?.trim())
  ) {
    return buildEnvelope({
      success: false,
      summary: 'Saving this workflow needs the originating Lark chat so results can be sent back to the current chat.',
      errorKind: 'missing_input',
      retryable: false,
      userAction: 'Ask the user to save this workflow from the intended Lark chat or choose another delivery destination.',
      missingFields: ['originChatId'],
    });
  }
  if (
    destinations.some((destination) => destination.kind === 'lark_self_dm' && !asString(destination.openId))
  ) {
    return buildEnvelope({
      success: false,
      summary: 'Saving this workflow for your personal Lark DM requires the caller Lark identity.',
      errorKind: 'missing_input',
      retryable: false,
      userAction: 'Ask the user to retry this from their Lark account or choose another delivery destination.',
      missingFields: ['larkOpenId'],
    });
  }
  return null;
};

const humanizePollInterval = (pollIntervalMs: number): string => {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return 'a polling cycle';
  }
  const minutes = Math.max(1, Math.round(pollIntervalMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
  resolveByActionId: (actionId: string, decision: 'confirmed' | 'cancelled') => Promise<boolean>;
  getStoredAction: (actionId: string) => Promise<{
    actionId: string;
    toolId?: string;
    actionGroup?: ToolActionGroup;
    channel?: 'desktop' | 'lark';
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null>;
} => loadModuleExport('../../state/hitl/hitl-action.service', 'hitlActionService');

const loadExecuteStoredRemoteToolAction = (): ((action: {
  actionId: string;
  toolId?: string;
  actionGroup?: ToolActionGroup;
  channel?: 'desktop' | 'lark';
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) => Promise<{
  kind?: string;
  ok: boolean;
  summary: string;
  payload?: Record<string, unknown>;
}>) => loadModuleExport('../../state/hitl/hitl-remote-action.executor', 'executeStoredRemoteToolAction');

const loadDepartmentService = (): {
  resolveDepartmentApprover: (input: {
    companyId: string;
    departmentId?: string;
  }) => Promise<{
    userId: string;
    name?: string;
    email?: string;
    larkOpenId?: string;
  } | null>;
} => loadModuleExport('../../departments/department.service', 'departmentService');

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

const normalizeEmailHeaderField = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const emails = value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
    return emails.length > 0 ? emails.join(', ') : undefined;
  }
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

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

const inferErrorCode = (message: string): string => {
  if (/rate.?limit|429|quota/i.test(message)) return 'RATE_LIMITED';
  if (/unauthorized|401|invalid.?token|auth.*expired/i.test(message)) return 'AUTH_EXPIRED';
  if (/forbidden|403|permission/i.test(message)) return 'PERMISSION_DENIED';
  if (/timeout|ECONNRESET|ETIMEDOUT/i.test(message)) return 'NETWORK_TIMEOUT';
  if (/not.?found|404/i.test(message)) return 'NOT_FOUND';
  if (/conflict|409|already.?exists/i.test(message)) return 'CONFLICT';
  return 'UNKNOWN_API_ERROR';
};

const buildRepairHint = (errorCode: string, toolName: string, raw: string): string => {
  switch (errorCode) {
    case 'RATE_LIMITED':
      return `${toolName} hit a rate limit. Wait 10–30 seconds and retry.`;
    case 'AUTH_EXPIRED':
      return `${toolName} auth token expired. Re-authenticate or refresh credentials.`;
    case 'PERMISSION_DENIED':
      return `${toolName} was denied. Check the user has the required role or scope.`;
    case 'NETWORK_TIMEOUT':
      return `${toolName} timed out. Retry once; if it persists, check the external service.`;
    case 'NOT_FOUND':
      return `${toolName} could not find the requested record. Verify the ID and try a read first.`;
    case 'CONFLICT':
      return `${toolName} found a conflict. Confirm the current state before retrying.`;
    default:
      return `${toolName} failed with: ${raw.slice(0, 120)}`;
  }
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

const CONTEXT_SEARCH_SCOPE_VALUES = ['personal_history', 'files', 'zoho_crm', 'lark_contacts', 'all'] as const;
const CONTEXT_SEARCH_FETCH_SCOPES = ['personal_history', 'files', 'zoho_crm', 'lark_contacts'] as const;
type ContextSearchScope = (typeof CONTEXT_SEARCH_FETCH_SCOPES)[number];
const CONTEXT_SEARCH_SOURCE_KEYS = [
  'personalHistory',
  'files',
  'larkContacts',
  'zohoCrmContext',
  'zohoBooksLive',
  'workspace',
  'web',
  'skills',
] as const;

const ACTION_AGENT_IDS = new Set([
  'google-workspace-agent',
  'lark-ops-agent',
  'zoho-ops-agent',
  'workspace-agent',
]);

const queryExplicitlyNeedsConversationRecall = (query: string): boolean =>
  /\b(last time|previous|previously|earlier|remember|we discussed|we talked about|from this conversation|from earlier|prior attempt|that id|that email|that contact|that draft)\b/i.test(query);

const scopeContextSearchSourcesForAgent = (input: {
  runtime: VercelRuntimeRequestContext;
  query: string;
  sources?: Record<(typeof CONTEXT_SEARCH_SOURCE_KEYS)[number], boolean>;
}): Record<(typeof CONTEXT_SEARCH_SOURCE_KEYS)[number], boolean> | undefined => {
  if (!input.sources) {
    return input.sources;
  }
  if (!ACTION_AGENT_IDS.has(input.runtime.delegatedAgentId ?? '')) {
    return input.sources;
  }
  if (queryExplicitlyNeedsConversationRecall(input.query)) {
    return input.sources;
  }
  return {
    ...input.sources,
    personalHistory: false,
  };
};

const normalizeContextSearchSources = (input: {
  scopes?: Array<(typeof CONTEXT_SEARCH_SCOPE_VALUES)[number]>;
  sources?: Partial<Record<(typeof CONTEXT_SEARCH_SOURCE_KEYS)[number], boolean>>;
}): Record<(typeof CONTEXT_SEARCH_SOURCE_KEYS)[number], boolean> | undefined => {
  if (input.sources) {
    return {
      personalHistory: input.sources.personalHistory ?? true,
      files: input.sources.files ?? true,
      larkContacts: input.sources.larkContacts ?? true,
      zohoCrmContext: input.sources.zohoCrmContext ?? true,
      zohoBooksLive: input.sources.zohoBooksLive ?? false,
      workspace: input.sources.workspace ?? false,
      web: input.sources.web ?? false,
      skills: input.sources.skills ?? false,
    };
  }

  const requestedScopes = (input.scopes ?? ['all']).filter((scope) => scope !== 'all');
  if (requestedScopes.length === 0) {
    return undefined;
  }

  return {
    personalHistory: requestedScopes.includes('personal_history'),
    files: requestedScopes.includes('files'),
    larkContacts: requestedScopes.includes('lark_contacts'),
    zohoCrmContext: requestedScopes.includes('zoho_crm'),
    zohoBooksLive: false,
    workspace: false,
    web: false,
    skills: false,
  };
};

type ContextSearchNormalizedHit = {
  scope: ContextSearchScope;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  score: number;
  text: string;
  fileName?: string;
  documentClass?: string;
  role?: string;
  conversationKey?: string;
  displayName?: string;
  email?: string;
  createdAt?: string;
  sourceLabel?: string;
};

const formatContextSearchDate = (value?: string): string => {
  if (!value) return 'unknown date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown date';
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
};

const buildContextSearchSourceLabel = (hit: ContextSearchNormalizedHit): string => {
  switch (hit.scope) {
    case 'personal_history':
      return `Your past conversation · ${formatContextSearchDate(hit.createdAt)}`;
    case 'files':
      return `${hit.fileName ?? 'Document'} · ${hit.documentClass ?? 'file'} · ${formatContextSearchDate(hit.createdAt)}`;
    case 'zoho_crm':
      return `Zoho CRM · ${hit.sourceType ?? 'record'} · ${formatContextSearchDate(hit.createdAt)}`;
    case 'lark_contacts':
      return `Lark contact · ${hit.displayName ?? hit.email ?? hit.sourceId} · ${formatContextSearchDate(hit.createdAt)}`;
    default:
      return `Unknown source · ${formatContextSearchDate(hit.createdAt)}`;
  }
};

const buildContextSearchLarkContactText = (person: Record<string, unknown>): string => {
  const parts = uniqueDefinedStrings([
    asString(person.displayName),
    asString(person.email),
    asString(person.externalUserId),
    asString(person.larkOpenId),
    asString(person.larkUserId),
    asString(person.aiRole),
  ]);
  return parts.join('\n');
};

const parseContextSearchDate = (
  value: string | undefined,
  edge: 'start' | 'end',
): Date | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(Number.NaN);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (edge === 'start') {
      parsed.setUTCHours(0, 0, 0, 0);
    } else {
      parsed.setUTCHours(23, 59, 59, 999);
    }
  }
  return parsed;
};

const extractContextSearchTimestamp = (input: {
  createdAt?: Date | null;
  sourceUpdatedAt?: Date | null;
  payload?: Record<string, unknown> | null;
}): string | undefined => {
  if (input.sourceUpdatedAt instanceof Date && !Number.isNaN(input.sourceUpdatedAt.getTime())) {
    return input.sourceUpdatedAt.toISOString();
  }
  const payloadSourceUpdatedAt = asString(input.payload?.sourceUpdatedAt);
  if (payloadSourceUpdatedAt) {
    const parsed = new Date(payloadSourceUpdatedAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const payloadUpdatedAt = asString(input.payload?.updatedAt);
  if (payloadUpdatedAt) {
    const parsed = new Date(payloadUpdatedAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (input.createdAt instanceof Date && !Number.isNaN(input.createdAt.getTime())) {
    return input.createdAt.toISOString();
  }
  return undefined;
};

const contextSearchDateMatches = (
  timestampIso: string | undefined,
  dateFrom: Date | null,
  dateTo: Date | null,
): boolean => {
  if (!dateFrom && !dateTo) {
    return true;
  }
  if (!timestampIso) {
    return false;
  }
  const parsed = new Date(timestampIso);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  if (dateFrom && parsed < dateFrom) {
    return false;
  }
  if (dateTo && parsed > dateTo) {
    return false;
  }
  return true;
};

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
  toolId?: string;
  status?: VercelToolEnvelope['status'];
  data?: unknown;
  confirmedAction?: boolean;
  error?: string;
  success: boolean;
  summary: string;
  actionGroup?: ToolActionGroup;
  operation?: string;
  canonicalOperation?: CanonicalToolOperation;
  mutationResult?: MutationExecutionResult;
  keyData?: Record<string, unknown>;
  fullPayload?: Record<string, unknown>;
  citations?: VercelCitation[];
  errorKind?: VercelToolEnvelope['errorKind'];
  errorCode?: string;
  retryable?: boolean;
  userAction?: string;
  missingFields?: string[];
  repairHints?: Record<string, string>;
  pendingApprovalAction?: PendingApprovalAction;
}): VercelToolEnvelope => {
  const status =
    input.status
    ?? (input.pendingApprovalAction
      ? 'skipped'
      : input.success
        ? 'success'
        : /timeout|timed out/i.test(input.error ?? input.summary)
          ? 'timeout'
          : 'error');
  const data = input.data ?? input.fullPayload ?? input.keyData ?? null;
  const confirmedAction = input.confirmedAction ?? false;
  const error = input.error ?? (!input.success ? input.summary : undefined);

  return {
    toolId: input.toolId ?? 'unknown',
    status,
    data,
    confirmedAction,
    success: input.success,
    summary: input.summary,
    ...(input.actionGroup ? { actionGroup: input.actionGroup } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.canonicalOperation ? { canonicalOperation: input.canonicalOperation } : {}),
    ...(input.mutationResult ? { mutationResult: input.mutationResult } : {}),
    ...(input.keyData ? { keyData: input.keyData } : {}),
    ...(input.fullPayload ? { fullPayload: input.fullPayload } : {}),
    ...(input.citations && input.citations.length > 0 ? { citations: input.citations } : {}),
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    ...(error ? { error } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.userAction ? { userAction: input.userAction } : {}),
    ...(input.missingFields && input.missingFields.length > 0
      ? { missingFields: input.missingFields }
      : {}),
    ...(input.repairHints && Object.keys(input.repairHints).length > 0
      ? { repairHints: input.repairHints }
      : {}),
    ...(input.pendingApprovalAction ? { pendingApprovalAction: input.pendingApprovalAction } : {}),
  };
};


const buildZodBoundaryEnvelope = (
  error: ZodError,
  toolName: string,
): VercelToolEnvelope => {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    reason: issue.message,
  }));
  const missingFields = Array.from(new Set(
    issues
      .filter((issue) =>
        /required|invalid input|expected|received|type/i.test(issue.reason))
      .map((issue) => issue.field)
      .filter((field) => field.length > 0),
  ));
  return buildEnvelope({
    success: false,
    summary: `${toolName} received invalid input: ${issues.map((issue) => `${issue.field || '<root>'} — ${issue.reason}`).join('; ')}`,
    errorKind: 'validation',
    retryable: true,
    ...(missingFields.length > 0 ? { missingFields } : {}),
    userAction: missingFields.length > 0
      ? `Please provide: ${missingFields.join(', ')}`
      : 'Check the input format and try again.',
    repairHints: Object.fromEntries(
      issues
        .filter((issue) => issue.field.length > 0)
        .map((issue) => [issue.field, `Expected valid value for ${issue.field}: ${issue.reason}`]),
    ),
  });
};

const enrichApiFailureEnvelope = (
  envelope: VercelToolEnvelope,
  error: unknown,
  toolName: string,
): VercelToolEnvelope => {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = inferErrorCode(message);
  const repairHint = buildRepairHint(errorCode, toolName, message);
  return {
    ...envelope,
    errorCode,
    repairHints: {
      ...(envelope.repairHints ?? {}),
      _system: repairHint,
    },
  };
};

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
  departmentRoleId: runtime.departmentRoleId,
  departmentRoleSlug: runtime.departmentRoleSlug,
  requesterEmail: runtime.requesterEmail,
  requesterAiRole: runtime.requesterAiRole,
  departmentZohoReadScope: runtime.departmentZohoReadScope,
});

const withBooksReadAuthorizationRetry = async (
  runtime: VercelRuntimeRequestContext,
  attempt: (requester: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> => {
  return asRecord(await attempt(buildZohoGatewayRequester(runtime))) ?? {};
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

const isConfirmedActionGroup = (actionGroup?: string): boolean =>
  Boolean(actionGroup && actionGroup !== 'read');

const finalizeToolEnvelope = (
  toolName: string,
  output: VercelToolEnvelope,
): VercelToolEnvelope => {
  const actionGroup =
    output.actionGroup
    ?? (output.pendingApprovalAction?.kind === 'tool_action'
      ? output.pendingApprovalAction.actionGroup
      : undefined);
  const status =
    output.status
    ?? (output.pendingApprovalAction
      ? 'skipped'
      : output.success
        ? 'success'
        : /timeout|timed out/i.test(output.error ?? output.summary)
          ? 'timeout'
          : 'error');
  const confirmedAction =
    output.confirmedAction
    ?? output.mutationResult?.succeeded
    ?? Boolean(output.success && !output.pendingApprovalAction && isConfirmedActionGroup(actionGroup));

  return {
    ...output,
    toolId: output.toolId || toolName,
    status,
    data: output.data ?? output.fullPayload ?? output.keyData ?? null,
    confirmedAction,
    ...(actionGroup ? { actionGroup } : {}),
    ...(output.canonicalOperation ? { canonicalOperation: output.canonicalOperation } : {}),
    ...(output.mutationResult ? { mutationResult: output.mutationResult } : {}),
    ...(output.error || output.success ? {} : { error: output.summary }),
  };
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
    const output = finalizeToolEnvelope(toolName, await run());
    await hooks.onToolFinish(toolName, activityId, title, output);
    return output;
  } catch (error) {
    const summary = error instanceof Error ? error.message : 'Unknown tool error';
    const output = finalizeToolEnvelope(
      toolName,
      enrichApiFailureEnvelope(buildEnvelope({
        toolId: toolName,
        success: false,
        summary,
        errorKind: 'api_failure',
        retryable: true,
      }), error, toolName),
    );
    await hooks.onToolFinish(toolName, activityId, title, output);
    return output;
  }
};

const wrapToolDefinitionWithBoundaryNormalization = (
  toolName: string,
  toolDef: any,
): any => {
  if (!toolDef || typeof toolDef.execute !== 'function') {
    return toolDef;
  }
  const inputSchema = toolDef.inputSchema;
  if (!inputSchema || typeof inputSchema.safeParseAsync !== 'function') {
    return toolDef;
  }
  const originalExecute = toolDef.execute.bind(toolDef);
  return {
    ...toolDef,
    execute: async (args: unknown, context?: unknown) => {
      const parsed = await inputSchema.safeParseAsync(args);
      if (!parsed.success) {
        return buildZodBoundaryEnvelope(parsed.error, toolName);
      }
      try {
        return await originalExecute(parsed.data, context);
      } catch (error) {
        if (error instanceof ZodError) {
          return buildZodBoundaryEnvelope(error, toolName);
        }
        throw error;
      }
    },
  };
};


const pickRuntimeTools = (toolMap: RuntimeToolMap, toolNames: string[]): RuntimeToolMap =>
  Object.fromEntries(
    toolNames
      .map((toolName) => [toolName, toolMap[toolName]] as const)
      .filter(([, toolDef]) => Boolean(toolDef)),
  );

const flattenRuntimeToolFamilies = (families: RuntimeVercelToolFamilies): RuntimeToolMap => ({
  ...families.contextSearch,
  ...families.documents,
  ...families.workflowAuthoring,
  ...families.repoCoding,
  ...families.google,
  ...families.zohoBooks,
  ...families.larkTask,
  ...families.larkMessaging,
  ...families.larkCollab,
  ...families.zohoCrm,
  ...families.outreach,
  ...families.search,
});

const buildRuntimeToolInventory = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): RuntimeToolMap => {
  const tools = {
    ...buildContextSearchRuntimeTools(runtime, hooks, {
      buildEnvelope,
      withLifecycle,
      inferErrorKind,
      asRecord,
      asString,
      uniqueDefinedStrings,
      loadFileRetrievalService,
      parseContextSearchDate,
      normalizeContextSearchSources,
      scopeContextSearchSourcesForAgent,
      CONTEXT_SEARCH_SCOPE_VALUES,
    }),

    ...buildDocumentRuntimeTools(runtime, hooks, {
      buildEnvelope,
      withLifecycle,
      buildConversationKey,
      listVisibleRuntimeFiles: (runtimeInput: VercelRuntimeRequestContext) =>
        listVisibleRuntimeFiles(runtimeInput, {
          loadFileUploadService,
          asRecord,
          asString,
        }),
      rankRuntimeFileMatches,
      resolveRuntimeFile: (
        runtimeInput: VercelRuntimeRequestContext,
        input: { fileAssetId?: string; fileName?: string },
      ) =>
        resolveRuntimeFile(runtimeInput, input, {
          listVisibleRuntimeFiles: (innerRuntime) =>
            listVisibleRuntimeFiles(innerRuntime, {
              loadFileUploadService,
              asRecord,
              asString,
            }),
          buildConversationKey,
        }),
      loadOutboundArtifactService,
      extractFileText: (runtimeInput: VercelRuntimeRequestContext, file) =>
        extractFileText(runtimeInput, file, {
          loadFileRetrievalService,
          loadDocumentTextHelpers,
        }),
      asString,
      parseInvoiceDocument,
      parseStatementDocument,
    }),

    ...buildWorkflowRuntimeTools(runtime, hooks, {
      withLifecycle,
      buildEnvelope,
      ensureActionPermission: (
        runtimeInput: VercelRuntimeRequestContext,
        toolId: any,
        actionGroup: ToolActionGroup,
      ) => ensureActionPermission(runtimeInput, toolId, actionGroup, buildEnvelope),
      toCanonicalToolId,
      buildRuntimeWorkflowSession,
      loadDesktopWorkflowsService,
      buildRuntimeWorkflowDestinations,
      toWorkflowOutputConfig,
      resolveWorkflowOriginChatId,
      asString,
      asRecord,
      workflowDestinationSchema,
      workflowAttachedFileSchema,
      asArray,
      validateWorkflowSaveDestinations,
      loadWorkflowValidatorService,
      buildWorkflowValidationRepairHints: (entries: Array<Record<string, unknown>>) =>
        buildWorkflowValidationRepairHints(entries, asString),
      toWorkflowScheduleConfig,
      workflowScheduleInputSchema,
      humanizePollInterval,
      summarizeWorkflowCandidates,
    }),

    ...buildRepoCodingRuntimeTools(runtime, hooks, {
      withLifecycle,
      buildEnvelope,
      getCodingActivityTitle,
      asString,
      asRecord,
      asArray,
      createPendingDesktopRemoteApproval: (input: {
        runtime: VercelRuntimeRequestContext;
        action: any;
        actionGroup: ToolActionGroup;
        operation: string;
        summary: string;
        subject?: string;
        explanation?: string;
      }) =>
        createPendingDesktopRemoteApproval({
          ...input,
          buildEnvelope,
          loadHitlActionService,
          loadDepartmentService,
          loadDesktopWsGateway,
        }),
      summarizeRemoteLocalAction,
      summarizeActionResult: (
        runtimeInput: VercelRuntimeRequestContext,
        expectedOutputs?: string[],
      ) => summarizeActionResult(runtimeInput, buildEnvelope, expectedOutputs),
      buildRemoteLocalExecutionUnavailableEnvelope: (status: 'none' | 'ambiguous' | 'deny') =>
        buildRemoteLocalExecutionUnavailableEnvelope(status, buildEnvelope),
      loadDesktopWsGateway,
      resolveWorkspacePath,
      inspectWorkspace,
      readWorkspaceFiles,
    }),

    ...buildGoogleRuntimeTools(runtime, hooks, {
      buildEnvelope,
      withLifecycle,
      ensureActionPermission: (
        runtimeInput: VercelRuntimeRequestContext,
        toolId: any,
        actionGroup: ToolActionGroup,
      ) => ensureActionPermission(runtimeInput, toolId, actionGroup, buildEnvelope),
      toCanonicalToolId,
      resolveGoogleAccess: (
        runtimeInput: VercelRuntimeRequestContext,
        requiredScopes: string[],
      ) => resolveGoogleAccess(runtimeInput, requiredScopes, { buildEnvelope }),
      fetchGoogleApiJsonWithRetry,
      fetchGoogleApiResponseWithRetry,
      createPendingRemoteApproval: (input: {
        runtime: VercelRuntimeRequestContext;
        toolId: string;
        actionGroup: ToolActionGroup;
        operation: string;
        canonicalOperation?: any;
        summary: string;
        subject?: string;
        explanation?: string;
        payload: Record<string, unknown>;
      }) =>
        createPendingRemoteApproval({
          ...input,
          buildEnvelope,
          loadHitlActionService,
          loadExecuteStoredRemoteToolAction,
          loadDepartmentService,
        }),
      normalizeEmailHeaderField,
      normalizeGmailMessage: (rawMessage: Record<string, unknown>) =>
        normalizeGmailMessage(rawMessage, {
          asArray,
          asRecord,
          asString,
        }),
      loadOutboundArtifactService,
      loadEmailComposeService,
      asArray,
      asRecord,
      asString,
    }),

    ...buildZohoBooksRuntimeTools(runtime, hooks, {
      withLifecycle,
      buildEnvelope,
      ensureAnyActionPermission: (
        runtimeInput: VercelRuntimeRequestContext,
        toolIds: any[],
        actionGroup: ToolActionGroup,
        label?: string,
      ) => ensureAnyActionPermission(runtimeInput, toolIds, actionGroup, buildEnvelope, label),
      toCanonicalToolId,
      loadZohoGatewayService,
      buildZohoGatewayRequester,
      asRecord,
      asString,
      inferErrorKind,
      withBooksReadAuthorizationRetry,
      buildZohoGatewayDeniedEnvelope,
      loadZohoBooksClient,
      isZohoBooksContactStatementModuleAlias,
      resolveZohoBooksRecordIdFromRuntime,
      buildBooksWriteRepairHints,
      resolveZohoBooksModuleFromRuntime,
      resolveZohoBooksModuleScopedExplicitRecordId,
      loadZohoFinanceOpsService,
      asNumber,
      loadOutboundArtifactService,
      asArray,
      contextSearchBrokerService,
      buildBooksReadRecordsEnvelope: (input: {
        moduleName: string;
        organizationId?: string;
        resultItems: Array<Record<string, unknown>>;
        raw?: Record<string, unknown>;
        summarizeOnly?: boolean;
      }) =>
        buildBooksReadRecordsEnvelope({
          ...input,
          buildEnvelope,
          asString,
        }),
      resolvePendingBooksWriteBodyFromRuntime: (input: {
        runtime: VercelRuntimeRequestContext;
        operation: string;
        moduleName?: any;
        recordId?: string;
        explicitBody?: Record<string, unknown>;
      }) =>
        resolvePendingBooksWriteBodyFromRuntime({
          ...input,
          asRecord,
          asString,
        }),
      createPendingRemoteApproval: (input: {
        runtime: VercelRuntimeRequestContext;
        toolId: string;
        actionGroup: ToolActionGroup;
        operation: string;
        canonicalOperation?: any;
        summary: string;
        subject?: string;
        explanation?: string;
        payload: Record<string, unknown>;
      }) =>
        createPendingRemoteApproval({
          ...input,
          buildEnvelope,
          loadHitlActionService,
          loadExecuteStoredRemoteToolAction,
          loadDepartmentService,
        }),
    }),

    ...buildLarkRuntimeTools(runtime, hooks, {
      withLifecycle,
      buildEnvelope,
      buildLarkItemsEnvelope: (input: {
        summary: string;
        emptySummary: string;
        items: Array<Record<string, unknown>>;
        fullPayload?: Record<string, unknown>;
        keyData?: Record<string, unknown>;
      }) =>
        buildLarkItemsEnvelope({
          ...input,
          buildEnvelope,
        }),
      ensureActionPermission: (
        runtimeInput: VercelRuntimeRequestContext,
        toolId: any,
        actionGroup: ToolActionGroup,
      ) => ensureActionPermission(runtimeInput, toolId, actionGroup, buildEnvelope),
      toCanonicalToolId,
      uniqueDefinedStrings,
      asString,
      asRecord,
      asArray,
      loadListLarkPeople,
      loadResolveLarkPeople,
      createPendingRemoteApproval: (input: {
        runtime: VercelRuntimeRequestContext;
        toolId: string;
        actionGroup: ToolActionGroup;
        operation: string;
        canonicalOperation?: any;
        summary: string;
        subject?: string;
        explanation?: string;
        payload: Record<string, unknown>;
      }) =>
        createPendingRemoteApproval({
          ...input,
          buildEnvelope,
          loadHitlActionService,
          loadExecuteStoredRemoteToolAction,
          loadDepartmentService,
        }),
      loadLarkMessagingService,
      withLarkTenantFallback: <T>(
        runtimeInput: VercelRuntimeRequestContext,
        run: (auth: Record<string, unknown>) => Promise<T>,
      ) =>
        withLarkTenantFallback(runtimeInput, run, {
          loadLarkRuntimeClientError,
        }),
      loadLarkTasksService,
      getLarkDefaults: (runtimeInput: VercelRuntimeRequestContext) =>
        getLarkDefaults(runtimeInput, {
          loadLarkOperationalConfigRepository,
        }),
      buildConversationKey,
      loadNormalizeLarkTimestamp,
      loadListLarkTaskAssignablePeople,
      loadResolveLarkTaskAssignees,
      loadCanonicalizeLarkPersonIds,
      getLarkTimeZone,
      getLarkAuthInput,
      projectLarkItem,
      LARK_LARGE_RESULT_THRESHOLD,
      loadLarkCalendarService,
      loadLarkMeetingsService,
      loadLarkMinutesService,
      loadLarkDocsService,
    }),

    ...buildZohoCrmRuntimeTools(runtime, hooks, {
      withLifecycle,
      buildEnvelope,
      ensureAnyActionPermission: (
        runtimeInput: VercelRuntimeRequestContext,
        toolIds: any[],
        actionGroup: ToolActionGroup,
        label?: string,
      ) => ensureAnyActionPermission(runtimeInput, toolIds, actionGroup, buildEnvelope, label),
      toCanonicalToolId,
      normalizeZohoSourceType,
      normalizeZohoCrmModuleName,
      loadZohoGatewayService,
      buildZohoGatewayRequester,
      asRecord,
      asArray,
      asString,
      buildZohoGatewayDeniedEnvelope,
      inferErrorKind,
      loadZohoDataClient,
      asNumber,
      loadCompanyContextResolver,
      buildCrmMutationAuthorizationTarget,
      createPendingRemoteApproval: (input: {
        runtime: VercelRuntimeRequestContext;
        toolId: string;
        actionGroup: ToolActionGroup;
        operation: string;
        canonicalOperation?: any;
        summary: string;
        subject?: string;
        explanation?: string;
        payload: Record<string, unknown>;
      }) =>
        createPendingRemoteApproval({
          ...input,
          buildEnvelope,
          loadHitlActionService,
          loadExecuteStoredRemoteToolAction,
          loadDepartmentService,
        }),
      loadZohoReadAgent,
      buildAgentInvokeInput,
      toEnvelopeFromAgentResult,
    }),

    ...buildOutreachRuntimeTools(runtime, hooks, {
      withLifecycle,
      buildEnvelope,
      loadOutreachReadAgent,
      buildAgentInvokeInput,
      asRecord,
      asArray,
      asString,
      toEnvelopeFromAgentResult,
    }),
  };

  Object.assign(tools, buildCanonicalRuntimeWrappers(tools));
  Object.assign(tools, buildCompositeRuntimeTools(tools));

  return tools;
};

export const buildRuntimeToolFamilies = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  options?: {
    include?: string[];
  },
): RuntimeVercelToolFamilies => {
  const filteredTools = filterRuntimeToolMap(
    runtime,
    buildRuntimeToolInventory(runtime, hooks),
    wrapToolDefinitionWithBoundaryNormalization,
    options?.include,
  );

  return {
    contextSearch: pickRuntimeTools(filteredTools, ['contextSearch']),
    documents: pickRuntimeTools(filteredTools, ['documentRead']),
    workflowAuthoring: pickRuntimeTools(filteredTools, ['workflow']),
    repoCoding: pickRuntimeTools(filteredTools, ['devTools']),
    google: pickRuntimeTools(filteredTools, ['googleWorkspace']),
    zohoBooks: pickRuntimeTools(filteredTools, ['zohoBooks']),
    larkTask: pickRuntimeTools(filteredTools, ['larkTask']),
    larkMessaging: pickRuntimeTools(filteredTools, ['larkMessage']),
    larkCollab: pickRuntimeTools(filteredTools, [
      'larkCalendar',
      'larkMeeting',
      'larkApproval',
      'larkBase',
      'larkDoc',
    ]),
    zohoCrm: pickRuntimeTools(filteredTools, ['zohoCrm']),
    outreach: pickRuntimeTools(filteredTools, ['outreach']),
    search: pickRuntimeTools(filteredTools, ['webSearch', 'skillSearch']),
  };
};
