import { generateText } from 'ai';
import { z } from 'zod';

import { memoryService, normalizeToolRoutingIntent, type ToolRoutingDomain, type ToolRoutingOperationClass, type ToolRoutingPriorMatch } from '../../memory';
import { logger } from '../../../utils/logger';
import { resolveCanonicalIntent, toNarrowOperationClass, type CanonicalIntent } from '../intent/canonical-intent';
import { resolveVercelChildRouterModel } from '../vercel/model-factory';
import { ALIAS_TO_CANONICAL_ID, DOMAIN_ALIASES, DOMAIN_TO_TOOL_IDS, TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import type { ToolActionGroup } from '../../tools/tool-action-groups';
import { getCachedSearchIntent, type SearchIntent } from '../search-intent-classifier';
import type { VercelRuntimeRequestContext } from '../vercel/types';

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

const GLOBAL_ALWAYS_ON_IDS = ['contextSearch'] as const;
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
const WORKSPACE_GLOBAL_IDS = ['devTools'] as const;
const ARTIFACT_GLOBAL_IDS = ['documentRead'] as const;
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
  const canonicalAllowed = new Set(
    Array.from(allowed).map((toolId) =>
      ALIAS_TO_CANONICAL_ID[toolId]
      ?? ALIAS_TO_CANONICAL_ID[toolId.toLowerCase()]
      ?? toolId),
  );
  const activeToolIds = (DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []).filter((toolId) =>
    canonicalAllowed.has(toolId) && TOOL_REGISTRY_MAP.get(toolId)?.deprecated !== true);
  if (activeToolIds.length > 0) {
    return uniq(activeToolIds);
  }
  return uniq((DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []).filter((toolId) => canonicalAllowed.has(toolId)));
};

const buildRegistryDomainFamily = (domain?: string | null): string[] => {
  const normalizedDomain = domain?.trim();
  if (!normalizedDomain) return [];
  const canonicalDomain = DOMAIN_ALIASES[normalizedDomain] ?? DOMAIN_ALIASES[normalizedDomain.toLowerCase()];
  if (!canonicalDomain) return [];
  const activeToolIds = (DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []).filter((toolId) =>
    TOOL_REGISTRY_MAP.get(toolId)?.deprecated !== true);
  if (activeToolIds.length > 0) {
    return uniq(activeToolIds);
  }
  return uniq(DOMAIN_TO_TOOL_IDS[canonicalDomain] ?? []);
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

const buildBroadAllowedToolSurface = (allowed: Set<string>): string[] => {
  const active = Array.from(allowed).filter((toolId) => TOOL_REGISTRY_MAP.get(toolId)?.deprecated !== true);
  if (active.length > 0) {
    return uniq(active);
  }
  return uniq(Array.from(allowed));
};

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

const isRetrySendFollowUp = (message: string): boolean => {
  const text = asLower(message);
  return (
    /\b(try again|retry|again|send again|sending .* again)\b/.test(text)
    && /\b(send|mail|email|gmail)\b/.test(text)
  );
};

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
  if (input.allowContextOnlyAnswer && prior.toolId === 'documentRead') {
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
  canonicalIntent: CanonicalIntent,
): OperationClass => {
  return toNarrowOperationClass(canonicalIntent) as OperationClass;
};

const isVisualInspectionRequest = (message: string): boolean =>
  /\b(image|img|screenshot|photo|picture|gif|what do you see|what's in this|what is in this|what is shown|what's shown|describe this|check this)\b/.test(asLower(message));

const requiresExplicitExtraction = (message: string): boolean =>
  /\b(ocr|extract text|exact text|read the text|what does it say|copy the text|transcribe|verbatim|all the text|full text)\b/.test(asLower(message));

const GENERIC_LOOKUP_VERBS = /\b(search|find|look up|lookup|look for|check|trace|get details|tell me about|show me|who is|what is)\b/;
const GENERIC_ENTITY_SUFFIX = /\b(llc|inc|ltd|limited|corp|corporation|company|private limited|pvt ltd|gmbh|plc)\b/;
const INTERNAL_SYSTEM_CUES = /\b(invoice|invoices|statement|statements|payment|payments|overdue|balance|balances|vendor|vendors|customer|customers|contact|contacts|deal|deals|account|accounts|lead|leads)\b/;
const LOOKUP_NOISE = /\b(please|plz|kindly|search|find|look up|lookup|look for|check|show|me|for|about|details|info|information)\b/g;
const REFERENCED_ENTITY_LOOKUP_RE = /\[referenced message\][\s\S]*\b(search|find|look up|lookup|look for|find out)\b[\s\S]*\b(llc|inc|ltd|limited|corp|corporation|company|private limited|pvt ltd|gmbh|plc)\b/i;

const isUncertainEntityLookup = (message: string): boolean => {
  const text = asLower(message);
  if (!text || INTERNAL_SYSTEM_CUES.test(text)) {
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
  if (REFERENCED_ENTITY_LOOKUP_RE.test(message)) {
    return false;
  }
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

const isPersonContactLookup = (input: {
  searchIntent: SearchIntent;
  latestUserMessage: string;
}): boolean =>
  input.searchIntent.queryType === 'person_entity'
  && (
    input.searchIntent.lookupTarget === 'contact_info'
    || /\b(contact|contact info|email|mail|phone|mobile|number|address)\b/.test(asLower(input.latestUserMessage))
  );

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
  canonicalIntent: CanonicalIntent;
  searchIntent: SearchIntent;
  childRoute?: ChildRouteHints;
  hasWorkspace: boolean;
  hasArtifacts: boolean;
}): IntentDomain => {
  if (isRetrySendFollowUp(input.message) && /\b(gmail|email|mail)\b/.test(asLower(input.message))) {
    return 'gmail';
  }
  if (input.searchIntent.sourceHint === 'books') {
    return 'zoho_books';
  }
  if (input.searchIntent.sourceHint === 'crm') {
    return 'zoho_crm';
  }
  if (['files', 'web', 'history', 'lark'].includes(input.searchIntent.sourceHint ?? '')) {
    return 'context_search';
  }
  if (isPersonContactLookup({
    searchIntent: input.searchIntent,
    latestUserMessage: input.message,
  })) {
    return 'context_search';
  }
  if (input.searchIntent.queryType === 'company_entity') {
    return 'zoho_books';
  }
  if (input.searchIntent.queryType === 'financial_record') {
    return 'zoho_books';
  }
  return normalizeToolRoutingIntent({
    latestUserMessage: input.message,
    childRoute: input.childRoute,
    hasWorkspace: input.hasWorkspace,
    hasArtifacts: input.hasArtifacts,
    canonicalIntent: input.canonicalIntent,
  }).domain;
};

const buildPrimaryBundle = (input: {
  allowed: Set<string>;
  domain: IntentDomain;
  operationClass: OperationClass;
  hasArtifacts: boolean;
  artifactMode?: ArtifactMode;
  latestUserMessage: string;
  searchIntent: SearchIntent;
  childRoute?: ChildRouteHints;
  allowContextOnlyAnswer?: boolean;
}): string[] => {
  const lowerMessage = asLower(input.latestUserMessage);
  const normalizedIntent = asLower(input.childRoute?.normalizedIntent);
  const suggestedActions = (input.childRoute?.suggestedActions ?? []).map((value) => asLower(value)).join('\n');
  const larkHintText = `${lowerMessage}\n${normalizedIntent}\n${suggestedActions}`;
  if (isPersonContactLookup({
    searchIntent: input.searchIntent,
    latestUserMessage: input.latestUserMessage,
  })) {
    return uniq([
      ...buildAllowedDomainFamily(input.allowed, 'context_search'),
      ...((input.searchIntent.sourceHint === 'lark' || /\b(lark|directory)\b/.test(larkHintText))
        ? buildAllowedDomainFamily(input.allowed, 'lark_message')
        : []),
    ]);
  }
  if (input.searchIntent.queryType === 'company_entity') {
    return uniq([
      ...buildAllowedDomainFamily(input.allowed, 'zoho_books'),
      ...buildAllowedDomainFamily(input.allowed, 'zoho_crm'),
      ...buildAllowedDomainFamily(input.allowed, 'context_search'),
    ]);
  }
  if (requiresExplicitExtraction(input.latestUserMessage)) {
    return chooseFirstAllowed(input.allowed, ['documentRead']);
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
      {
        const gmailFamily = buildAllowedDomainFamily(input.allowed, 'gmail');
        if (gmailFamily.length > 0) {
          return uniq([
            ...gmailFamily,
            ...(input.allowed.has('google-gmail') ? ['google-gmail'] : []),
          ]);
        }
        logger.warn('tool_selection.domain_tool_missing', {
          inferredDomain: input.domain,
          expectedTool: 'google-gmail',
          allowedToolIds: [...input.allowed],
        });
        return uniq([
          ...buildRegistryDomainFamily('gmail'),
          ...(input.allowed.has('google-gmail') ? ['google-gmail'] : []),
        ]);
      }
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
      return chooseFirstAllowed(input.allowed, ['devTools']);
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
  searchIntent: SearchIntent;
}): string[] => {
  const skipArtifactInspectionTools = Boolean(input.allowContextOnlyAnswer);
  if (isPersonContactLookup({
    searchIntent: input.searchIntent,
    latestUserMessage: input.latestUserMessage,
  })) {
    return chooseFirstAllowed(input.allowed, ['contextSearch']);
  }
  if (input.domain === 'unknown') {
      return uniq([
      ...((input.searchIntent.queryType === 'company_entity' || requiresContextSearch(input.latestUserMessage))
        ? chooseFirstAllowed(input.allowed, ['contextSearch'])
        : []),
      ...(input.hasArtifacts && !skipArtifactInspectionTools && requiresExplicitExtraction(input.latestUserMessage)
        ? chooseFirstAllowed(input.allowed, ['documentRead'])
        : []),
      ...chooseFirstAllowed(input.allowed, ['contextSearch']),
    ]).slice(0, 2);
  }
  if (input.domain === 'document_inspection' && !skipArtifactInspectionTools) {
    return chooseFirstAllowed(input.allowed, ['documentRead']);
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
    ? 'If current grounded artifacts already provide multimodal image context for this request, set "answerFromContextOnly": true and do not choose documentRead. Use OCR only when the user explicitly asked for exact extracted text.'
    : (input.artifactMode ?? 'none') === 'image_only'
      ? 'If active artifacts are images and the user asks what they show, prefer answering from multimodal image context. Do not choose documentRead unless the user explicitly asked for exact extracted text.'
      : 'For internal retrieval, prefer contextSearch. Use documentRead only for exact extraction or OCR.',
].filter(Boolean).join('\n');

const validatePlannerDecision = (input: {
  decision: z.infer<typeof plannerDecisionSchema>;
  selection: RunScopedToolSelection;
  coreToolIds: string[];
  allowedToolIds: string[];
}): RunScopedToolSelection => {
  const allowed = new Set(input.allowedToolIds);
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
  if (!chosenToolId || !allowed.has(chosenToolId)) {
    logger.warn('vercel.tool_selection.planner.validation_failed', {
      chosenToolId: chosenToolId ?? null,
      allowedToolIds: input.allowedToolIds,
      validationFailureReason: 'planner_tool_outside_permission_scope',
    });
    return {
      ...input.selection,
      plannerChosenToolId: undefined,
      plannerChosenOperationClass: input.selection.inferredOperationClass,
      validationFailureReason: 'planner_tool_outside_permission_scope',
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
  requestContext?: VercelRuntimeRequestContext;
}): Promise<RunScopedToolSelection> => {
  const queryTextForInference = input.enrichedQueryText?.trim() || input.latestUserMessage;
  const searchIntent = await getCachedSearchIntent({
    runtime: input.requestContext ?? null,
    message: queryTextForInference,
  });
  const canonicalIntent = await resolveCanonicalIntent({
    runtime: input.requestContext ?? null,
    message: queryTextForInference,
    supplementarySignals: {
      normalizedIntent: input.childRoute?.normalizedIntent,
      childRouterDomain: input.childRoute?.domain,
      childRouterOperationType: input.childRoute?.operationType,
    },
  });
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

  const inferredOperationClass = inferOperationClass(canonicalIntent);
  const inferredDomain = inferIntentDomain({
    message: queryTextForInference,
    canonicalIntent,
    searchIntent,
    childRoute: input.childRoute,
    hasWorkspace: input.workspaceAvailable,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const suggestedAllowedToolIds = chooseSuggestedAllowed(
    allowed,
    input.childRoute?.suggestedToolIds,
    (input.childRoute?.confidence ?? 1) >= 0.7 ? [input.childRoute?.domain] : [],
  )
    .filter((toolId) => !(allowContextOnlyAnswer && toolId === 'documentRead'));
  const { priors: rawLearnedPriors } = await memoryService.findRoutingPriors({
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
  const learnedPriors = rawLearnedPriors.map((prior) => ({
    ...prior,
    toolId: ALIAS_TO_CANONICAL_ID[prior.toolId] ?? prior.toolId,
  }));
  const learnedToolIds = uniq(learnedPriors
    .filter((prior) => !(allowContextOnlyAnswer && prior.toolId === 'documentRead'))
    .filter((prior) => allowed.has(prior.toolId))
    .filter((prior) => TOOL_REGISTRY_MAP.get(prior.toolId)?.deprecated !== true)
    .map((prior) => prior.toolId));
  const heuristicPrimaryBundle = buildPrimaryBundle({
    allowed,
    domain: inferredDomain,
    operationClass: inferredOperationClass,
    hasArtifacts: input.hasActiveArtifacts,
    artifactMode,
    latestUserMessage: queryTextForInference,
    searchIntent,
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
    searchIntent,
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
  const broadAllowedToolSurface = buildBroadAllowedToolSurface(allowed);

  const initialSelection: RunScopedToolSelection = {
    runExposedToolIds: broadAllowedToolSurface,
    plannerCandidateToolIds: broadAllowedToolSurface,
    selectionReason,
    selectionFallbackNeeded: primaryBundle.length === 0 && fallbackBundle.length > 0,
    inferredDomain,
    inferredOperationClass,
  };

  if (primaryBundle.length === 0 && fallbackBundle.length === 0) {
    return initialSelection;
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
      plannerChosenToolId: ALIAS_TO_CANONICAL_ID[strongestPrior?.toolId ?? ''] ?? strongestPrior?.toolId,
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
      allowedToolIds: input.allowedToolIds,
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
