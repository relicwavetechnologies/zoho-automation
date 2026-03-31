import { generateText } from 'ai';
import { z } from 'zod';

import { memoryService, normalizeToolRoutingIntent, type ToolRoutingDomain, type ToolRoutingOperationClass, type ToolRoutingPriorMatch } from '../../memory';
import { logger } from '../../../utils/logger';
import { classifyIntent, toNarrowOperationClass } from '../intent/canonical-intent';
import { resolveVercelChildRouterModel } from '../vercel/model-factory';
import { ALIAS_TO_CANONICAL_ID, DOMAIN_ALIASES, DOMAIN_TO_TOOL_IDS, TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import type { ToolActionGroup } from '../../tools/tool-action-groups';

type OperationClass = ToolRoutingOperationClass;
type IntentDomain = ToolRoutingDomain;

type ChildRouteHints = {
  confidence?: number | null;
  domain?: string | null;
  operationType?: string | null;
  normalizedIntent?: string | null;
  reason?: string | null;
  suggestedToolIds?: string[];
  suggestedActions?: string[];
};

export type RunScopedToolSelection = {
  runExposedToolIds: string[];
  plannerCandidateToolIds: string[];
  selectionReason: string;
  selectionFallbackNeeded: boolean;
  inferredDomain: IntentDomain;
  inferredOperationClass: OperationClass;
  clarificationQuestion?: string;
  plannerChosenToolId?: string;
  plannerChosenOperationClass?: OperationClass;
  validationFailureReason?: string;
};

type RuntimeChannel = 'lark' | 'desktop' | 'api';

type ArtifactMode = 'none' | 'image_only' | 'document_only' | 'mixed';

const plannerDecisionSchema = z.object({
  answerFromContextOnly: z.boolean().optional(),
  chosenToolId: z.string().min(1).max(80).optional(),
  chosenOperationClass: z.enum(['read', 'write', 'send', 'inspect', 'schedule', 'search']).optional(),
  candidateToolIds: z.array(z.string().min(1).max(80)).max(8).optional(),
  sourceOfTruthReason: z.string().min(1).max(1200),
  missingFields: z.array(z.string().min(1).max(120)).max(8).optional(),
  shouldAskClarification: z.boolean().optional(),
  clarificationQuestion: z.string().max(300).optional(),
});

const GLOBAL_ALWAYS_ON_IDS = ['context-search'] as const;
const CLARIFICATION_ALLOWED_ONLY_WHEN_DOMAIN_UNKNOWN = [
  'general',
  'unknown',
  'ambiguous',
  'unspecified',
] as const;
const LARK_CHANNEL_BASELINE_DOMAINS: IntentDomain[] = [
  'context_search',
  'lark_base',
  'lark_task',
  'lark_message',
  'lark_doc',
  'lark_calendar',
  'lark_approval',
  'lark_meeting',
  'zoho_books',
  'zoho_crm',
] as const;
const WORKSPACE_GLOBAL_IDS = ['coding'] as const;
const ARTIFACT_GLOBAL_IDS = ['document-ocr-read'] as const;
const INVARIANT_GUARDED_DOMAINS = new Set<IntentDomain>([
  'lark_task',
  'workflow',
  'context_search',
  'lark_message',
  'lark_calendar',
  'zoho_books',
  'zoho_crm',
]);

const asLower = (value?: string | null): string => value?.trim().toLowerCase() ?? '';
const uniq = (values: Array<string | undefined | null>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));

const extractFirstJsonObject = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
};

const chooseFirstAllowed = (allowed: Set<string>, preferredIds: string[]): string[] => {
  for (const id of preferredIds) {
    if (allowed.has(id)) {
      return [id];
    }
  }
  return [];
};

const buildAllowedDomainFamily = (
  allowed: Set<string>,
  domain?: string | null,
): string[] => {
  const normalizedDomain = domain?.trim();
  if (!normalizedDomain) return [];
  const canonicalDomain = DOMAIN_ALIASES[normalizedDomain] ?? DOMAIN_ALIASES[normalizedDomain.toLowerCase()];
  if (!canonicalDomain) return [];
  return uniq((DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []).filter((toolId) => allowed.has(toolId)));
};

const buildChannelBaseline = (input: {
  channel: RuntimeChannel;
  allowed: Set<string>;
  workspaceAvailable: boolean;
  exposeArtifactTools: boolean;
}): string[] =>
  uniq([
    ...(input.channel === 'lark'
      ? LARK_CHANNEL_BASELINE_DOMAINS.flatMap((domain) => buildAllowedDomainFamily(input.allowed, domain))
      : GLOBAL_ALWAYS_ON_IDS.filter((toolId) => input.allowed.has(toolId))),
    ...(input.workspaceAvailable ? WORKSPACE_GLOBAL_IDS.filter((toolId) => input.allowed.has(toolId)) : []),
    ...(input.exposeArtifactTools ? ARTIFACT_GLOBAL_IDS.filter((toolId) => input.allowed.has(toolId)) : []),
  ]);

export const checkToolSelectionInvariant = (input: {
  intentDomain?: string | null;
  runExposedToolIds: string[];
  allowedToolIds: string[];
}): { passed: boolean; widenedToolIds: string[]; missingFamily: string[] } => {
  const normalizedDomain = input.intentDomain?.trim();
  const canonicalDomain = normalizedDomain
    ? (DOMAIN_ALIASES[normalizedDomain] ?? DOMAIN_ALIASES[normalizedDomain.toLowerCase()])
    : undefined;
  if (!canonicalDomain || !INVARIANT_GUARDED_DOMAINS.has(canonicalDomain)) {
    return { passed: true, widenedToolIds: input.runExposedToolIds, missingFamily: [] };
  }

  const allowed = new Set(input.allowedToolIds);
  const requiredFamily = (DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []).filter((toolId) => allowed.has(toolId));
  if (requiredFamily.length === 0) {
    return { passed: true, widenedToolIds: input.runExposedToolIds, missingFamily: [] };
  }

  const exposed = new Set(input.runExposedToolIds);
  const familyCovered = requiredFamily.some((toolId) => exposed.has(toolId));
  if (familyCovered) {
    return { passed: true, widenedToolIds: input.runExposedToolIds, missingFamily: [] };
  }

  return {
    passed: false,
    widenedToolIds: uniq([...input.runExposedToolIds, ...requiredFamily]),
    missingFamily: requiredFamily,
  };
};

const chooseSuggestedAllowed = (
  allowed: Set<string>,
  suggestedToolIds?: string[],
  suggestedDomains?: Array<string | null | undefined>,
): string[] => {
  const resolved: string[] = [];

  for (const rawToolId of suggestedToolIds ?? []) {
    const normalizedToolId = rawToolId.trim();
    if (!normalizedToolId) continue;
    const canonical = ALIAS_TO_CANONICAL_ID[normalizedToolId]
      ?? ALIAS_TO_CANONICAL_ID[normalizedToolId.toLowerCase()]
      ?? ALIAS_TO_CANONICAL_ID[normalizedToolId.replace(/([a-z0-9])([A-Z])/g, '$1-$2')]
      ?? ALIAS_TO_CANONICAL_ID[normalizedToolId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()];
    if (canonical && allowed.has(canonical)) {
      resolved.push(canonical);
    }
  }

  for (const rawDomain of suggestedDomains ?? []) {
    const normalizedDomain = rawDomain?.trim();
    if (!normalizedDomain) continue;
    const canonicalDomain = DOMAIN_ALIASES[normalizedDomain]
      ?? DOMAIN_ALIASES[normalizedDomain.toLowerCase()];
    if (!canonicalDomain) continue;
    for (const toolId of DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []) {
      if (allowed.has(toolId)) {
        resolved.push(toolId);
      }
    }
  }

  return uniq(resolved);
};

const domainsConflict = (left?: string | null, right?: string | null): boolean => {
  const normalizedLeft = left?.trim();
  const normalizedRight = right?.trim();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft !== normalizedRight;
};

const isAffirmationFollowUp = (message: string): boolean =>
  /^(yes|yeah|yep|ok|okay|sure|go ahead|continue|proceed|try again|do it)\b/.test(asLower(message));

const summarizeLearnedPriors = (priors: ToolRoutingPriorMatch[]): string[] =>
  priors.slice(0, 3).map((prior) =>
    `${prior.toolId} via ${prior.matchedBy} (${prior.scope}, confidence ${prior.confidenceScore.toFixed(2)})`);

const resolveSelectionReasonOperation = (input: {
  childRouteOperationType?: string | null;
  inferredOperationClass: OperationClass;
}): OperationClass => {
  const childRouteOperation = input.childRouteOperationType
    ? toNarrowOperationClass(input.childRouteOperationType)
    : null;
  return (childRouteOperation as OperationClass | null) ?? input.inferredOperationClass;
};

const canBypassPlannerWithLearnedPrior = (input: {
  prior?: ToolRoutingPriorMatch;
  inferredOperationClass: OperationClass;
  inferredDomain: IntentDomain;
  primaryBundle: string[];
  latestUserMessage: string;
  allowContextOnlyAnswer?: boolean;
}): boolean => {
  const prior = input.prior;
  if (!prior) return false;
  if (input.allowContextOnlyAnswer && prior.toolId === 'document-ocr-read') {
    return false;
  }
  if (input.inferredOperationClass !== 'read' && input.inferredOperationClass !== 'inspect' && input.inferredOperationClass !== 'search') {
    return false;
  }
  if (['unknown', 'lark'].includes(input.inferredDomain)) {
    return false;
  }
  if (/\b(send|email|create|make|update|delete|edit|assign|approve)\b/.test(asLower(input.latestUserMessage))) {
    return false;
  }
  if (!input.primaryBundle.includes(prior.toolId)) {
    return false;
  }
  return prior.confidenceScore >= 0.88
    && (prior.matchedBy === 'exact_canonical' || prior.matchedBy === 'thread_continuation' || prior.matchedBy === 'base_intent');
};

const inferOperationClass = (
  message: string,
  supplementarySignals?: {
    normalizedIntent?: string | null;
    plannerChosenOperationClass?: string | null;
    childRouterOperationType?: string | null;
  },
): OperationClass => {
  return toNarrowOperationClass(classifyIntent(message, supplementarySignals)) as OperationClass;
};

const isVisualInspectionRequest = (message: string): boolean =>
  /\b(image|img|screenshot|photo|picture|gif|what do you see|what's in this|what is in this|what is shown|what's shown|describe this|check this)\b/.test(asLower(message));

const requiresExplicitExtraction = (message: string): boolean =>
  /\b(ocr|extract text|exact text|read the text|what does it say|copy the text|transcribe|verbatim|all the text|full text)\b/.test(asLower(message));

const EXPLICIT_SOURCE_SCOPE = /\b(?:in|from|inside|within|under)\s+(?:zoho\s+books|books|zoho\s+crm|crm|files|docs|documents|attachments|workspace|history|memory|chat|conversation)\b|\b(?:on|from|search)\s+(?:the\s+)?(?:web|internet|online)\b/;
const GENERIC_LOOKUP_VERBS = /\b(search|find|look up|lookup|look for|check|trace|get details|tell me about|show me|who is|what is)\b/;
const GENERIC_ENTITY_SUFFIX = /\b(llc|inc|ltd|limited|corp|corporation|company|private limited|pvt ltd|gmbh|plc)\b/;
const INTERNAL_SYSTEM_CUES = /\b(invoice|invoices|statement|statements|payment|payments|overdue|balance|balances|vendor|vendors|customer|customers|contact|contacts|deal|deals|account|accounts|lead|leads)\b/;
const LOOKUP_NOISE = /\b(please|plz|kindly|search|find|look up|lookup|look for|check|show|me|for|about|details|info|information)\b/g;

const isUncertainEntityLookup = (message: string): boolean => {
  const text = asLower(message);
  if (!text || EXPLICIT_SOURCE_SCOPE.test(text) || INTERNAL_SYSTEM_CUES.test(text)) {
    return false;
  }
  if (!GENERIC_LOOKUP_VERBS.test(text)) {
    return false;
  }
  const normalizedEntityCandidate = text.replace(LOOKUP_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const tokenCount = normalizedEntityCandidate.length > 0
    ? normalizedEntityCandidate.split(/\s+/).filter(Boolean).length
    : 0;
  return GENERIC_ENTITY_SUFFIX.test(text) || (tokenCount >= 2 && tokenCount <= 8);
};

const requiresContextSearch = (message: string): boolean => {
  const text = asLower(message);
  if (isUncertainEntityLookup(message)) {
    return true;
  }
  if (/\b(context search|search history|search memory|conversation history|past chats?|past files?)\b/.test(text)) {
    return true;
  }
  if (
    /\b(search|find|look up|lookup|look for|find out)\b/.test(text)
    && /\b(email|mail|contact|contacts|phone|number|address|person|people|teammate|employee|coworker|colleague)\b/.test(text)
  ) {
    return true;
  }
  if (/\b(remember|previous|before|last time|we talked about|we discussed|that file|that document|that csv|earlier)\b/.test(text)) {
    return true;
  }
  return /\b(csv|spreadsheet|sheet|file|files|document|documents|pdf|uploaded|assignment)\b/.test(text)
    && /\b(search|find|look up|look in|what did you find|history|memory|discussed|earlier|before)\b/.test(text)
    && !requiresExplicitExtraction(text);
};

const canAnswerFromGroundedContext = (input: {
  artifactMode?: ArtifactMode;
  hasActiveArtifacts: boolean;
  latestUserMessage: string;
}): boolean =>
  input.hasActiveArtifacts
  && (input.artifactMode ?? 'none') === 'image_only'
  && isVisualInspectionRequest(input.latestUserMessage)
  && !requiresExplicitExtraction(input.latestUserMessage);

const inferIntentDomain = (input: {
  message: string;
  childRoute?: ChildRouteHints;
  hasWorkspace: boolean;
  hasArtifacts: boolean;
}): IntentDomain => {
  return normalizeToolRoutingIntent({
    latestUserMessage: input.message,
    childRoute: input.childRoute,
    hasWorkspace: input.hasWorkspace,
    hasArtifacts: input.hasArtifacts,
  }).domain;
};

const buildPrimaryBundle = (input: {
  allowed: Set<string>;
  domain: IntentDomain;
  operationClass: OperationClass;
  hasArtifacts: boolean;
  artifactMode?: ArtifactMode;
  latestUserMessage: string;
  childRoute?: ChildRouteHints;
  allowContextOnlyAnswer?: boolean;
}): string[] => {
  const lowerMessage = asLower(input.latestUserMessage);
  const normalizedIntent = asLower(input.childRoute?.normalizedIntent);
  const suggestedActions = (input.childRoute?.suggestedActions ?? []).map((value) => asLower(value)).join('\n');
  const larkHintText = `${lowerMessage}\n${normalizedIntent}\n${suggestedActions}`;
  if (requiresExplicitExtraction(input.latestUserMessage)) {
    return chooseFirstAllowed(input.allowed, ['document-ocr-read']);
  }
  if (requiresContextSearch(input.latestUserMessage)) {
    return buildAllowedDomainFamily(input.allowed, 'context_search');
  }
  switch (input.domain) {
    case 'zoho_books':
      return buildAllowedDomainFamily(input.allowed, 'zoho_books');
    case 'zoho_crm':
      return buildAllowedDomainFamily(input.allowed, 'zoho_crm');
    case 'gmail':
      return buildAllowedDomainFamily(input.allowed, 'gmail');
    case 'google_drive':
      return buildAllowedDomainFamily(input.allowed, 'google_drive');
    case 'google_calendar':
      return buildAllowedDomainFamily(input.allowed, 'google_calendar');
    case 'lark_base':
      return buildAllowedDomainFamily(input.allowed, 'lark_base');
    case 'lark_task':
      return buildAllowedDomainFamily(input.allowed, 'lark_task');
    case 'lark_message':
      return buildAllowedDomainFamily(input.allowed, 'lark_message');
    case 'lark_doc':
      return buildAllowedDomainFamily(input.allowed, 'lark_doc');
    case 'lark_calendar':
      return buildAllowedDomainFamily(input.allowed, 'lark_calendar');
    case 'lark_approval':
      return buildAllowedDomainFamily(input.allowed, 'lark_approval');
    case 'lark_meeting':
      return buildAllowedDomainFamily(input.allowed, 'lark_meeting');
    case 'lark':
      if (/\b(dm|direct message|message|ping)\b/.test(larkHintText)) {
        return buildAllowedDomainFamily(input.allowed, 'lark_message');
      }
      if (/\b(base|bitable|table|tables|record|records|field|fields|view|views)\b/.test(larkHintText)) {
        return buildAllowedDomainFamily(input.allowed, 'lark_base');
      }
      if (/\b(task|tasks|assignee|assign|due date|todo)\b/.test(larkHintText)) {
        return buildAllowedDomainFamily(input.allowed, 'lark_task');
      }
      return uniq([
        ...buildAllowedDomainFamily(input.allowed, 'lark_base'),
        ...buildAllowedDomainFamily(input.allowed, 'lark_task'),
      ]);
    case 'context_search':
      return buildAllowedDomainFamily(input.allowed, 'context_search');
    case 'skill':
      return buildAllowedDomainFamily(input.allowed, 'context_search');
    case 'workspace':
      return chooseFirstAllowed(input.allowed, ['coding']);
    case 'document_inspection':
      if (input.allowContextOnlyAnswer) {
        return [];
      }
      return buildAllowedDomainFamily(input.allowed, 'document_inspection');
    case 'web_search':
      return buildAllowedDomainFamily(input.allowed, 'context_search');
    default:
      return [];
  }
};

const buildFallbackBundle = (input: {
  allowed: Set<string>;
  domain: IntentDomain;
  hasArtifacts: boolean;
  artifactMode?: ArtifactMode;
  latestUserMessage: string;
  allowContextOnlyAnswer?: boolean;
}): string[] => {
  const skipArtifactInspectionTools = Boolean(input.allowContextOnlyAnswer);
  if (input.domain === 'unknown') {
    return uniq([
      ...(requiresContextSearch(input.latestUserMessage)
        ? chooseFirstAllowed(input.allowed, ['context-search'])
        : []),
      ...(input.hasArtifacts && !skipArtifactInspectionTools && requiresExplicitExtraction(input.latestUserMessage)
        ? chooseFirstAllowed(input.allowed, ['document-ocr-read'])
        : []),
      ...chooseFirstAllowed(input.allowed, ['context-search']),
    ]).slice(0, 2);
  }
  if (input.domain === 'document_inspection' && !skipArtifactInspectionTools) {
    return chooseFirstAllowed(input.allowed, ['document-ocr-read']);
  }
  return [];
};

const describeTools = (toolIds: string[]): string =>
  toolIds.map((toolId) => {
    const def = TOOL_REGISTRY_MAP.get(toolId);
    return `- ${toolId}: ${def?.description ?? 'No description available.'}`;
  }).join('\n');

const buildPlannerPrompt = (input: {
  latestUserMessage: string;
  selectionReason: string;
  inferredDomain: IntentDomain;
  inferredOperationClass: OperationClass;
  artifactMode?: ArtifactMode;
  runExposedToolIds: string[];
  childRoute?: ChildRouteHints;
  learnedPriorSummary?: string[];
  allowContextOnlyAnswer?: boolean;
}): string => [
  'Choose the best run-scoped tool subset for this request.',
  'Return JSON only.',
  'Do not invent tools outside the provided run-exposed set.',
  'Prefer source-of-truth business tools over generic helpers when the user asked for live records.',
  'If the request cannot be solved safely with the current run-exposed set, ask for clarification instead of broadening tools.',
  `Latest user message: ${input.latestUserMessage}`,
  `Inferred domain: ${input.inferredDomain}`,
  `Inferred operation class: ${input.inferredOperationClass}`,
  `Artifact mode: ${input.artifactMode ?? 'none'}`,
  `Selection reason: ${input.selectionReason}`,
  input.childRoute?.normalizedIntent ? `Child normalized intent: ${input.childRoute.normalizedIntent}` : '',
  input.childRoute?.reason ? `Child route reason: ${input.childRoute.reason}` : '',
  input.learnedPriorSummary && input.learnedPriorSummary.length > 0
    ? `Learned routing priors:\n${input.learnedPriorSummary.map((entry) => `- ${entry}`).join('\n')}`
    : '',
  'Run-exposed tool ids:',
  describeTools(input.runExposedToolIds),
  'Planner output schema:',
  '{"answerFromContextOnly":false, "chosenToolId":"...", "chosenOperationClass":"read|write|send|inspect|schedule|search", "candidateToolIds":["..."], "sourceOfTruthReason":"...", "missingFields":["..."], "shouldAskClarification":false, "clarificationQuestion":"..."}',
  'If a live Zoho Books request mentions invoices, estimates, bills, payments, or Zoho Books, choose Zoho Books tools over cached context or generic search.',
  input.allowContextOnlyAnswer
    ? 'If current grounded artifacts already provide multimodal image context for this request, set "answerFromContextOnly": true and do not choose document-ocr-read. Use OCR only when the user explicitly asked for exact extracted text.'
    : (input.artifactMode ?? 'none') === 'image_only'
      ? 'If active artifacts are images and the user asks what they show, prefer answering from multimodal image context. Do not choose document-ocr-read unless the user explicitly asked for exact extracted text.'
      : 'For internal retrieval, prefer context-search. Use document-ocr-read only for exact extraction or OCR.',
].filter(Boolean).join('\n');

const validatePlannerDecision = (input: {
  decision: z.infer<typeof plannerDecisionSchema>;
  selection: RunScopedToolSelection;
  coreToolIds: string[];
}): RunScopedToolSelection => {
  const exposed = new Set(input.selection.runExposedToolIds);
  if (input.decision.shouldAskClarification) {
    if (
      input.selection.runExposedToolIds.length > 0 &&
      !CLARIFICATION_ALLOWED_ONLY_WHEN_DOMAIN_UNKNOWN
        .includes((input.selection.inferredDomain ?? 'unknown') as (typeof CLARIFICATION_ALLOWED_ONLY_WHEN_DOMAIN_UNKNOWN)[number])
    ) {
      return {
        ...input.selection,
        clarificationQuestion: undefined,
        validationFailureReason: null,
        plannerChosenOperationClass: input.selection.inferredOperationClass,
      };
    }
    return {
      ...input.selection,
      clarificationQuestion: input.decision.clarificationQuestion?.trim() || 'I need one more detail before I can choose the right tool for this request.',
      validationFailureReason: 'planner_requested_clarification',
    };
  }
  if (input.decision.answerFromContextOnly) {
    return {
      ...input.selection,
      runExposedToolIds: uniq(input.coreToolIds),
      plannerCandidateToolIds: uniq(input.coreToolIds),
      plannerChosenToolId: undefined,
      plannerChosenOperationClass: input.selection.inferredOperationClass,
    };
  }
  const chosenToolId = input.decision.chosenToolId?.trim();
  if (!chosenToolId || !exposed.has(chosenToolId)) {
    logger.warn('vercel.tool_selection.planner.validation_failed', {
      chosenToolId: chosenToolId ?? null,
      runExposedToolIds: input.selection.runExposedToolIds,
      validationFailureReason: 'planner_tool_outside_run_scope',
    });
    return {
      ...input.selection,
      plannerChosenToolId: undefined,
      plannerChosenOperationClass: input.selection.inferredOperationClass,
      validationFailureReason: 'planner_tool_outside_run_scope',
    };
  }
  const candidateToolIds = uniq(input.selection.runExposedToolIds);
  return {
    ...input.selection,
    plannerCandidateToolIds: candidateToolIds,
    plannerChosenToolId: chosenToolId,
    plannerChosenOperationClass: input.decision.chosenOperationClass ?? input.selection.inferredOperationClass,
  };
};

export const resolveRunScopedToolSelection = async (input: {
  companyId: string;
  channel?: RuntimeChannel;
  userId?: string | null;
  threadId?: string;
  conversationKey?: string;
  latestUserMessage: string;
  enrichedQueryText?: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  workspaceAvailable: boolean;
  hasActiveArtifacts: boolean;
  artifactMode?: ArtifactMode;
  childRoute?: ChildRouteHints;
  pinnedToolIds?: string[];
}): Promise<RunScopedToolSelection> => {
  const queryTextForInference = input.enrichedQueryText?.trim() || input.latestUserMessage;
  const allowed = new Set(input.allowedToolIds);
  const pinnedAllowedToolIds = uniq((input.pinnedToolIds ?? []).filter((toolId) => allowed.has(toolId)));
  const artifactMode = input.artifactMode ?? 'none';
  const allowContextOnlyAnswer = canAnswerFromGroundedContext({
    artifactMode,
    hasActiveArtifacts: input.hasActiveArtifacts,
    latestUserMessage: queryTextForInference,
  });
  const exposeArtifactTools =
    input.hasActiveArtifacts
    && !allowContextOnlyAnswer;
  const channel = input.channel ?? 'desktop';
  const coreToolIds = buildChannelBaseline({
    channel,
    allowed,
    workspaceAvailable: input.workspaceAvailable,
    exposeArtifactTools,
  });

  const inferredOperationClass = inferOperationClass(queryTextForInference, {
    normalizedIntent: input.childRoute?.normalizedIntent,
    childRouterOperationType: input.childRoute?.operationType,
  });
  const inferredDomain = inferIntentDomain({
    message: queryTextForInference,
    childRoute: input.childRoute,
    hasWorkspace: input.workspaceAvailable,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const suggestedAllowedToolIds = chooseSuggestedAllowed(
    allowed,
    input.childRoute?.suggestedToolIds,
    (input.childRoute?.confidence ?? 1) >= 0.7 ? [input.childRoute?.domain] : [],
  )
    .filter((toolId) => !(allowContextOnlyAnswer && toolId === 'document-ocr-read'));
  const { priors: learnedPriors } = await memoryService.findRoutingPriors({
    companyId: input.companyId,
    userId: input.userId,
    threadId: input.threadId,
    conversationKey: input.conversationKey,
    allowedToolIds: input.allowedToolIds,
    latestUserMessage: queryTextForInference,
    childRoute: input.childRoute,
    hasWorkspace: input.workspaceAvailable,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const learnedToolIds = uniq(learnedPriors
    .filter((prior) => !(allowContextOnlyAnswer && prior.toolId === 'document-ocr-read'))
    .map((prior) => prior.toolId));
  const heuristicPrimaryBundle = buildPrimaryBundle({
    allowed,
    domain: inferredDomain,
    operationClass: inferredOperationClass,
    hasArtifacts: input.hasActiveArtifacts,
    artifactMode,
    latestUserMessage: queryTextForInference,
    childRoute: input.childRoute,
    allowContextOnlyAnswer,
  });
  // ROUTING PRIORITY — do not change order:
  // 1. Child router suggestions (alias-normalized) — LLM is primary authority
  // 2. Domain expansion from child router domain output
  // 3. Learned priors
  // 4. Keyword/heuristic fallback — only if 1 and 2 both return empty
  // 5. Global always-on tools (GLOBAL_ALWAYS_ON_IDS) — always appended
  const authoritativeChildRoute = (input.childRoute?.confidence ?? 1) >= 0.7;
  const primaryDomainFamily = buildAllowedDomainFamily(allowed, inferredDomain);
  const preferInferredDomainOverChildRoute =
    inferredDomain === 'zoho_books'
    || inferredDomain === 'zoho_crm';
  const childRouteDomainFamily = authoritativeChildRoute
    && !(
      preferInferredDomainOverChildRoute
      && domainsConflict(input.childRoute?.domain, inferredDomain)
    )
    ? buildAllowedDomainFamily(allowed, input.childRoute?.domain)
    : [];
  const filteredSuggestedAllowedToolIds = preferInferredDomainOverChildRoute
    && domainsConflict(input.childRoute?.domain, inferredDomain)
    ? suggestedAllowedToolIds.filter((toolId) => primaryDomainFamily.includes(toolId))
    : suggestedAllowedToolIds;
  const alternateDomainFamilies = uniq([
    ...childRouteDomainFamily,
  ]);
  const childRouterPrimaryBundle = uniq([
    ...childRouteDomainFamily,
    ...filteredSuggestedAllowedToolIds,
    ...pinnedAllowedToolIds,
  ]);
  const primaryBundle = childRouterPrimaryBundle.length > 0
    ? uniq([
      ...childRouterPrimaryBundle,
      ...primaryDomainFamily,
      ...learnedToolIds,
      ...heuristicPrimaryBundle,
    ])
    : uniq([
      ...primaryDomainFamily,
      ...learnedToolIds,
      ...pinnedAllowedToolIds,
      ...heuristicPrimaryBundle,
    ]);
  const fallbackBundle = buildFallbackBundle({
    allowed,
    domain: inferredDomain,
    hasArtifacts: input.hasActiveArtifacts,
    artifactMode,
    latestUserMessage: queryTextForInference,
    allowContextOnlyAnswer,
  });
  const learnedSummary = summarizeLearnedPriors(learnedPriors);
  const selectionReasonOperation = resolveSelectionReasonOperation({
    childRouteOperationType: input.childRoute?.operationType,
    inferredOperationClass,
  });
  const selectionReason = primaryBundle.length > 0
    ? `Primary domain ${inferredDomain} with operation ${selectionReasonOperation}.${preferInferredDomainOverChildRoute && domainsConflict(input.childRoute?.domain, inferredDomain) ? ` Overrode conflicting child-route domain ${input.childRoute?.domain} in favor of source-of-truth finance routing.` : ''}${learnedSummary.length > 0 ? ` Learned routing priors favored ${learnedSummary.join('; ')}.` : ''}${pinnedAllowedToolIds.length > 0 ? ` Pinned required tools: ${pinnedAllowedToolIds.join(', ')}.` : ''}`
    : allowContextOnlyAnswer
      ? 'Current grounded multimodal context appears sufficient to answer directly without document extraction tools.'
      : `No safe primary domain could be resolved from the latest message; preserving only core and fallback tools.${pinnedAllowedToolIds.length > 0 ? ` Pinned required tools: ${pinnedAllowedToolIds.join(', ')}.` : ''}`;

  const initialSelection: RunScopedToolSelection = {
    runExposedToolIds: uniq([...coreToolIds, ...primaryBundle, ...alternateDomainFamilies, ...fallbackBundle]),
    plannerCandidateToolIds: uniq([...coreToolIds, ...primaryBundle, ...alternateDomainFamilies]),
    selectionReason,
    selectionFallbackNeeded: primaryBundle.length === 0 && fallbackBundle.length > 0,
    inferredDomain,
    inferredOperationClass,
  };

  if (primaryBundle.length === 0 && fallbackBundle.length === 0) {
    if (allowContextOnlyAnswer) {
      return initialSelection;
    }
    return {
      ...initialSelection,
      clarificationQuestion: 'I need one more detail before I can choose the right tool for this request.',
      validationFailureReason: 'no_safe_primary_bundle',
    };
  }

  const strongestPrior = learnedPriors[0];
  if (canBypassPlannerWithLearnedPrior({
    prior: strongestPrior,
    inferredOperationClass,
    inferredDomain,
    primaryBundle,
    latestUserMessage: queryTextForInference,
    allowContextOnlyAnswer,
  })) {
    return {
      ...initialSelection,
      plannerChosenToolId: strongestPrior?.toolId,
      plannerChosenOperationClass: strongestPrior?.operationClass ?? inferredOperationClass,
    };
  }

  try {
    const model = await resolveVercelChildRouterModel();
    const result = await generateText({
      model: model.model,
      system: 'Return one valid JSON object only. No markdown, no prose, no code fences.',
      prompt: buildPlannerPrompt({
        latestUserMessage: input.latestUserMessage,
        selectionReason,
        inferredDomain,
        inferredOperationClass,
        artifactMode,
        runExposedToolIds: initialSelection.runExposedToolIds,
        childRoute: input.childRoute,
        learnedPriorSummary: learnedSummary,
        allowContextOnlyAnswer,
      }),
      temperature: 0,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: model.thinkingLevel,
          },
        },
      },
    });
    const rawJson = extractFirstJsonObject(result.text) ?? result.text.trim();
    const decision = plannerDecisionSchema.parse(JSON.parse(rawJson));
    return validatePlannerDecision({
      decision,
      selection: initialSelection,
      coreToolIds,
    });
  } catch (error) {
    logger.warn('vercel.tool_selection.planner.failed', {
      error: error instanceof Error ? error.message : 'unknown',
      inferredDomain,
      inferredOperationClass,
    });
    return initialSelection;
  }
};
