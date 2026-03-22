import type { KnowledgeNeed, PlannedRetrievalStep, RetrievalPlan, RetrievalStrategy } from './contracts';

type RetrievalPlannerInput = {
  messageText: string;
  intent?: string;
  domains?: string[];
  freshnessNeed?: 'none' | 'maybe' | 'required';
  retrievalMode?: 'none' | 'vector' | 'web' | 'both';
  hasAttachments?: boolean;
};

const FINANCE_KEYWORDS = [
  'invoice',
  'statement',
  'balance',
  'transaction',
  'transactions',
  'vendor',
  'payment',
  'payments',
  'reconcile',
  'reconciliation',
  'closing balance',
  'bank statement',
];

const DOC_KEYWORDS = [
  'policy',
  'policies',
  'contract',
  'clause',
  'section',
  'definition',
  'exceptions',
  'handbook',
  'runbook',
  'sop',
  'playbook',
  'guide',
  'document',
  'documents',
  'pdf',
  'file',
  'files',
  'uploaded',
  'upload',
  'internal doc',
  'company doc',
];

const ATTACHMENT_KEYWORDS = [
  'attached',
  'attachment',
  'this file',
  'this pdf',
  'this document',
  'uploaded file',
  'uploaded pdf',
  'uploaded document',
  'screenshot',
  'image attached',
];

const MEMORY_KEYWORDS = [
  'remember',
  'i told you',
  'you said',
  'before',
  'previously',
  'last time',
  'my preference',
  'my preferences',
  'favorite',
  'favourite',
  'my name is',
];

const WORKFLOW_KEYWORDS = [
  'how do',
  'how should',
  'what is the process',
  'workflow',
  'steps',
  'procedure',
  'playbook',
  'runbook',
  'sop',
  'best practice',
  'process for',
];

const EXACT_DOC_KEYWORDS = [
  'exact',
  'verbatim',
  'wording',
  'quote',
  'clause',
  'section',
  'definition',
  'exception',
  'exceptions',
  'full policy',
  'full document',
];

const STALE_SENSITIVE_KEYWORDS = [
  'current',
  'currently',
  'latest',
  'today',
  'now',
  'status',
  'stage',
  'owner',
  'amount',
  'sla',
  'due',
  'updated',
  'last updated',
];

const RELATIONSHIP_KEYWORDS = [
  'related',
  'relationship',
  'connected',
  'across',
  'compare',
  'between',
  'depends on',
  'impact',
];

const normalizeText = (value: string): string => value.trim().toLowerCase();

const pushUnique = <T>(items: T[], value: T) => {
  if (!items.includes(value)) {
    items.push(value);
  }
};

const includesAny = (normalized: string, keywords: string[]): boolean =>
  keywords.some((keyword) => normalized.includes(keyword));

const looksLikeFinanceStructuredQuery = (normalized: string): boolean =>
  includesAny(normalized, FINANCE_KEYWORDS);

const looksLikeAttachmentQuery = (normalized: string, hasAttachments: boolean): boolean =>
  hasAttachments || includesAny(normalized, ATTACHMENT_KEYWORDS);

const looksLikeConversationMemoryQuery = (normalized: string): boolean =>
  includesAny(normalized, MEMORY_KEYWORDS);

const looksLikeWorkflowQuery = (normalized: string): boolean =>
  includesAny(normalized, WORKFLOW_KEYWORDS);

const looksLikeCompanyDocQuery = (normalized: string): boolean =>
  includesAny(normalized, DOC_KEYWORDS);

const looksLikeExactDocumentQuery = (normalized: string): boolean =>
  includesAny(normalized, EXACT_DOC_KEYWORDS);

const looksLikeStaleSensitiveQuery = (normalized: string, freshnessNeed: 'none' | 'maybe' | 'required'): boolean =>
  freshnessNeed === 'required' || includesAny(normalized, STALE_SENSITIVE_KEYWORDS);

const looksLikeRelationshipQuery = (normalized: string): boolean =>
  includesAny(normalized, RELATIONSHIP_KEYWORDS);

const inferFallbackDomains = (normalized: string): string[] => {
  const domains: string[] = [];
  if (/\b(zoho|deal|contact|account|lead|crm|ticket|pipeline|case)\b/.test(normalized)) {
    domains.push('zoho');
  }
  if (/\b(invoice|payment|books|bank statement|vendor|estimate|overdue)\b/.test(normalized)) {
    domains.push('books');
  }
  if (looksLikeCompanyDocQuery(normalized)) {
    domains.push('docs');
  }
  if (/\b(latest|current|today|news|website|search|look up|http:\/\/|https:\/\/)\b/.test(normalized)) {
    domains.push('web');
  }
  if (/\b(outreach|publisher|guest post|domain authority|domain rating)\b/.test(normalized)) {
    domains.push('outreach');
  }
  if (/\b(gmail|google drive|google calendar|drive)\b/.test(normalized)) {
    domains.push('google');
  }
  return domains;
};

export class RetrievalPlannerService {
  inferKnowledgeNeeds(input: RetrievalPlannerInput): {
    knowledgeNeeds: KnowledgeNeed[];
    preferredStrategy?: RetrievalStrategy;
    rationale: string[];
  } {
    const normalized = normalizeText(input.messageText);
    const domains = input.domains?.length ? input.domains : inferFallbackDomains(normalized);
    const freshnessNeed = input.freshnessNeed ?? 'none';
    const retrievalMode = input.retrievalMode ?? 'none';
    const needs: KnowledgeNeed[] = [];
    const rationale: string[] = [];

    if (looksLikeAttachmentQuery(normalized, input.hasAttachments ?? false)) {
      pushUnique(needs, 'attachment_exact');
      rationale.push('Attachment-aware retrieval is prioritized because the request references an attached/uploaded file.');
    }

    if (looksLikeFinanceStructuredQuery(normalized) || domains.includes('books')) {
      pushUnique(needs, 'structured_finance');
      rationale.push('Structured finance retrieval fits invoice, statement, balance, or transaction-oriented queries.');
    }

    if (domains.includes('zoho')) {
      pushUnique(needs, 'crm_entity');
      rationale.push('CRM entity retrieval applies because the request targets Zoho records or pipeline context.');
    }

    if (looksLikeCompanyDocQuery(normalized) || domains.includes('docs')) {
      pushUnique(needs, 'company_docs');
      rationale.push('Company document retrieval applies because the request references internal docs, policies, or uploaded files.');
    }

    if (looksLikeWorkflowQuery(normalized)) {
      pushUnique(needs, 'workflow_skill');
      rationale.push('Skill retrieval applies because the request is workflow-like and may need procedural guidance.');
    }

    if (looksLikeConversationMemoryQuery(normalized)) {
      pushUnique(needs, 'conversation_memory');
      rationale.push('Conversation-memory retrieval applies because the request refers to prior user-provided context.');
    }

    const hasInternalNeed = needs.some((need) =>
      need === 'crm_entity'
      || need === 'company_docs'
      || need === 'workflow_skill'
      || need === 'structured_finance'
      || need === 'attachment_exact',
    );
    if (retrievalMode === 'both' || (domains.includes('web') && hasInternalNeed)) {
      pushUnique(needs, 'hybrid_web');
      rationale.push('Hybrid internal-plus-web retrieval applies because the request combines internal context with freshness needs.');
    }

    if (looksLikeRelationshipQuery(normalized) && needs.length > 1) {
      pushUnique(needs, 'relationship');
      rationale.push('Relationship-heavy analysis applies because the request compares or links multiple internal entities or sources.');
    }

    let preferredStrategy: RetrievalStrategy | undefined;
    if (needs.includes('attachment_exact')) {
      preferredStrategy = 'attachment_first';
    } else if (needs.includes('structured_finance')) {
      preferredStrategy = 'structured_parser_plus_doc';
    } else if (needs.includes('hybrid_web')) {
      preferredStrategy = 'internal_plus_web';
    } else if (needs.includes('crm_entity')) {
      preferredStrategy = 'zoho_vector_plus_live';
    } else if (needs.includes('workflow_skill')) {
      preferredStrategy = 'skill_db_search';
    } else if (needs.includes('conversation_memory') && needs.length === 1) {
      preferredStrategy = 'chat_memory';
    } else if (needs.includes('company_docs')) {
      preferredStrategy = looksLikeExactDocumentQuery(normalized) ? 'doc_full_read' : 'doc_chunk_search';
    }

    return {
      knowledgeNeeds: needs,
      preferredStrategy,
      rationale,
    };
  }

  buildPlan(input: RetrievalPlannerInput): RetrievalPlan {
    const normalized = normalizeText(input.messageText);
    const freshnessNeed = input.freshnessNeed ?? 'none';
    const inference = this.inferKnowledgeNeeds(input);
    const steps: PlannedRetrievalStep[] = [];

    const addStep = (step: PlannedRetrievalStep) => {
      if (!steps.some((existing) => existing.need === step.need && existing.strategy === step.strategy)) {
        steps.push(step);
      }
    };

    if (inference.knowledgeNeeds.includes('attachment_exact')) {
      addStep({
        need: 'attachment_exact',
        strategy: 'attachment_first',
        required: true,
        topK: 3,
        freshness: 'none',
      });
    }

    if (inference.knowledgeNeeds.includes('structured_finance')) {
      addStep({
        need: 'structured_finance',
        strategy: 'structured_parser_plus_doc',
        required: true,
        topK: 2,
        freshness: 'none',
      });
    }

    if (inference.knowledgeNeeds.includes('conversation_memory')) {
      addStep({
        need: 'conversation_memory',
        strategy: 'chat_memory',
        required: true,
        topK: 4,
        freshness: 'none',
      });
    }

    if (inference.knowledgeNeeds.includes('workflow_skill')) {
      addStep({
        need: 'workflow_skill',
        strategy: 'skill_db_search',
        required: true,
        topK: 3,
        freshness: 'none',
      });
    }

    if (inference.knowledgeNeeds.includes('crm_entity')) {
      addStep({
        need: 'crm_entity',
        strategy: 'zoho_vector_plus_live',
        required: true,
        topK: 6,
        freshness: looksLikeStaleSensitiveQuery(normalized, freshnessNeed) ? 'required' : freshnessNeed,
      });
    }

    if (inference.knowledgeNeeds.includes('company_docs')) {
      addStep({
        need: 'company_docs',
        strategy: looksLikeExactDocumentQuery(normalized) ? 'doc_full_read' : 'doc_chunk_search',
        required: true,
        topK: looksLikeExactDocumentQuery(normalized) ? 2 : 6,
        freshness: 'none',
      });
    }

    if (inference.knowledgeNeeds.includes('hybrid_web')) {
      addStep({
        need: 'hybrid_web',
        strategy: 'internal_plus_web',
        required: true,
        topK: 5,
        freshness: 'required',
      });
    }

    if (inference.knowledgeNeeds.includes('relationship')) {
      addStep({
        need: 'relationship',
        strategy: inference.preferredStrategy ?? 'doc_chunk_search',
        required: false,
        topK: 6,
        freshness: freshnessNeed,
      });
    }

    return {
      knowledgeNeeds: inference.knowledgeNeeds,
      preferredStrategy: inference.preferredStrategy,
      steps,
      rationale: inference.rationale,
    };
  }
}

export const retrievalPlannerService = new RetrievalPlannerService();
