import { generateText } from 'ai';
import { z } from 'zod';

import { logger } from '../../../utils/logger';
import { resolveVercelChildRouterModel } from '../vercel/model-factory';
import { TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import type { ToolActionGroup } from '../../tools/tool-action-groups';

type OperationClass = 'read' | 'write' | 'send' | 'inspect' | 'schedule' | 'search';
type IntentDomain =
  | 'zoho_books'
  | 'zoho_crm'
  | 'gmail'
  | 'google_drive'
  | 'google_calendar'
  | 'lark'
  | 'workspace'
  | 'document_inspection'
  | 'web_search'
  | 'unknown';

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

const plannerDecisionSchema = z.object({
  chosenToolId: z.string().min(1).max(80).optional(),
  chosenOperationClass: z.enum(['read', 'write', 'send', 'inspect', 'schedule', 'search']).optional(),
  candidateToolIds: z.array(z.string().min(1).max(80)).max(8).optional(),
  sourceOfTruthReason: z.string().min(1).max(300),
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

const inferOperationClass = (message: string): OperationClass => {
  const text = asLower(message);
  if (/\b(send|email|mail|draft|reply|forward)\b/.test(text)) return 'send';
  if (/\b(create|update|delete|edit|modify|rename|convert|approve|reconcile|import|upload)\b/.test(text)) return 'write';
  if (/\b(what is in|what's in|what is shown|check this|inspect|view|open this|read this)\b/.test(text)) return 'inspect';
  if (/\b(schedule|book|calendar|meeting|event)\b/.test(text)) return 'schedule';
  if (/\b(search|look up|find on web|latest|recent news|google)\b/.test(text)) return 'search';
  return 'read';
};

const inferIntentDomain = (input: {
  message: string;
  childRoute?: ChildRouteHints;
  hasWorkspace: boolean;
  hasArtifacts: boolean;
}): IntentDomain => {
  const text = asLower(input.message);
  const normalizedIntent = asLower(input.childRoute?.normalizedIntent);
  const joined = `${text}\n${normalizedIntent}`;

  if (/\b(invoice|invoices|estimate|estimates|credit note|creditnote|sales order|salesorder|bill|bills|vendor payment|customer payment|zoho books)\b/.test(joined)) {
    return 'zoho_books';
  }
  if (/\b(lead|leads|contact|contacts|deal|deals|case|cases|zoho crm|crm)\b/.test(joined)) {
    return 'zoho_crm';
  }
  if (/\b(gmail|inbox|draft email|send by gmail|mail via gmail)\b/.test(joined)) {
    return 'gmail';
  }
  if (/\b(google drive|drive file|drive folder)\b/.test(joined)) {
    return 'google_drive';
  }
  if (/\b(google calendar)\b/.test(joined)) {
    return 'google_calendar';
  }
  if (/\b(task|tasks|lark doc|lark docs|calendar event|lark calendar|meeting|bitable|base table|lark)\b/.test(joined)) {
    return 'lark';
  }
  if (/\b(button|screenshot|image|attachment|pdf|csv|document|file|message)\b/.test(joined) && input.hasArtifacts) {
    return 'document_inspection';
  }
  if (/\b(repo|repository|workspace|folder|file path|terminal|command|script|code)\b/.test(joined) && input.hasWorkspace) {
    return 'workspace';
  }
  if (/\b(web|internet|online|site|latest|up to date|up-to-date)\b/.test(joined)) {
    return 'web_search';
  }
  if (input.hasArtifacts && /\b(this|that|same file|same attachment)\b/.test(joined)) {
    return 'document_inspection';
  }
  if (input.hasWorkspace && /\b(this repo|this workspace)\b/.test(joined)) {
    return 'workspace';
  }
  return 'unknown';
};

const buildPrimaryBundle = (input: {
  allowed: Set<string>;
  domain: IntentDomain;
  operationClass: OperationClass;
  hasArtifacts: boolean;
  latestUserMessage: string;
  childRoute?: ChildRouteHints;
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
    case 'lark':
      if (suggestedAllowedToolIds.length > 0) {
        return suggestedAllowedToolIds.slice(0, 3);
      }
      if (/\b(base|bitable|table|tables|record|records|field|fields|view|views)\b/.test(larkHintText)) {
        return input.operationClass === 'read' || input.operationClass === 'inspect'
          ? chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent'])
          : uniq([
            ...chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent']),
            ...chooseFirstAllowed(input.allowed, ['lark-base-write', 'lark-base-agent']),
          ]);
      }
      if (/\b(task|tasks|assignee|assign|due date|todo)\b/.test(larkHintText)) {
        return input.operationClass === 'read' || input.operationClass === 'inspect'
          ? chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent'])
          : uniq([
            ...chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent']),
            ...chooseFirstAllowed(input.allowed, ['lark-task-write', 'lark-task-agent']),
          ]);
      }
      if (/\b(doc|docs|document|writeup|report|note|notes)\b/.test(larkHintText)) {
        return input.operationClass === 'read' || input.operationClass === 'inspect'
          ? chooseFirstAllowed(input.allowed, ['lark-doc-agent'])
          : uniq([
            ...chooseFirstAllowed(input.allowed, ['lark-doc-agent']),
            ...chooseFirstAllowed(input.allowed, ['create-lark-doc', 'edit-lark-doc']),
          ]);
      }
      if (/\b(calendar|event|schedule)\b/.test(larkHintText)) {
        return input.operationClass === 'read' || input.operationClass === 'inspect'
          ? chooseFirstAllowed(input.allowed, ['lark-calendar-read', 'lark-calendar-list', 'lark-calendar-agent'])
          : uniq([
            ...chooseFirstAllowed(input.allowed, ['lark-calendar-read', 'lark-calendar-list', 'lark-calendar-agent']),
            ...chooseFirstAllowed(input.allowed, ['lark-calendar-write', 'lark-calendar-agent']),
          ]);
      }
      if (/\b(approval|approvals)\b/.test(larkHintText)) {
        return input.operationClass === 'read' || input.operationClass === 'inspect'
          ? chooseFirstAllowed(input.allowed, ['lark-approval-read', 'lark-approval-agent'])
          : uniq([
            ...chooseFirstAllowed(input.allowed, ['lark-approval-read', 'lark-approval-agent']),
            ...chooseFirstAllowed(input.allowed, ['lark-approval-write', 'lark-approval-agent']),
          ]);
      }
      if (/\b(meeting|minutes)\b/.test(larkHintText)) {
        return chooseFirstAllowed(input.allowed, ['lark-meeting-read', 'lark-meeting-agent']);
      }
      return uniq([
        ...chooseFirstAllowed(input.allowed, ['lark-base-read', 'lark-base-agent']),
        ...chooseFirstAllowed(input.allowed, ['lark-task-read', 'lark-task-agent']),
      ]).slice(0, 3);
    case 'workspace':
      return chooseFirstAllowed(input.allowed, ['coding']);
    case 'document_inspection':
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
}): string[] => {
  if (input.domain === 'unknown') {
    return uniq([
      ...(input.hasArtifacts ? chooseFirstAllowed(input.allowed, ['document-ocr-read', 'search-documents']) : []),
      ...chooseFirstAllowed(input.allowed, ['search-read', 'search-agent']),
    ]).slice(0, 2);
  }
  if (input.domain === 'document_inspection') {
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
  runExposedToolIds: string[];
  childRoute?: ChildRouteHints;
}): string => [
  'Choose the best run-scoped tool subset for this request.',
  'Return JSON only.',
  'Do not invent tools outside the provided run-exposed set.',
  'Prefer source-of-truth business tools over generic helpers when the user asked for live records.',
  'If the request cannot be solved safely with the current run-exposed set, ask for clarification instead of broadening tools.',
  `Latest user message: ${input.latestUserMessage}`,
  `Inferred domain: ${input.inferredDomain}`,
  `Inferred operation class: ${input.inferredOperationClass}`,
  `Selection reason: ${input.selectionReason}`,
  input.childRoute?.normalizedIntent ? `Child normalized intent: ${input.childRoute.normalizedIntent}` : '',
  input.childRoute?.reason ? `Child route reason: ${input.childRoute.reason}` : '',
  'Run-exposed tool ids:',
  describeTools(input.runExposedToolIds),
  'Planner output schema:',
  '{"chosenToolId":"...", "chosenOperationClass":"read|write|send|inspect|schedule|search", "candidateToolIds":["..."], "sourceOfTruthReason":"...", "missingFields":["..."], "shouldAskClarification":false, "clarificationQuestion":"..."}',
  'If a live Zoho Books request mentions invoices, estimates, bills, payments, or Zoho Books, choose Zoho Books tools over cached context or generic search.',
  'If the user asks what is in an image, message, button, or attachment, prefer document inspection tools.',
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
  latestUserMessage: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  workspaceAvailable: boolean;
  hasActiveArtifacts: boolean;
  childRoute?: ChildRouteHints;
}): Promise<RunScopedToolSelection> => {
  const allowed = new Set(input.allowedToolIds);
  const coreToolIds = uniq([
    ...GLOBAL_ALWAYS_ON_IDS.filter((toolId) => allowed.has(toolId)),
    ...(input.workspaceAvailable ? WORKSPACE_GLOBAL_IDS.filter((toolId) => allowed.has(toolId)) : []),
    ...(input.hasActiveArtifacts ? ARTIFACT_GLOBAL_IDS.filter((toolId) => allowed.has(toolId)) : []),
  ]);

  const inferredOperationClass = inferOperationClass(input.latestUserMessage);
  const inferredDomain = inferIntentDomain({
    message: input.latestUserMessage,
    childRoute: input.childRoute,
    hasWorkspace: input.workspaceAvailable,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const primaryBundle = buildPrimaryBundle({
    allowed,
    domain: inferredDomain,
    operationClass: inferredOperationClass,
    hasArtifacts: input.hasActiveArtifacts,
    latestUserMessage: input.latestUserMessage,
    childRoute: input.childRoute,
  });
  const fallbackBundle = buildFallbackBundle({
    allowed,
    domain: inferredDomain,
    hasArtifacts: input.hasActiveArtifacts,
  });
  const selectionReason = primaryBundle.length > 0
    ? `Primary domain ${inferredDomain} with operation ${inferredOperationClass}.`
    : `No safe primary domain could be resolved from the latest message; preserving only core and fallback tools.`;

  const initialSelection: RunScopedToolSelection = {
    runExposedToolIds: uniq([...coreToolIds, ...primaryBundle, ...fallbackBundle]),
    plannerCandidateToolIds: uniq([...coreToolIds, ...primaryBundle]),
    selectionReason,
    selectionFallbackNeeded: primaryBundle.length === 0 && fallbackBundle.length > 0,
    inferredDomain,
    inferredOperationClass,
  };

  if (primaryBundle.length === 0 && fallbackBundle.length === 0) {
    return {
      ...initialSelection,
      clarificationQuestion: 'I need one more detail before I can choose the right tool for this request.',
      validationFailureReason: 'no_safe_primary_bundle',
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
        runExposedToolIds: initialSelection.runExposedToolIds,
        childRoute: input.childRoute,
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
