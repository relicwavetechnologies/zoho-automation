import { logger } from '../../../utils/logger';
import type { VercelRuntimeRequestContext } from './types';
import type { RuntimeToolMap } from './tools/contracts';

const VERCEL_TOOL_PERMISSION_IDS: Record<string, string[]> = {
  webSearch: ['search-read', 'search-agent'],
  contextSearch: ['contextSearch', 'context-search'],
  documentOcrRead: ['documentRead', 'document-ocr-read'],
  invoiceParser: ['invoice-parser'],
  statementParser: ['statement-parser'],
  workflowDraft: ['workflow', 'workflow-authoring'],
  workflowPlan: ['workflow', 'workflow-authoring'],
  workflowBuild: ['workflow', 'workflow-authoring'],
  workflowValidate: ['workflow', 'workflow-authoring'],
  workflowSave: ['workflow', 'workflow-authoring'],
  workflowSchedule: ['workflow', 'workflow-authoring'],
  workflowList: ['workflow', 'workflow-authoring'],
  workflowArchive: ['workflow', 'workflow-authoring'],
  workflowRun: ['workflow', 'workflow-authoring'],
  workflow: ['workflow', 'workflow-authoring'],
  skillSearch: ['devTools', 'skill-search'],
  repo: ['devTools', 'repo'],
  coding: ['devTools', 'coding'],
  devTools: ['devTools', 'repo', 'coding', 'skill-search'],
  googleMail: ['googleWorkspace', 'google-gmail'],
  googleDrive: ['googleWorkspace', 'google-drive'],
  googleCalendar: ['googleWorkspace', 'google-calendar'],
  googleWorkspace: ['googleWorkspace', 'google-gmail', 'google-drive', 'google-calendar'],
  zoho: ['zohoCrm', 'search-zoho-context', 'read-zoho-records', 'zoho-agent', 'zoho-read', 'zoho-write'],
  zohoCrm: ['zohoCrm', 'search-zoho-context', 'read-zoho-records', 'zoho-agent', 'zoho-read', 'zoho-write'],
  booksRead: ['zohoBooks', 'zoho-books-read', 'zoho-books-agent'],
  booksWrite: ['zohoBooks', 'zoho-books-write', 'zoho-books-agent'],
  zohoBooks: ['zohoBooks', 'zoho-books-read', 'zoho-books-write', 'zoho-books-agent'],
  outreach: ['outreach', 'read-outreach-publishers', 'outreach-agent'],
  larkTask: ['larkTask', 'lark-task-read', 'lark-task-write', 'lark-task-agent'],
  larkMessage: ['larkMessage', 'lark-message-read', 'lark-message-write'],
  larkCalendar: [
    'larkCalendar',
    'lark-calendar-list',
    'lark-calendar-read',
    'lark-calendar-write',
    'lark-calendar-agent',
  ],
  larkMeeting: ['larkMeeting', 'lark-meeting-read', 'lark-meeting-agent'],
  larkApproval: ['larkApproval', 'lark-approval-read', 'lark-approval-write', 'lark-approval-agent'],
  larkDoc: ['larkDoc', 'create-lark-doc', 'edit-lark-doc', 'lark-doc-agent'],
  larkBase: ['larkBase', 'lark-base-read', 'lark-base-write', 'lark-base-agent'],
};

const isVercelToolAllowed = (runtime: VercelRuntimeRequestContext, toolName: string): boolean => {
  const requiredIds = VERCEL_TOOL_PERMISSION_IDS[toolName];
  if (!requiredIds || requiredIds.length === 0) {
    return false;
  }
  const allowed = new Set(runtime.allowedToolIds);
  return requiredIds.some((toolId) => allowed.has(toolId));
};

export const filterRuntimeToolMap = (
  runtime: VercelRuntimeRequestContext,
  toolMap: RuntimeToolMap,
  wrapToolDefinitionWithBoundaryNormalization: (toolName: string, toolDef: any) => any,
  include?: string[],
): RuntimeToolMap => {
  const includedTools = include && include.length > 0 ? new Set(include) : null;
  const filteredEntries = Object.entries(toolMap)
    .filter(([toolName]) => !includedTools || includedTools.has(toolName))
    .filter(([toolName]) => isVercelToolAllowed(runtime, toolName))
    .map(([toolName, toolDef]) => [toolName, wrapToolDefinitionWithBoundaryNormalization(toolName, toolDef)] as const);

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
