import { z } from 'zod';

import { KNOWLEDGE_NEEDS, RETRIEVAL_STRATEGIES, retrievalPlannerService } from '../../retrieval';
import { classifyIntent } from '../intent/canonical-intent';
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

const inferDomains = (text: string): string[] => {
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

const inferComplexity = (text: string): RuntimeComplexity => {
  if (classifyIntent(text).isWriteLike) {
    return 'multi_step';
  }
  if (/\b(and|then|after that|also)\b/i.test(text)) {
    return 'multi_step';
  }
  return 'simple';
};

const inferFreshnessNeed = (text: string): RuntimeFreshnessNeed =>
  FRESHNESS_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword)) ? 'required' : 'none';

const inferRisk = (text: string): RuntimeRiskLevel => {
  const intent = classifyIntent(text);
  if (intent.isWriteLike) {
    return 'high';
  }
  if (/\b(mail|calendar|approval|meeting|payment|invoice)\b/i.test(text)) {
    return 'medium';
  }
  return 'low';
};

const inferIntent = (text: string, domains: string[]): string => {
  const normalized = text.toLowerCase();
  const intent = classifyIntent(text);
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

const buildHeuristicRoute = (messageText: string): ResolvedRouteContract['route'] => {
  const domains = inferDomains(messageText);
  const complexity = inferComplexity(messageText);
  const freshnessNeed = inferFreshnessNeed(messageText);
  const risk = inferRisk(messageText);
  const intent = inferIntent(messageText, domains);
  const retrievalMode = inferRetrievalMode({ domains, freshnessNeed, intent });
  const retrievalPlan = retrievalPlannerService.buildPlan({
    messageText,
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

const toRoute = (parsed: RouteSchemaShape, fallbackText: string): ResolvedRouteContract['route'] => {
  const domains = normalizeDomains(parsed.domains ?? inferDomains(fallbackText));
  const complexity = parsed.complexity ?? inferComplexity(fallbackText);
  const freshnessNeed = parsed.freshnessNeed ?? inferFreshnessNeed(fallbackText);
  const risk = parsed.risk ?? inferRisk(fallbackText);
  const intent = parsed.intent.trim();
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
}): ResolvedRouteContract => {
  const raw = parseRawOutput(input.rawLlmOutput);
  if (!raw) {
    return {
      source: 'heuristic_fallback',
      fallbackReasonCode: input.rawLlmOutput ? 'llm_invalid_json' : 'llm_empty',
      validationErrors: input.rawLlmOutput ? ['Route classifier returned invalid JSON.'] : ['Route classifier returned no output.'],
      route: buildHeuristicRoute(input.messageText),
    };
  }

  const parsed = RouteSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      source: 'heuristic_fallback',
      fallbackReasonCode: 'llm_schema_invalid',
      validationErrors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
      route: buildHeuristicRoute(input.messageText),
    };
  }

  return {
    source: 'model',
    validationErrors: [],
    route: toRoute(parsed.data, input.messageText),
  };
};
