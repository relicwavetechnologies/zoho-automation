import { z } from 'zod';

import { KNOWLEDGE_NEEDS, RETRIEVAL_STRATEGIES, retrievalPlannerService } from '../../retrieval';
import { classifyIntent, type CanonicalIntent } from '../intent/canonical-intent';
import type {
  RuntimeClassificationResult,
  RuntimeComplexity,
  RuntimeFreshnessNeed,
  RuntimeRetrievalMode,
  RuntimeRiskLevel,
} from './runtime.types';

const RouteSchema = z.object({
  intent: z.string().min(1),
  complexity: z.enum(['simple', 'multi_step']).optional(),
  freshnessNeed: z.enum(['none', 'maybe', 'required']).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  domains: z.array(z.string().min(1)).optional(),
  retrievalMode: z.enum(['none', 'vector', 'web', 'both']).optional(),
  knowledgeNeeds: z.array(z.enum(KNOWLEDGE_NEEDS)).optional(),
  preferredStrategy: z.enum(RETRIEVAL_STRATEGIES).optional(),
});

type RouteSchemaShape = z.infer<typeof RouteSchema>;

export type ResolvedRouteContract = {
  source: 'model' | 'heuristic_fallback';
  fallbackReasonCode?: string;
  validationErrors: string[];
  route: RuntimeClassificationResult & {
    retrievalMode: RuntimeRetrievalMode;
  };
};

const WEB_KEYWORDS = ['news', 'website', 'site:', 'http://', 'https://', 'search', 'look up'];
const FRESHNESS_KEYWORDS = ['latest', 'current', 'today', 'news'];
const DOC_KEYWORDS = ['document', 'doc', 'pdf', 'file', 'upload', 'internal doc', 'folder'];
const ZOHO_KEYWORDS = ['zoho', 'deal', 'contact', 'account', 'lead', 'crm', 'pipeline', 'case'];
const BOOKS_KEYWORDS = ['invoice', 'payment', 'books', 'bank statement', 'estimate', 'vendor', 'overdue'];
const OUTREACH_KEYWORDS = ['outreach', 'publisher', 'guest post', 'domain authority', 'domain rating'];
const LARK_KEYWORDS = ['lark', 'task', 'calendar', 'meeting', 'approval', 'base'];
const GOOGLE_KEYWORDS = ['gmail', 'google mail', 'google drive', 'drive', 'google calendar'];
const REPO_KEYWORDS = ['repo', 'repository', 'github'];
const CODING_KEYWORDS = ['code', 'implement', 'fix', 'debug', 'refactor', 'workspace'];

const normalizeDomains = (input: string[]): string[] =>
  Array.from(new Set(input.map((entry) => entry.trim()).filter(Boolean)));

const hasAuthoritativeChildRoute = (input: {
  childRouterDomain?: string | null;
  childRouterConfidence?: number | null;
}): boolean => Boolean(input.childRouterDomain?.trim()) && (input.childRouterConfidence ?? 0) >= 0.7;

const normalizeRouteContractDomain = (domain: string): string => {
  switch (domain.trim()) {
    case 'zoho_crm':
      return 'zoho';
    case 'zoho_books':
      return 'books';
    case 'lark_task':
    case 'lark_message':
    case 'lark_calendar':
    case 'lark_meeting':
    case 'lark_approval':
    case 'lark_doc':
    case 'lark_base':
      return 'lark';
    case 'gmail':
    case 'google_drive':
    case 'google_calendar':
      return 'google';
    case 'skill':
    case 'context_search':
      return 'docs';
    case 'workspace':
      return 'coding';
    case 'document_inspection':
      return 'docs';
    default:
      return domain.trim();
  }
};

const canonicalIntentToRouteDomains = (
  canonicalIntent?: CanonicalIntent,
  childRouterDomain?: string | null,
  childRouterConfidence?: number | null,
): string[] => {
  if (hasAuthoritativeChildRoute({ childRouterDomain, childRouterConfidence })) {
    return normalizeDomains([normalizeRouteContractDomain(childRouterDomain!.trim())]);
  }
  if (!canonicalIntent || canonicalIntent.domain === 'general') {
    return [];
  }
  return normalizeDomains([normalizeRouteContractDomain(canonicalIntent.domain)]);
};

const inferDomains = (text: string, childRouterDomain?: string | null, childRouterConfidence?: number | null): string[] => {
  if (hasAuthoritativeChildRoute({ childRouterDomain, childRouterConfidence })) {
    return normalizeDomains([normalizeRouteContractDomain(childRouterDomain!.trim())]);
  }
  const normalized = text.toLowerCase();
  const domains: string[] = [];
  if (ZOHO_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('zoho');
  if (BOOKS_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('books');
  if (DOC_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('docs');
  if (WEB_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('web');
  if (OUTREACH_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('outreach');
  if (LARK_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('lark');
  if (GOOGLE_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('google');
  if (REPO_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('repo');
  if (CODING_KEYWORDS.some((keyword) => normalized.includes(keyword))) domains.push('coding');
  return normalizeDomains(domains);
};

const inferComplexity = (
  text: string,
  childRouterOperationType?: string | null,
  canonicalIntent?: CanonicalIntent,
): RuntimeComplexity => {
  if ((canonicalIntent ?? classifyIntent(text, { childRouterOperationType })).isWriteLike) {
    return 'multi_step';
  }
  if (/\b(and|then|after that|also)\b/i.test(text)) {
    return 'multi_step';
  }
  return 'simple';
};

const inferFreshnessNeed = (text: string): RuntimeFreshnessNeed =>
  FRESHNESS_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword)) ? 'required' : 'none';

const inferRisk = (
  text: string,
  childRouterOperationType?: string | null,
  canonicalIntent?: CanonicalIntent,
): RuntimeRiskLevel => {
  const intent = canonicalIntent ?? classifyIntent(text, { childRouterOperationType });
  if (intent.isWriteLike) {
    return 'high';
  }
  if (/\b(mail|calendar|approval|meeting|payment|invoice)\b/i.test(text)) {
    return 'medium';
  }
  return 'low';
};

const inferIntent = (
  text: string,
  domains: string[],
  childRouterOperationType?: string | null,
  canonicalIntent?: CanonicalIntent,
): string => {
  const normalized = text.toLowerCase();
  const intent = canonicalIntent ?? classifyIntent(text, { childRouterOperationType });
  if (CODING_KEYWORDS.some((keyword) => normalized.includes(keyword))) return 'coding';
  if (REPO_KEYWORDS.some((keyword) => normalized.includes(keyword))) return 'repo_read';
  if (intent.isWriteLike) return 'write_intent';
  if (domains.includes('outreach')) return 'outreach_read';
  if (domains.includes('books')) return 'books_read';
  if (domains.includes('zoho')) return 'zoho_read';
  if (domains.includes('docs')) return 'doc_search';
  if (domains.includes('web')) return 'web_search';
  if (domains.includes('lark')) return 'lark_read';
  return 'general';
};

const inferRetrievalMode = (input: {
  domains: string[];
  freshnessNeed: RuntimeFreshnessNeed;
  intent: string;
}): RuntimeRetrievalMode => {
  if (input.intent === 'coding') return 'none';
  if (input.intent === 'repo_read' || input.intent === 'web_search') return 'web';
  const hasInternalDomain = input.domains.some((domain) => ['zoho', 'books', 'docs', 'outreach', 'lark', 'google'].includes(domain));
  if (hasInternalDomain && input.freshnessNeed === 'required' && input.domains.includes('web')) {
    return 'both';
  }
  if (hasInternalDomain) {
    return 'vector';
  }
  if (input.freshnessNeed === 'required') {
    return 'web';
  }
  return 'none';
};

const buildHeuristicRoute = (input: {
  messageText: string;
  childRouterDomain?: string | null;
  childRouterOperationType?: string | null;
  childRouterConfidence?: number | null;
  canonicalIntent?: CanonicalIntent;
}): ResolvedRouteContract['route'] => {
  const canonicalDomains = canonicalIntentToRouteDomains(
    input.canonicalIntent,
    input.childRouterDomain,
    input.childRouterConfidence,
  );
  const domains = canonicalDomains.length > 0
    ? canonicalDomains
    : inferDomains(input.messageText, input.childRouterDomain, input.childRouterConfidence);
  const complexity = inferComplexity(input.messageText, input.childRouterOperationType, input.canonicalIntent);
  const freshnessNeed = inferFreshnessNeed(input.messageText);
  const risk = inferRisk(input.messageText, input.childRouterOperationType, input.canonicalIntent);
  const intent = inferIntent(input.messageText, domains, input.childRouterOperationType, input.canonicalIntent);
  const retrievalMode = inferRetrievalMode({ domains, freshnessNeed, intent });
  const retrievalPlan = retrievalPlannerService.buildPlan({
    messageText: input.messageText,
    intent,
    domains,
    freshnessNeed,
    retrievalMode,
  });

  return {
    intent,
    complexity,
    freshnessNeed,
    risk,
    domains,
    retrievalMode,
    knowledgeNeeds: retrievalPlan.knowledgeNeeds,
    preferredStrategy: retrievalPlan.preferredStrategy,
    source: 'heuristic_fallback',
  };
};

const parseRawOutput = (rawLlmOutput: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null => {
  if (!rawLlmOutput) {
    return null;
  }
  if (typeof rawLlmOutput === 'object') {
    return rawLlmOutput;
  }
  try {
    return JSON.parse(rawLlmOutput) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const toRoute = (
  parsed: RouteSchemaShape,
  fallbackText: string,
  childRouterDomain?: string | null,
  childRouterOperationType?: string | null,
  childRouterConfidence?: number | null,
  canonicalIntent?: CanonicalIntent,
): ResolvedRouteContract['route'] => {
  const canonicalDomains = canonicalIntentToRouteDomains(
    canonicalIntent,
    childRouterDomain,
    childRouterConfidence,
  );
  const domains = normalizeDomains(
    (canonicalDomains.length > 0
      ? canonicalDomains
      : parsed.domains)
    ?? (canonicalDomains.length > 0
      ? canonicalDomains
      : inferDomains(fallbackText, childRouterDomain, childRouterConfidence)),
  );
  const complexity = parsed.complexity ?? inferComplexity(fallbackText, childRouterOperationType, canonicalIntent);
  const freshnessNeed = parsed.freshnessNeed ?? inferFreshnessNeed(fallbackText);
  const risk = parsed.risk ?? inferRisk(fallbackText, childRouterOperationType, canonicalIntent);
  const intent = canonicalIntent
    ? inferIntent(fallbackText, domains, childRouterOperationType, canonicalIntent)
    : parsed.intent.trim();
  const retrievalMode = parsed.retrievalMode ?? inferRetrievalMode({ domains, freshnessNeed, intent });
  const retrievalPlan = retrievalPlannerService.buildPlan({
    messageText: fallbackText,
    intent,
    domains,
    freshnessNeed,
    retrievalMode,
  });
  return {
    intent,
    complexity,
    freshnessNeed,
    risk,
    domains,
    retrievalMode,
    knowledgeNeeds: parsed.knowledgeNeeds ?? retrievalPlan.knowledgeNeeds,
    preferredStrategy: parsed.preferredStrategy ?? retrievalPlan.preferredStrategy,
    source: 'model',
  };
};

export const resolveRouteContract = (input: {
  rawLlmOutput: string | Record<string, unknown> | null | undefined;
  messageText: string;
  childRouterDomain?: string | null;
  childRouterOperationType?: string | null;
  childRouterConfidence?: number | null;
  canonicalIntent?: CanonicalIntent;
}): ResolvedRouteContract => {
  const raw = parseRawOutput(input.rawLlmOutput);
  if (!raw) {
    return {
      source: 'heuristic_fallback',
      fallbackReasonCode: input.rawLlmOutput ? 'llm_invalid_json' : 'llm_empty',
      validationErrors: input.rawLlmOutput ? ['Route classifier returned invalid JSON.'] : ['Route classifier returned no output.'],
      route: buildHeuristicRoute({
        messageText: input.messageText,
        childRouterDomain: input.childRouterDomain,
        childRouterOperationType: input.childRouterOperationType,
        childRouterConfidence: input.childRouterConfidence,
        canonicalIntent: input.canonicalIntent,
      }),
    };
  }

  const parsed = RouteSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      source: 'heuristic_fallback',
      fallbackReasonCode: 'llm_schema_invalid',
      validationErrors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
      route: buildHeuristicRoute({
        messageText: input.messageText,
        childRouterDomain: input.childRouterDomain,
        childRouterOperationType: input.childRouterOperationType,
        childRouterConfidence: input.childRouterConfidence,
        canonicalIntent: input.canonicalIntent,
      }),
    };
  }

  return {
    source: 'model',
    validationErrors: [],
    route: toRoute(
      parsed.data,
      input.messageText,
      input.childRouterDomain,
      input.childRouterOperationType,
      input.childRouterConfidence,
      input.canonicalIntent,
    ),
  };
};
