import { prisma } from '../../utils/prisma';
import { classifyIntent, toNarrowOperationClass } from '../orchestration/intent/canonical-intent';
import { addDays, MEMORY_ROUTING_PHRASE_EXAMPLE_CAP, type ToolRoutingDomain, type ToolRoutingFollowUpClass, type ToolRoutingIntent, type ToolRoutingMemoryValue, type ToolRoutingOperationClass, type ToolRoutingScopeHint, type UserMemoryChannelOrigin, type UserMemoryScope } from './contracts';
import { memoryContextService } from './memory-context.service';
import { memoryRetentionService } from './memory-retention.service';

type RoutingChildRouteHints = {
  domain?: string | null;
  operationType?: string | null;
  normalizedIntent?: string | null;
  reason?: string | null;
  suggestedToolIds?: string[];
  suggestedActions?: string[];
};

export type ToolRoutingPriorMatch = {
  memoryId: string;
  toolId: string;
  toolFamily: string;
  operationClass: ToolRoutingOperationClass;
  scope: UserMemoryScope;
  canonicalIntentKey: string;
  confidenceScore: number;
  score: number;
  matchedBy: 'exact_canonical' | 'base_intent' | 'domain_entity' | 'phrase_overlap' | 'thread_continuation';
};

export type ToolRoutingExecutionOutcome = {
  toolName: string;
  success: boolean;
  pendingApproval?: boolean;
};

type SuccessfulExecutionOutcome = ToolRoutingExecutionOutcome & {
  success: true;
  pendingApproval?: false | undefined;
};

type ParsedRoutingMemory = {
  id: string;
  scope: UserMemoryScope;
  subjectKey: string;
  summary: string;
  confidence: number;
  updatedAt: Date;
  lastConfirmedAt?: Date | null;
  value: ToolRoutingMemoryValue;
};

const FOLLOW_UP_AFFIRMATION_RE = /^(yes|yeah|yep|ok|okay|sure|go ahead|continue|proceed|do it|try again)\b/i;
const FOLLOW_UP_CONTINUATION_RE = /^(continue|go on|next|next one|same|do the same|check that|open that)\b/i;
const FOLLOW_UP_RETRY_RE = /^(retry|try again|run again|again)\b/i;

const normalizeWhitespace = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const normalizePhrase = (value: string): string =>
  normalizeWhitespace(
    value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' email_address ')
      .replace(/\b(show|fetch|pull|list)\b/g, 'get')
      .replace(/\bmail\b/g, 'email')
      .replace(/\bdm\b/g, 'direct message')
      .replace(/\bping\b/g, 'direct message')
      .replace(/\bquote\b/g, 'estimate')
      .replace(/\bbitable\b/g, 'base table')
      .replace(/\brecords?\b/g, 'record')
      .replace(/\binvoices?\b/g, 'invoice')
      .replace(/\bestimates?\b/g, 'estimate')
      .replace(/\btasks?\b/g, 'task'),
  );

const tokenize = (value: string): string[] =>
  normalizePhrase(value)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 2);

const tokenOverlap = (left: string, right: string): number => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.length === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, 1);
};

const dedupeRecentStrings = (values: string[], cap = MEMORY_ROUTING_PHRASE_EXAMPLE_CAP): string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const normalized = normalizePhrase(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
    if (output.length >= cap) {
      break;
    }
  }
  return output;
};

const detectFollowUpClass = (message: string): ToolRoutingFollowUpClass => {
  const text = normalizeWhitespace(message);
  if (FOLLOW_UP_RETRY_RE.test(text)) return 'retry';
  if (FOLLOW_UP_AFFIRMATION_RE.test(text)) return 'affirmation';
  if (FOLLOW_UP_CONTINUATION_RE.test(text)) return 'continuation';
  return 'fresh_request';
};

const detectOperationClass = (
  message: string,
  childRoute?: RoutingChildRouteHints,
): ToolRoutingOperationClass => {
  return toNarrowOperationClass(classifyIntent(normalizePhrase(message), {
    normalizedIntent: childRoute?.normalizedIntent,
    childRouterOperationType: childRoute?.operationType,
  })) as ToolRoutingOperationClass;
};

const hasExactExtractionIntent = (text: string): boolean =>
  /\b(ocr|extract text|exact text|read the text|what does it say|copy the text|transcribe|verbatim|all the text|full text)\b/.test(text);

const hasContextSearchIntent = (text: string): boolean => {
  if (/\b(context search|search history|search memory|conversation history|past chats?|past files?)\b/.test(text)) {
    return true;
  }
  if (/\b(remember|previous|before|last time|we talked about|we discussed|that file|that document|that csv|earlier)\b/.test(text)) {
    return true;
  }
  return /\b(csv|spreadsheet|sheet|file|files|document|documents|pdf|uploaded|assignment)\b/.test(text)
    && /\b(search|find|look up|look in|what did you find|history|memory|discussed|earlier|before)\b/.test(text);
};

const detectScopeHint = (message: string): ToolRoutingScopeHint => {
  const text = normalizePhrase(message);
  if (/\b(my|mine|me)\b/.test(text)) return 'self';
  if (/\b(all|company|everyone|every|entire)\b/.test(text)) return 'company';
  return 'unspecified';
};

const detectDomain = (
  text: string,
  hasWorkspace: boolean,
  hasArtifacts: boolean,
  childRoute?: RoutingChildRouteHints,
): ToolRoutingDomain => {
  const canonicalIntent = classifyIntent(text, {
    normalizedIntent: childRoute?.normalizedIntent,
    childRouterDomain: childRoute?.domain,
  });
  if (childRoute?.domain?.trim()) {
    return childRoute.domain.trim() as ToolRoutingDomain;
  }
  if (canonicalIntent.domain === 'zoho_books') {
    return 'zoho_books';
  }
  if (canonicalIntent.domain === 'zoho_crm') {
    return 'zoho_crm';
  }
  if (!hasExactExtractionIntent(text) && hasContextSearchIntent(text)) {
    return 'context_search';
  }
  if (canonicalIntent.domain === 'gmail' || /\b(draft email|send by gmail|mail via gmail)\b/.test(text)) {
    return 'gmail';
  }
  if (/\b(google drive|drive file|drive folder)\b/.test(text)) {
    return 'google_drive';
  }
  if (/\b(google calendar)\b/.test(text)) {
    return 'google_calendar';
  }
  if (/\b(base table|bitable|table|record|field|view)\b/.test(text)) {
    return 'lark_base';
  }
  if (
    /\b(lark dm|lark direct message|direct message|send dm|message me|message him|message her|message them|ping me|ping him|ping her|ping them)\b/.test(text)
    || (/\bsend\b/.test(text) && /\bon lark\b/.test(text) && /\b(to me|to him|to her|to them|to [a-z])\b/.test(text))
  ) {
    return 'lark_message';
  }
  if (/\b(task|assignee|todo|due date)\b/.test(text)) {
    return 'lark_task';
  }
  if (canonicalIntent.domain === 'lark_doc' || /\b(note|writeup|report)\b/.test(text)) {
    return 'lark_doc';
  }
  if (/\b(lark calendar|calendar event|schedule|event)\b/.test(text)) {
    return 'lark_calendar';
  }
  if (/\b(approval|approvals)\b/.test(text)) {
    return 'lark_approval';
  }
  if (/\b(meeting|minutes)\b/.test(text)) {
    return 'lark_meeting';
  }
  if (/\b(lark)\b/.test(text)) {
    return 'lark';
  }
  if (hasArtifacts && /\b(button|screenshot|image|attachment|pdf|csv|document|file|message)\b/.test(text)) {
    return 'document_inspection';
  }
  if (hasWorkspace && /\b(repo|repository|workspace|folder|file path|terminal|command|script|code)\b/.test(text)) {
    return 'workspace';
  }
  if (canonicalIntent.domain === 'web_search' || /\b(web|internet|online|site|up to date|up-to-date)\b/.test(text)) {
    return 'web_search';
  }
  return 'unknown';
};

const detectEntity = (domain: ToolRoutingDomain, text: string): string => {
  switch (domain) {
    case 'zoho_books':
      if (/\binvoice\b/.test(text)) return 'invoices';
      if (/\bestimate\b/.test(text)) return 'estimates';
      if (/\bbill\b/.test(text)) return 'bills';
      if (/\bpayment\b/.test(text)) return 'payments';
      return 'records';
    case 'zoho_crm':
      if (/\blead\b/.test(text)) return 'leads';
      if (/\bcontact\b/.test(text)) return 'contacts';
      if (/\bdeal\b/.test(text)) return 'deals';
      if (/\bcase\b/.test(text)) return 'cases';
      return 'records';
    case 'context_search':
      return 'retrieval';
    case 'lark_base':
      if (/\bfield\b/.test(text)) return 'fields';
      if (/\bview\b/.test(text)) return 'views';
      if (/\btable\b/.test(text)) return 'tables';
      return 'records';
    case 'lark_message':
      return 'messages';
    case 'lark_task':
      return 'tasks';
    case 'lark_doc':
      return 'docs';
    case 'lark_calendar':
      return 'events';
    case 'lark_approval':
      return 'approvals';
    case 'lark_meeting':
      return 'meetings';
    case 'document_inspection':
      return 'documents';
    case 'workspace':
      return 'workspace';
    case 'gmail':
      return 'messages';
    case 'google_drive':
      return 'files';
    case 'google_calendar':
      return 'events';
    case 'web_search':
      return 'search';
    default:
      return 'general';
  }
};

const buildEvidenceText = (input: {
  latestUserMessage: string;
  childRoute?: RoutingChildRouteHints;
}): string => {
  const fragments = [
    input.latestUserMessage,
    input.childRoute?.normalizedIntent ?? '',
    ...(input.childRoute?.suggestedActions ?? []),
    input.childRoute?.reason ?? '',
  ];
  return normalizePhrase(fragments.filter(Boolean).join('\n'));
};

const getCanonicalIntentBaseKey = (intent: ToolRoutingIntent): string =>
  `${intent.domain}:${intent.operationClass}:${intent.entity}`;

const parseRoutingValue = (value: unknown): ToolRoutingMemoryValue | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.toolId !== 'string' || typeof record.toolFamily !== 'string' || typeof record.canonicalIntentKey !== 'string') {
    return null;
  }
  return {
    toolId: record.toolId,
    toolFamily: record.toolFamily,
    operationClass: (typeof record.operationClass === 'string' ? record.operationClass : 'read') as ToolRoutingOperationClass,
    canonicalIntentKey: record.canonicalIntentKey,
    phraseExamples: Array.isArray(record.phraseExamples) ? record.phraseExamples.filter((item): item is string => typeof item === 'string').slice(0, MEMORY_ROUTING_PHRASE_EXAMPLE_CAP) : [],
    successCount: typeof record.successCount === 'number' ? record.successCount : 0,
    failureCount: typeof record.failureCount === 'number' ? record.failureCount : 0,
    correctionCount: typeof record.correctionCount === 'number' ? record.correctionCount : 0,
    clarificationCount: typeof record.clarificationCount === 'number' ? record.clarificationCount : 0,
    lastToolSelectionReason: typeof record.lastToolSelectionReason === 'string' ? record.lastToolSelectionReason : undefined,
    confidenceScore: typeof record.confidenceScore === 'number' ? record.confidenceScore : 0,
  };
};

const computeRoutingConfidence = (input: {
  value: Pick<ToolRoutingMemoryValue, 'successCount' | 'failureCount' | 'correctionCount' | 'clarificationCount'>;
  scope: UserMemoryScope;
  updatedAt?: Date;
}): number => {
  const successes = input.value.successCount;
  const failures = input.value.failureCount;
  const corrections = input.value.correctionCount;
  const clarifications = input.value.clarificationCount;
  const total = successes + failures + corrections + clarifications;
  const successRatio = total > 0 ? successes / total : 0;
  const ageDays = input.updatedAt
    ? Math.max(0, (Date.now() - input.updatedAt.getTime()) / (24 * 60 * 60 * 1000))
    : 0;
  const recencyPenalty = ageDays > 30 ? Math.min(0.18, (ageDays - 30) * 0.004) : 0;
  const scopeBonus = input.scope === 'thread_pinned' ? 0.06 : 0;
  const score =
    0.24
    + Math.min(successes, 8) * 0.055
    + (successRatio * 0.28)
    - Math.min(failures, 4) * 0.04
    - Math.min(corrections, 4) * 0.08
    - Math.min(clarifications, 4) * 0.025
    + scopeBonus
    - recencyPenalty;
  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(4))));
};

const deriveToolFamily = (toolId: string): string => {
  if (toolId.startsWith('zoho-books')) return 'zoho_books';
  if (toolId.startsWith('zoho')) return 'zoho_crm';
  if (toolId.startsWith('lark-base')) return 'lark_base';
  if (toolId.startsWith('lark-task')) return 'lark_task';
  if (toolId.startsWith('lark-message')) return 'lark_message';
  if (toolId.startsWith('lark-calendar')) return 'lark_calendar';
  if (toolId.startsWith('lark-approval')) return 'lark_approval';
  if (toolId.startsWith('lark-meeting')) return 'lark_meeting';
  if (toolId.startsWith('lark-doc') || toolId.startsWith('create-lark-doc') || toolId.startsWith('edit-lark-doc')) return 'lark_doc';
  if (toolId.startsWith('google-gmail')) return 'gmail';
  if (toolId.startsWith('google-drive')) return 'google_drive';
  if (toolId.startsWith('google-calendar')) return 'google_calendar';
  if (toolId.startsWith('document-ocr')) return 'document_inspection';
  if (toolId.startsWith('workflow-authoring')) return 'workflow';
  if (toolId.startsWith('search-read') || toolId.startsWith('search-agent')) return 'web_search';
  if (toolId.startsWith('search-documents')) return 'document_search';
  if (toolId.startsWith('context-search')) return 'context_search';
  if (toolId.startsWith('coding')) return 'workspace';
  if (toolId.startsWith('repo')) return 'repo';
  return toolId;
};

const isGenericHelperTool = (toolId: string): boolean =>
  toolId === 'skill-search'
  || toolId === 'document-ocr-read'
  || toolId === 'context-search'
  || toolId === 'search-read'
  || toolId === 'search-agent';

const EXECUTION_TOOL_ID_CANDIDATES: Record<string, string[]> = {
  booksRead: ['zoho-books-read', 'zoho-books-agent'],
  booksWrite: ['zoho-books-write', 'zoho-books-agent'],
  zoho: ['zoho-read', 'read-zoho-records', 'zoho-agent', 'zoho-write'],
  googleMail: ['google-gmail'],
  googleDrive: ['google-drive'],
  googleCalendar: ['google-calendar'],
  documentOcrRead: ['document-ocr-read'],
  workflowDraft: ['workflow-authoring'],
  workflowPlan: ['workflow-authoring'],
  workflowBuild: ['workflow-authoring'],
  workflowValidate: ['workflow-authoring'],
  workflowSave: ['workflow-authoring'],
  workflowSchedule: ['workflow-authoring'],
  workflowList: ['workflow-authoring'],
  workflowArchive: ['workflow-authoring'],
  workflowRun: ['workflow-authoring'],
  skillSearch: ['skill-search'],
  repo: ['repo'],
  coding: ['coding'],
  webSearch: ['search-read', 'search-agent'],
  contextSearch: ['context-search'],
  larkTask: ['lark-task-read', 'lark-task-write', 'lark-task-agent'],
  larkMessage: ['lark-message-read', 'lark-message-write'],
  larkCalendar: ['lark-calendar-list', 'lark-calendar-read', 'lark-calendar-write', 'lark-calendar-agent'],
  larkMeeting: ['lark-meeting-read', 'lark-meeting-agent'],
  larkApproval: ['lark-approval-read', 'lark-approval-write', 'lark-approval-agent'],
  larkDoc: ['lark-doc-agent', 'create-lark-doc', 'edit-lark-doc'],
  larkBase: ['lark-base-read', 'lark-base-write', 'lark-base-agent'],
};

const EXECUTION_TOOL_OPERATION: Partial<Record<string, ToolRoutingOperationClass>> = {
  booksRead: 'read',
  booksWrite: 'write',
  zoho: 'read',
  googleMail: 'send',
  googleDrive: 'read',
  googleCalendar: 'schedule',
  documentOcrRead: 'inspect',
  workflowDraft: 'write',
  workflowPlan: 'read',
  workflowBuild: 'write',
  workflowSave: 'write',
  workflowSchedule: 'schedule',
  workflowList: 'read',
  workflowRun: 'read',
  skillSearch: 'read',
  repo: 'read',
  coding: 'write',
  webSearch: 'search',
  contextSearch: 'search',
  larkTask: 'write',
  larkMessage: 'send',
  larkCalendar: 'schedule',
  larkMeeting: 'read',
  larkApproval: 'write',
  larkDoc: 'write',
  larkBase: 'read',
};

const choosePreferredToolIdForIntent = (input: {
  plannerChosenToolId?: string | null;
  primaryOutcomeToolName: string;
  runExposedToolIds?: string[];
  intent: ToolRoutingIntent;
}): string | null => {
  const runExposed = new Set(input.runExposedToolIds ?? []);
  const candidates = EXECUTION_TOOL_ID_CANDIDATES[input.primaryOutcomeToolName] ?? [];
  const usableCandidates = candidates.filter((toolId) => runExposed.size === 0 || runExposed.has(toolId));
  const nonHelperCandidates = usableCandidates.filter((toolId) => !isGenericHelperTool(toolId));
  const plannerChosen = input.plannerChosenToolId?.trim();
  if (plannerChosen && !isGenericHelperTool(plannerChosen)) {
    return plannerChosen;
  }

  const preferredOrderByDomain: Partial<Record<ToolRoutingDomain, Partial<Record<ToolRoutingOperationClass, string[]>>>> = {
    lark_calendar: {
      schedule: ['lark-calendar-agent', 'lark-calendar-write', 'lark-calendar-read', 'lark-calendar-list'],
      write: ['lark-calendar-agent', 'lark-calendar-write', 'lark-calendar-read', 'lark-calendar-list'],
      read: ['lark-calendar-read', 'lark-calendar-list', 'lark-calendar-agent'],
      inspect: ['lark-calendar-read', 'lark-calendar-list', 'lark-calendar-agent'],
    },
    lark_task: {
      write: ['lark-task-write', 'lark-task-agent', 'lark-task-read'],
      read: ['lark-task-read', 'lark-task-agent', 'lark-task-write'],
      inspect: ['lark-task-read', 'lark-task-agent', 'lark-task-write'],
    },
    lark_message: {
      send: ['lark-message-write', 'lark-message-read'],
      read: ['lark-message-read', 'lark-message-write'],
    },
    lark_base: {
      write: ['lark-base-write', 'lark-base-agent', 'lark-base-read'],
      read: ['lark-base-read', 'lark-base-agent', 'lark-base-write'],
    },
  };

  const domainPreferred = preferredOrderByDomain[input.intent.domain]?.[input.intent.operationClass] ?? [];
  const preferredPool = nonHelperCandidates.length > 0 ? nonHelperCandidates : usableCandidates;
  for (const toolId of domainPreferred) {
    if (preferredPool.includes(toolId)) {
      return toolId;
    }
  }

  return (
    nonHelperCandidates[0]
    ?? usableCandidates[0]
    ?? candidates.find((toolId) => !isGenericHelperTool(toolId))
    ?? candidates[0]
    ?? plannerChosen
    ?? null
  );
};

const choosePrimaryOutcomeForIntent = (input: {
  successful: SuccessfulExecutionOutcome[];
  intent: ToolRoutingIntent;
  plannerChosenToolId?: string | null;
}): SuccessfulExecutionOutcome | null => {
  const plannerChosenFamily = input.plannerChosenToolId ? deriveToolFamily(input.plannerChosenToolId) : null;
  let best: { outcome: SuccessfulExecutionOutcome; score: number } | null = null;

  for (const [index, outcome] of input.successful.entries()) {
    const candidateToolIds = EXECUTION_TOOL_ID_CANDIDATES[outcome.toolName] ?? [];
    const candidateFamilies = new Set(candidateToolIds.map((toolId) => deriveToolFamily(toolId)));
    const candidateOperation = EXECUTION_TOOL_OPERATION[outcome.toolName];
    const hasDomainMatch = candidateFamilies.has(input.intent.domain);
    const hasOperationMatch = candidateOperation === input.intent.operationClass;
    const hasPlannerFamilyMatch = plannerChosenFamily ? candidateFamilies.has(plannerChosenFamily) : false;
    const nonHelperCandidates = candidateToolIds.filter((toolId) => !isGenericHelperTool(toolId));

    let score = 0;
    score += hasDomainMatch ? 120 : 0;
    score += hasOperationMatch ? 50 : 0;
    score += hasPlannerFamilyMatch ? 20 : 0;
    score += nonHelperCandidates.length > 0 ? 10 : -40;
    score += index;

    if (!hasDomainMatch && candidateFamilies.size > 0 && input.intent.domain !== 'unknown') {
      score -= 60;
    }
    if (!hasOperationMatch && candidateOperation && input.intent.operationClass !== candidateOperation) {
      score -= 25;
    }

    if (!best || score > best.score) {
      best = { outcome, score };
    }
  }

  if (!best) {
    return null;
  }

  return best.score >= 40 ? best.outcome : null;
};

export const normalizeToolRoutingIntent = (input: {
  latestUserMessage: string;
  childRoute?: RoutingChildRouteHints;
  hasWorkspace?: boolean;
  hasArtifacts?: boolean;
}): ToolRoutingIntent => {
  const evidenceText = buildEvidenceText({
    latestUserMessage: input.latestUserMessage,
    childRoute: input.childRoute,
  });
  const domain = detectDomain(
    evidenceText,
    Boolean(input.hasWorkspace),
    Boolean(input.hasArtifacts),
    input.childRoute,
  );
  const operationClass = detectOperationClass(evidenceText, input.childRoute);
  const entity = detectEntity(domain, evidenceText);
  const scopeHint = detectScopeHint(evidenceText);
  const followUpClass = detectFollowUpClass(input.latestUserMessage);
  const canonicalIntentKey = `${domain}:${operationClass}:${entity}:${scopeHint}`;

  return {
    domain,
    operationClass,
    entity,
    scopeHint,
    followUpClass,
    canonicalIntentKey,
    subjectKey: `tool_route:${canonicalIntentKey}`,
    normalizedQuery: evidenceText,
  };
};

class ToolRoutingService {
  async findRoutingPriors(input: {
    companyId: string;
    userId: string;
    threadId?: string;
    conversationKey?: string;
    allowedToolIds?: string[];
    latestUserMessage: string;
    childRoute?: RoutingChildRouteHints;
    hasWorkspace?: boolean;
    hasArtifacts?: boolean;
  }): Promise<{ intent: ToolRoutingIntent; priors: ToolRoutingPriorMatch[] }> {
    const intent = normalizeToolRoutingIntent({
      latestUserMessage: input.latestUserMessage,
      childRoute: input.childRoute,
      hasWorkspace: input.hasWorkspace,
      hasArtifacts: input.hasArtifacts,
    });
    const { activeItems } = await memoryContextService.getActiveMemoryState({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      conversationKey: input.conversationKey,
    });
    const allowedToolIds = input.allowedToolIds ? new Set(input.allowedToolIds) : null;
    const baseKey = getCanonicalIntentBaseKey(intent);

    const ranked = activeItems
      .filter((item) => item.kind === 'tool_routing' && item.status === 'active')
      .map<ParsedRoutingMemory | null>((item) => {
        const value = parseRoutingValue(item.valueJson);
        if (!value) {
          return null;
        }
        return {
          id: item.id,
          scope: item.scope,
          subjectKey: item.subjectKey,
          summary: item.summary,
          confidence: item.confidence,
          updatedAt: item.updatedAt,
          lastConfirmedAt: item.lastConfirmedAt,
          value,
        };
      })
      .filter((item): item is ParsedRoutingMemory => Boolean(item))
      .filter((item) => !allowedToolIds || allowedToolIds.has(item.value.toolId))
      .map((item) => {
        const candidateBaseKey = item.value.canonicalIntentKey.split(':').slice(0, 3).join(':');
        const candidateDomain = item.value.canonicalIntentKey.split(':')[0] ?? 'unknown';
        const candidateEntity = item.value.canonicalIntentKey.split(':')[2] ?? 'general';
        const ageDays = Math.max(0, (Date.now() - item.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
        const recencyBoost = Math.max(0, 18 - ageDays);
        const phraseOverlap = Math.max(
          tokenOverlap(intent.normalizedQuery, `${item.summary} ${item.subjectKey} ${item.value.canonicalIntentKey}`),
          ...item.value.phraseExamples.map((phrase) => tokenOverlap(intent.normalizedQuery, phrase)),
        );
        const exactCanonical = item.value.canonicalIntentKey === intent.canonicalIntentKey;
        const sameBase = candidateBaseKey === baseKey;
        const sameDomainEntity = candidateDomain === intent.domain && candidateEntity === intent.entity;
        const threadContinuation = intent.followUpClass !== 'fresh_request' && item.scope === 'thread_pinned';
        const matchedBy: ToolRoutingPriorMatch['matchedBy'] =
          exactCanonical
            ? 'exact_canonical'
            : threadContinuation
              ? 'thread_continuation'
              : sameBase
                ? 'base_intent'
                : sameDomainEntity
                  ? 'domain_entity'
                  : 'phrase_overlap';
        const score =
          (item.value.confidenceScore * 100)
          + (exactCanonical ? 130 : 0)
          + (sameBase ? 92 : 0)
          + (sameDomainEntity ? 68 : 0)
          + (threadContinuation ? 35 : 0)
          + (phraseOverlap * 55)
          + (item.scope === 'thread_pinned' ? 20 : 0)
          + recencyBoost;
        return {
          memoryId: item.id,
          toolId: item.value.toolId,
          toolFamily: item.value.toolFamily,
          operationClass: item.value.operationClass,
          scope: item.scope,
          canonicalIntentKey: item.value.canonicalIntentKey,
          confidenceScore: item.value.confidenceScore,
          score,
          matchedBy,
        } satisfies ToolRoutingPriorMatch;
      })
      .filter((item) => {
        const candidateDomain = item.canonicalIntentKey.split(':')[0] ?? 'unknown';
        if (item.matchedBy === 'phrase_overlap' && candidateDomain !== intent.domain) {
          return false;
        }
        return item.score >= 40;
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.confidenceScore - left.confidenceScore;
      });

    const byToolId = new Map<string, ToolRoutingPriorMatch>();
    for (const item of ranked) {
      const current = byToolId.get(item.toolId);
      if (!current || item.score > current.score) {
        byToolId.set(item.toolId, item);
      }
    }

    return {
      intent,
      priors: [...byToolId.values()].sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.confidenceScore - left.confidenceScore;
      }).slice(0, 6),
    };
  }

  async recordToolSelectionOutcome(input: {
    companyId: string;
    userId?: string | null;
    channelOrigin: UserMemoryChannelOrigin;
    threadId?: string;
    conversationKey?: string;
    latestUserMessage: string;
    childRoute?: RoutingChildRouteHints;
    hasWorkspace?: boolean;
    hasArtifacts?: boolean;
    plannerChosenToolId?: string;
    plannerChosenOperationClass?: string;
    runExposedToolIds?: string[];
    toolResults: ToolRoutingExecutionOutcome[];
    selectionReason?: string;
  }): Promise<void> {
    if (!input.userId) {
      return;
    }
    const successful = input.toolResults.filter((result): result is SuccessfulExecutionOutcome => result.success && !result.pendingApproval);
    if (successful.length === 0) {
      return;
    }

    const intent = normalizeToolRoutingIntent({
      latestUserMessage: input.latestUserMessage,
      childRoute: input.childRoute,
      hasWorkspace: input.hasWorkspace,
      hasArtifacts: input.hasArtifacts,
    });
    const primaryOutcome = choosePrimaryOutcomeForIntent({
      successful,
      intent,
      plannerChosenToolId: input.plannerChosenToolId,
    });
    if (!primaryOutcome) {
      return;
    }
    const chosenToolId = choosePreferredToolIdForIntent({
      plannerChosenToolId: input.plannerChosenToolId,
      primaryOutcomeToolName: primaryOutcome.toolName,
      runExposedToolIds: input.runExposedToolIds,
      intent,
    });
    if (!chosenToolId) {
      return;
    }

    const operationClass = (
      (typeof input.plannerChosenOperationClass === 'string' ? input.plannerChosenOperationClass : null)
      ?? EXECUTION_TOOL_OPERATION[primaryOutcome.toolName]
      ?? intent.operationClass
    ) as ToolRoutingOperationClass;
    const now = new Date();
    const phraseExamples = dedupeRecentStrings([
      input.latestUserMessage,
      input.childRoute?.normalizedIntent ?? '',
      ...(input.childRoute?.suggestedActions ?? []),
    ]);

    const scopes: Array<{ scope: UserMemoryScope; threadId?: string; conversationKey?: string }> = [
      { scope: 'user_global' },
      ...((input.threadId || input.conversationKey)
        ? [{ scope: 'thread_pinned' as const, threadId: input.threadId, conversationKey: input.conversationKey }]
        : []),
    ];

    for (const scopeEntry of scopes) {
      const existing = await prisma.userMemoryItem.findFirst({
        where: {
          companyId: input.companyId,
          userId: input.userId,
          kind: 'tool_routing',
          scope: scopeEntry.scope,
          subjectKey: intent.subjectKey,
          status: 'active',
          ...(scopeEntry.scope === 'thread_pinned'
            ? {
              threadId: scopeEntry.threadId ?? null,
              conversationKey: scopeEntry.conversationKey ?? null,
            }
            : {}),
        },
        select: {
          id: true,
          summary: true,
          valueJson: true,
          confidence: true,
          updatedAt: true,
          lastConfirmedAt: true,
        },
      });

      const existingValue = parseRoutingValue(existing?.valueJson);
      const nextValue: ToolRoutingMemoryValue = {
        toolId: chosenToolId,
        toolFamily: deriveToolFamily(chosenToolId),
        operationClass,
        canonicalIntentKey: intent.canonicalIntentKey,
        phraseExamples: dedupeRecentStrings([
          ...phraseExamples,
          ...(existingValue?.phraseExamples ?? []),
        ]),
        successCount: (existingValue?.successCount ?? 0) + 1,
        failureCount: existingValue?.failureCount ?? 0,
        correctionCount: existingValue?.correctionCount ?? 0,
        clarificationCount: existingValue?.clarificationCount ?? 0,
        lastToolSelectionReason: input.selectionReason,
        confidenceScore: 0,
      };
      nextValue.confidenceScore = computeRoutingConfidence({
        value: nextValue,
        scope: scopeEntry.scope,
        updatedAt: now,
      });
      const summary = `Route ${intent.canonicalIntentKey} to ${chosenToolId} (${nextValue.successCount} success${nextValue.successCount === 1 ? '' : 'es'}).`;

      if (existing) {
        await prisma.userMemoryItem.update({
          where: { id: existing.id },
          data: {
            summary,
            valueJson: nextValue,
            confidence: nextValue.confidenceScore,
            channelOrigin: input.channelOrigin,
            source: 'tool_result',
            lastSeenAt: now,
            lastConfirmedAt: now,
            staleAfterAt: addDays(now, 60),
          },
        });
      } else {
        await prisma.userMemoryItem.create({
          data: {
            companyId: input.companyId,
            userId: input.userId,
            kind: 'tool_routing',
            scope: scopeEntry.scope,
            channelOrigin: input.channelOrigin,
            threadId: scopeEntry.scope === 'thread_pinned' ? scopeEntry.threadId : null,
            conversationKey: scopeEntry.scope === 'thread_pinned' ? scopeEntry.conversationKey : null,
            subjectKey: intent.subjectKey,
            summary,
            valueJson: nextValue,
            confidence: nextValue.confidenceScore,
            status: 'active',
            source: 'tool_result',
            firstSeenAt: now,
            lastSeenAt: now,
            lastConfirmedAt: now,
            staleAfterAt: addDays(now, 60),
          },
        });
      }
    }

    await memoryContextService.invalidateCache({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      conversationKey: input.conversationKey,
    });
    await memoryRetentionService.applyRetention({
      companyId: input.companyId,
      userId: input.userId,
    });
  }
}

export const toolRoutingService = new ToolRoutingService();
