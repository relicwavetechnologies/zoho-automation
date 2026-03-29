import type { ToolRoutingDomain, ToolRoutingOperationClass } from '../../memory';
import { normalizeToolRoutingIntent } from '../../memory';
import type { VercelToolEnvelope } from '../../orchestration/vercel/types';

const DOMAIN_FAMILY_LABELS: Record<ToolRoutingDomain, string> = {
  zoho_books: 'Zoho Books',
  zoho_crm: 'Zoho CRM',
  gmail: 'Gmail',
  google_drive: 'Google Drive',
  google_calendar: 'Google Calendar',
  lark_base: 'Lark Base',
  lark_message: 'Lark Messaging',
  lark_task: 'Lark Tasks',
  lark_doc: 'Lark Docs',
  lark_calendar: 'Lark Calendar',
  lark_approval: 'Lark Approvals',
  lark_meeting: 'Lark Meetings',
  lark: 'Lark',
  workspace: 'Workspace',
  document_inspection: 'Document Inspection',
  web_search: 'Web Research',
  unknown: 'General / Unknown',
};

export const EXECUTION_TOOL_DEMAND_EVENT = 'analytics.tool_demand';
export const EXECUTION_CAPABILITY_GAP_EVENT = 'analytics.capability_gap';

type RoutingHints = {
  confidence?: number | null;
  domain?: string | null;
  operationType?: string | null;
  normalizedIntent?: string | null;
  reason?: string | null;
  suggestedToolIds?: string[];
  suggestedActions?: string[];
};

export type ExecutionToolDemandPayload = {
  channel: 'desktop' | 'lark';
  userQuery: string;
  enrichedQuery: string | null;
  normalizedIntent: string | null;
  canonicalIntentKey: string;
  inferredDomain: ToolRoutingDomain;
  inferredOperationClass: ToolRoutingOperationClass;
  intendedToolFamily: string;
  plannerChosenToolId: string | null;
  plannerChosenOperationClass: ToolRoutingOperationClass | null;
  plannerCandidateToolIds: string[];
  runExposedToolIds: string[];
  selectionReason: string;
  clarificationTriggered: boolean;
  validationFailureReason: string | null;
};

export type CapabilityGapKind =
  | 'selection_validation_failure'
  | 'no_tool_fit'
  | 'tool_unsupported';

export type ExecutionCapabilityGapPayload = ExecutionToolDemandPayload & {
  gapKind: CapabilityGapKind;
  gapKey: string;
  gapLabel: string;
  failedToolId: string | null;
  errorKind: string | null;
  errorMessage: string | null;
};

const toolFamilyFromToolId = (toolId?: string | null): string | null => {
  const value = toolId?.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('lark-calendar')) return 'Lark Calendar';
  if (value.startsWith('lark-task')) return 'Lark Tasks';
  if (value.startsWith('lark-message')) return 'Lark Messaging';
  if (value.startsWith('lark-base')) return 'Lark Base';
  if (value.startsWith('lark-doc') || value === 'create-lark-doc' || value === 'edit-lark-doc') return 'Lark Docs';
  if (value.startsWith('lark-approval')) return 'Lark Approvals';
  if (value.startsWith('lark-meeting')) return 'Lark Meetings';
  if (value.startsWith('google-calendar')) return 'Google Calendar';
  if (value.startsWith('google-drive')) return 'Google Drive';
  if (value.startsWith('google-gmail')) return 'Gmail';
  if (value.startsWith('zoho-books')) return 'Zoho Books';
  if (value.startsWith('zoho')) return 'Zoho CRM';
  if (value === 'document-ocr-read') return 'Document Inspection';
  if (value === 'search-read' || value === 'search-agent') return 'Web Research';
  if (value === 'coding' || value === 'repo') return 'Workspace';
  return null;
};

const resolveIntendedToolFamily = (domain: ToolRoutingDomain, toolId?: string | null): string =>
  DOMAIN_FAMILY_LABELS[domain] ?? toolFamilyFromToolId(toolId) ?? 'General / Unknown';

const buildGapLabel = (family: string, operationClass: ToolRoutingOperationClass, kind: CapabilityGapKind): string => {
  if (kind === 'tool_unsupported') {
    return `${family} could not support a ${operationClass} request`;
  }
  if (kind === 'no_tool_fit') {
    return `No tool fit ${family} ${operationClass} requests`;
  }
  return `${family} ${operationClass} requests failed selection validation`;
};

export const buildExecutionToolDemandPayload = (input: {
  channel: 'desktop' | 'lark';
  latestUserMessage: string;
  enrichedQueryText?: string | null;
  childRoute?: RoutingHints;
  hasWorkspace: boolean;
  hasArtifacts: boolean;
  inferredDomain: ToolRoutingDomain;
  inferredOperationClass: ToolRoutingOperationClass;
  plannerChosenToolId?: string | null;
  plannerChosenOperationClass?: ToolRoutingOperationClass | null;
  plannerCandidateToolIds: string[];
  runExposedToolIds: string[];
  selectionReason: string;
  clarificationTriggered: boolean;
  validationFailureReason?: string | null;
}): ExecutionToolDemandPayload => {
  const intent = normalizeToolRoutingIntent({
    latestUserMessage: input.latestUserMessage,
    childRoute: input.childRoute,
    hasWorkspace: input.hasWorkspace,
    hasArtifacts: input.hasArtifacts,
  });
  return {
    channel: input.channel,
    userQuery: input.latestUserMessage,
    enrichedQuery: input.enrichedQueryText?.trim() || null,
    normalizedIntent: input.childRoute?.normalizedIntent?.trim() || null,
    canonicalIntentKey: intent.canonicalIntentKey,
    inferredDomain: input.inferredDomain,
    inferredOperationClass: input.inferredOperationClass,
    intendedToolFamily: resolveIntendedToolFamily(input.inferredDomain, input.plannerChosenToolId),
    plannerChosenToolId: input.plannerChosenToolId?.trim() || null,
    plannerChosenOperationClass: input.plannerChosenOperationClass ?? null,
    plannerCandidateToolIds: input.plannerCandidateToolIds,
    runExposedToolIds: input.runExposedToolIds,
    selectionReason: input.selectionReason,
    clarificationTriggered: input.clarificationTriggered,
    validationFailureReason: input.validationFailureReason?.trim() || null,
  };
};

export const buildCapabilityGapFromSelection = (
  payload: ExecutionToolDemandPayload,
): ExecutionCapabilityGapPayload | null => {
  if (payload.validationFailureReason) {
    const gapKind: CapabilityGapKind = 'selection_validation_failure';
    return {
      ...payload,
      gapKind,
      gapKey: `${payload.canonicalIntentKey}:${gapKind}`,
      gapLabel: buildGapLabel(payload.intendedToolFamily, payload.inferredOperationClass, gapKind),
      failedToolId: payload.plannerChosenToolId,
      errorKind: 'validation',
      errorMessage: payload.validationFailureReason,
    };
  }
  if (payload.plannerChosenToolId || payload.runExposedToolIds.length > 0) {
    return null;
  }
  const gapKind: CapabilityGapKind = 'no_tool_fit';
  return {
    ...payload,
    gapKind,
    gapKey: `${payload.canonicalIntentKey}:${gapKind}`,
    gapLabel: buildGapLabel(payload.intendedToolFamily, payload.inferredOperationClass, gapKind),
    failedToolId: null,
    errorKind: null,
    errorMessage: payload.selectionReason,
  };
};

export const buildCapabilityGapFromToolFailure = (
  payload: ExecutionToolDemandPayload,
  toolName: string,
  output: VercelToolEnvelope,
): ExecutionCapabilityGapPayload | null => {
  if (output.success || output.errorKind !== 'unsupported') {
    return null;
  }
  const gapKind: CapabilityGapKind = 'tool_unsupported';
  return {
    ...payload,
    gapKind,
    gapKey: `${payload.canonicalIntentKey}:${gapKind}:${toolName}`,
    gapLabel: buildGapLabel(payload.intendedToolFamily, payload.inferredOperationClass, gapKind),
    failedToolId: toolName,
    errorKind: output.errorKind,
    errorMessage: output.summary ?? null,
  };
};
