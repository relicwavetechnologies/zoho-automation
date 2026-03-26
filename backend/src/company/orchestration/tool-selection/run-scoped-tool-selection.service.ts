import { generateText } from 'ai';
import { z } from 'zod';

import { memoryService, normalizeToolRoutingIntent, type ToolRoutingDomain, type ToolRoutingOperationClass, type ToolRoutingPriorMatch } from '../../memory';
import { logger } from '../../../utils/logger';
import { resolveVercelChildRouterModel } from '../vercel/model-factory';
import { TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import type { ToolActionGroup } from '../../tools/tool-action-groups';

type OperationClass = ToolRoutingOperationClass;
type IntentDomain = ToolRoutingDomain;

type ChildRouteHints = {
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

const GLOBAL_ALWAYS_ON_IDS = ['skill-search'] as const;
const WORKSPACE_GLOBAL_IDS = ['coding'] as const;
const ARTIFACT_GLOBAL_IDS = ['document-ocr-read'] as const;

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

const chooseSuggestedAllowed = (allowed: Set<string>, suggestedToolIds?: string[]): string[] =>
  uniq((suggestedToolIds ?? []).map((toolId) => allowed.has(toolId) ? toolId : null));

const isAffirmationFollowUp = (message: string): boolean =>
  /^(yes|yeah|yep|ok|okay|sure|go ahead|continue|proceed|try again|do it)\b/.test(asLower(message));

const summarizeLearnedPriors = (priors: ToolRoutingPriorMatch[]): string[] =>
  priors.slice(0, 3).map((prior) =>
    `${prior.toolId} via ${prior.matchedBy} (${prior.scope}, confidence ${prior.confidenceScore.toFixed(2)})`);

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

const inferOperationClass = (message: string): OperationClass => {
  const text = asLower(message);
  if (/\b(send|email|mail|draft|reply|forward)\b/.test(text)) return 'send';
  if (/\b(create|update|delete|edit|modify|rename|convert|approve|reconcile|import|upload)\b/.test(text)) return 'write';
  if (/\b(what is in|what's in|what is shown|check this|inspect|view|open this|read this)\b/.test(text)) return 'inspect';
  if (/\b(schedule|book|calendar|meeting|event)\b/.test(text)) return 'schedule';
  if (/\b(search|look up|find on web|latest|recent news|google)\b/.test(text)) return 'search';
  return 'read';
};

const isVisualInspectionRequest = (message: string): boolean =>
  /\b(image|img|screenshot|photo|picture|gif|what do you see|what's in this|what is in this|what is shown|what's shown|describe this|check this)\b/.test(asLower(message));

const requiresExplicitExtraction = (message: string): boolean =>
  /\b(ocr|extract text|exact text|read the text|what does it say|copy the text|transcribe|verbatim|all the text|full text)\b/.test(asLower(message));

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
  const requiresGmail = /\bgmail\b/.test(lowerMessage);
  const suggestedAllowedToolIds = chooseSuggestedAllowed(input.allowed, input.childRoute?.suggestedToolIds);
  if (isAffirmationFollowUp(input.latestUserMessage) && suggestedAllowedToolIds.length > 0) {
    return suggestedAllowedToolIds.slice(0, 3);
  }
  switch (input.domain) {
    case 'zoho_books':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['zoho-books-read', 'zoho-books-agent'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['zoho-books-read', 'zoho-books-agent']),
          ...chooseFirstAllowed(input.allowed, ['zoho-books-write', 'zoho-books-agent']),
          ...(input.operationClass === 'send' && requiresGmail
            ? chooseFirstAllowed(input.allowed, ['google-gmail'])
            : []),
        ]);
    case 'zoho_crm':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['zoho-read', 'read-zoho-records', 'zoho-agent', 'search-zoho-context'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['zoho-read', 'read-zoho-records', 'zoho-agent']),
          ...chooseFirstAllowed(input.allowed, ['zoho-write', 'zoho-agent']),
        ]);
    case 'gmail':
      return chooseFirstAllowed(input.allowed, ['google-gmail']);
    case 'google_drive':
      return chooseFirstAllowed(input.allowed, ['google-drive']);
    case 'google_calendar':
      return chooseFirstAllowed(input.allowed, ['google-calendar']);
    case 'lark_base':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent']),
          ...chooseFirstAllowed(input.allowed, ['lark-base-write', 'lark-base-agent']),
        ]);
    case 'lark_task':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent']),
          ...chooseFirstAllowed(input.allowed, ['lark-task-write', 'lark-task-agent']),
        ]);
    case 'lark_message':
      return input.operationClass === 'send' || /\b(dm|direct message|message|ping)\b/.test(larkHintText)
        ? uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-message-read']),
          ...chooseFirstAllowed(input.allowed, ['lark-message-write']),
        ])
        : chooseFirstAllowed(input.allowed, ['lark-message-read']);
    case 'lark_doc':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['lark-doc-agent'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-doc-agent']),
          ...chooseFirstAllowed(input.allowed, ['create-lark-doc', 'edit-lark-doc']),
        ]);
    case 'lark_calendar':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['lark-calendar-read', 'lark-calendar-list', 'lark-calendar-agent'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-calendar-read', 'lark-calendar-list', 'lark-calendar-agent']),
          ...chooseFirstAllowed(input.allowed, ['lark-calendar-write', 'lark-calendar-agent']),
        ]);
    case 'lark_approval':
      return input.operationClass === 'read' || input.operationClass === 'inspect'
        ? chooseFirstAllowed(input.allowed, ['lark-approval-read', 'lark-approval-agent'])
        : uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-approval-read', 'lark-approval-agent']),
          ...chooseFirstAllowed(input.allowed, ['lark-approval-write', 'lark-approval-agent']),
        ]);
    case 'lark_meeting':
      return chooseFirstAllowed(input.allowed, ['lark-meeting-read', 'lark-meeting-agent']);
    case 'lark':
      if (suggestedAllowedToolIds.length > 0) {
        return suggestedAllowedToolIds.slice(0, 3);
      }
      if (/\b(dm|direct message|message|ping)\b/.test(larkHintText)) {
        return uniq([
          ...chooseFirstAllowed(input.allowed, ['lark-message-read']),
          ...chooseFirstAllowed(input.allowed, ['lark-message-write']),
        ]).slice(0, 3);
      }
      if (/\b(base|bitable|table|tables|record|records|field|fields|view|views)\b/.test(larkHintText)) {
        return chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent']);
      }
      if (/\b(task|tasks|assignee|assign|due date|todo)\b/.test(larkHintText)) {
        return chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent']);
      }
      return uniq([
        ...chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent']),
        ...chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent']),
      ]).slice(0, 3);
    case 'workspace':
      return chooseFirstAllowed(input.allowed, ['coding']);
    case 'document_inspection':
      if (input.allowContextOnlyAnswer) {
        return [];
      }
      return uniq([
        ...chooseFirstAllowed(input.allowed, ['document-ocr-read']),
        ...(input.hasArtifacts ? chooseFirstAllowed(input.allowed, ['search-documents']) : []),
      ]);
    case 'web_search':
      return chooseFirstAllowed(input.allowed, ['search-read', 'search-agent']);
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
      ...(input.hasArtifacts && !skipArtifactInspectionTools
        ? chooseFirstAllowed(input.allowed, ['document-ocr-read', 'search-documents'])
        : []),
      ...chooseFirstAllowed(input.allowed, ['search-read', 'search-agent']),
    ]).slice(0, 2);
  }
  if (input.domain === 'document_inspection' && !skipArtifactInspectionTools) {
    return chooseFirstAllowed(input.allowed, ['search-documents']);
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
    : 'If the user asks what is in an image, message, button, or attachment, prefer document inspection tools.',
].filter(Boolean).join('\n');

const validatePlannerDecision = (input: {
  decision: z.infer<typeof plannerDecisionSchema>;
  selection: RunScopedToolSelection;
  coreToolIds: string[];
}): RunScopedToolSelection => {
  const exposed = new Set(input.selection.runExposedToolIds);
  if (input.decision.shouldAskClarification) {
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
    return {
      ...input.selection,
      clarificationQuestion: 'I need one more detail before I can safely choose the right tool for this request.',
      validationFailureReason: 'planner_tool_outside_run_scope',
    };
  }
  const candidateToolIds = uniq([
    ...input.coreToolIds,
    ...(input.decision.candidateToolIds ?? []).filter((toolId) => exposed.has(toolId)),
    chosenToolId,
  ]);
  return {
    ...input.selection,
    runExposedToolIds: candidateToolIds,
    plannerCandidateToolIds: candidateToolIds,
    plannerChosenToolId: chosenToolId,
    plannerChosenOperationClass: input.decision.chosenOperationClass ?? input.selection.inferredOperationClass,
  };
};

export const resolveRunScopedToolSelection = async (input: {
  companyId: string;
  userId?: string | null;
  threadId?: string;
  conversationKey?: string;
  latestUserMessage: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  workspaceAvailable: boolean;
  hasActiveArtifacts: boolean;
  artifactMode?: ArtifactMode;
  childRoute?: ChildRouteHints;
}): Promise<RunScopedToolSelection> => {
  const allowed = new Set(input.allowedToolIds);
  const artifactMode = input.artifactMode ?? 'none';
  const allowContextOnlyAnswer = canAnswerFromGroundedContext({
    artifactMode,
    hasActiveArtifacts: input.hasActiveArtifacts,
    latestUserMessage: input.latestUserMessage,
  });
  const exposeArtifactTools =
    input.hasActiveArtifacts
    && !allowContextOnlyAnswer;
  const coreToolIds = uniq([
    ...GLOBAL_ALWAYS_ON_IDS.filter((toolId) => allowed.has(toolId)),
    ...(input.workspaceAvailable ? WORKSPACE_GLOBAL_IDS.filter((toolId) => allowed.has(toolId)) : []),
    ...(exposeArtifactTools ? ARTIFACT_GLOBAL_IDS.filter((toolId) => allowed.has(toolId)) : []),
  ]);

  const inferredOperationClass = inferOperationClass(input.latestUserMessage);
  const inferredDomain = inferIntentDomain({
    message: input.latestUserMessage,
    childRoute: input.childRoute,
    hasWorkspace: input.workspaceAvailable,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const suggestedAllowedToolIds = chooseSuggestedAllowed(allowed, input.childRoute?.suggestedToolIds)
    .filter((toolId) => !(allowContextOnlyAnswer && toolId === 'document-ocr-read'));
  const { priors: learnedPriors } = await memoryService.findRoutingPriors({
    companyId: input.companyId,
    userId: input.userId,
    threadId: input.threadId,
    conversationKey: input.conversationKey,
    allowedToolIds: input.allowedToolIds,
    latestUserMessage: input.latestUserMessage,
    childRoute: input.childRoute,
    hasWorkspace: input.workspaceAvailable,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const learnedToolIds = uniq(learnedPriors
    .filter((prior) => !(allowContextOnlyAnswer && prior.toolId === 'document-ocr-read'))
    .map((prior) => prior.toolId));
  const primaryBundle = uniq([
    ...learnedToolIds,
    ...suggestedAllowedToolIds,
    ...buildPrimaryBundle({
      allowed,
      domain: inferredDomain,
      operationClass: inferredOperationClass,
      hasArtifacts: input.hasActiveArtifacts,
      artifactMode,
      latestUserMessage: input.latestUserMessage,
      childRoute: input.childRoute,
      allowContextOnlyAnswer,
    }),
  ]);
  const fallbackBundle = buildFallbackBundle({
    allowed,
    domain: inferredDomain,
    hasArtifacts: input.hasActiveArtifacts,
    artifactMode,
    latestUserMessage: input.latestUserMessage,
    allowContextOnlyAnswer,
  });
  const learnedSummary = summarizeLearnedPriors(learnedPriors);
  const selectionReason = primaryBundle.length > 0
    ? `Primary domain ${inferredDomain} with operation ${inferredOperationClass}.${learnedSummary.length > 0 ? ` Learned routing priors favored ${learnedSummary.join('; ')}.` : ''}`
    : allowContextOnlyAnswer
      ? 'Current grounded multimodal context appears sufficient to answer directly without document extraction tools.'
      : 'No safe primary domain could be resolved from the latest message; preserving only core and fallback tools.';

  const initialSelection: RunScopedToolSelection = {
    runExposedToolIds: uniq([...coreToolIds, ...primaryBundle, ...fallbackBundle]),
    plannerCandidateToolIds: uniq([...coreToolIds, ...primaryBundle]),
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
    latestUserMessage: input.latestUserMessage,
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
