// ============================================================
// CANONICAL INTENT CLASSIFIER
// Single source of truth for operation and domain classification.
// All consumers must read from here — never add local keyword lists.
// ============================================================

export const SEND_VERBS = [
  'send', 'email', 'mail', 'draft', 'reply', 'forward',
  'remind', 'notify', 'ping', 'message', 'dm',
] as const;

export const WRITE_VERBS = [
  'create', 'save', 'update', 'edit', 'modify', 'rename',
  'write', 'add', 'set', 'change', 'record', 'log',
  'import', 'upload', 'convert', 'make', 'generate',
] as const;

export const ACTION_VERBS = [
  'schedule', 'enable', 'disable', 'pause', 'resume', 'run',
  'approve', 'assign', 'reassign', 'reconcile', 'book',
  'confirm', 'submit', 'process', 'execute', 'trigger',
] as const;

export const DESTRUCTIVE_VERBS = [
  'delete', 'delte',
  'remove', 'drop', 'archive', 'clear',
  'overwrite', 'destroy', 'wipe', 'purge',
] as const;

export const READ_VERBS = [
  'get', 'show', 'list', 'find', 'fetch', 'retrieve',
  'search', 'look up', 'lookup', 'check', 'view',
  'display', 'tell me', 'what', 'which', 'how many',
  'inspect', 'open', 'read this', 'check this', 'look at',
  'what is in', 'what is shown',
] as const;

export const INSPECT_READ_TERMS = [
  'inspect', 'open', 'read this', 'check this', 'look at', 'what is in', 'what is shown', 'view',
] as const;

export const ALL_WRITE_LIKE_VERBS = [
  ...SEND_VERBS,
  ...WRITE_VERBS,
  ...ACTION_VERBS,
  ...DESTRUCTIVE_VERBS,
] as const;

export const BOOKS_DOMAIN_TERMS = [
  'invoice', 'invoices', 'estimate', 'estimates', 'bill', 'bills',
  'payment', 'payments', 'books', 'zoho books', 'vendor', 'vendors',
  'overdue', 'credit note', 'credit notes', 'sales order', 'sales orders',
  'purchase order', 'purchase orders', 'bank statement', 'bank statements',
  'balance', 'receivable', 'payable', 'expense', 'expenses',
] as const;

export const ZOHO_CRM_DOMAIN_TERMS = [
  'zoho', 'deal', 'deals', 'contact', 'contacts',
  'account', 'accounts', 'lead', 'leads', 'ticket', 'tickets',
  'crm', 'pipeline',
] as const;

export const OUTREACH_DOMAIN_TERMS = [
  'outreach', 'publisher', 'guest post', 'domain authority',
  'domain rating', ' da ', ' dr ',
] as const;

export const LARK_DOMAIN_TERMS = [
  'lark', 'task', 'tasks', 'lark task', 'feishu',
] as const;

export const CALENDAR_DOMAIN_TERMS = [
  'calendar', 'meeting', 'meetings', 'event', 'events',
  'schedule a', 'book a', 'appointment',
] as const;

export const GMAIL_DOMAIN_TERMS = [
  'gmail', 'google mail', 'my email', 'inbox',
] as const;

export const WEB_SEARCH_TERMS = [
  'search', 'look up', 'lookup', 'google', 'web', 'website',
  'site', 'domain', 'news', 'latest', 'current', 'research',
] as const;

export const LARK_DOC_TERMS = [
  'lark doc', 'lark docs', 'document', 'doc', 'write up',
  'documents', 'export', 'save this',
] as const;

export type OperationClass =
  | 'read'
  | 'write'
  | 'send'
  | 'action'
  | 'destructive'
  | 'general';

export type IntentDomain =
  | 'zoho_books'
  | 'zoho_crm'
  | 'outreach'
  | 'lark'
  | 'calendar'
  | 'gmail'
  | 'web_search'
  | 'lark_doc'
  | 'general';

export interface CanonicalIntent {
  operationClass: OperationClass;
  domain: IntentDomain;
  isWriteLike: boolean;
  isDestructive: boolean;
  isSendLike: boolean;
  matchedVerbs: string[];
  matchedDomainTerms: string[];
  confidence: number;
}

export type NarrowOperationClass =
  | 'read'
  | 'write'
  | 'send'
  | 'inspect'
  | 'schedule'
  | 'search';

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsTerm = (text: string, term: string): boolean => {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (!normalizedText || !normalizedTerm) {
    return false;
  }
  if (term.startsWith(' ') || term.endsWith(' ')) {
    return ` ${text.toLowerCase()} `.includes(term.toLowerCase());
  }
  if (normalizedTerm.includes(' ')) {
    return ` ${normalizedText} `.includes(` ${normalizedTerm} `);
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizedTerm)}(?=$|[^a-z0-9])`, 'i').test(normalizedText);
};

const matchTerms = (text: string, terms: readonly string[]): string[] =>
  terms.filter((term) => containsTerm(text, term));

export const toNarrowOperationClass = (intent: CanonicalIntent): NarrowOperationClass => {
  switch (intent.operationClass) {
    case 'send':
      return 'send';
    case 'write':
      return 'write';
    case 'action':
      return intent.domain === 'calendar' ? 'schedule' : 'write';
    case 'destructive':
      return 'write';
    case 'read':
      if (matchTerms(intent.matchedVerbs.join(' '), INSPECT_READ_TERMS).length > 0) {
        return 'inspect';
      }
      return intent.domain === 'web_search' ? 'search' : 'read';
    case 'general':
    default:
      return intent.domain === 'web_search' ? 'search' : 'read';
  }
};

export function classifyIntent(
  text: string,
  supplementarySignals?: {
    normalizedIntent?: string | null;
    plannerChosenOperationClass?: string | null;
    childRouterDomain?: string | null;
    childRouterOperationType?: string | null;
  },
): CanonicalIntent {
  const normalized = normalizeText(text);
  const combined = [
    normalized,
    normalizeText(supplementarySignals?.normalizedIntent ?? ''),
  ]
    .filter(Boolean)
    .join(' ');

  const matchedDestructive = matchTerms(combined, DESTRUCTIVE_VERBS);
  const matchedSend = matchTerms(combined, SEND_VERBS);
  const matchedWrite = matchTerms(combined, WRITE_VERBS);
  const matchedAction = matchTerms(combined, ACTION_VERBS);
  const matchedRead = matchTerms(combined, READ_VERBS);

  const plannerClass = normalizeText(supplementarySignals?.plannerChosenOperationClass ?? '');
  const childRouterOperationType = normalizeText(supplementarySignals?.childRouterOperationType ?? '');

  let operationClass: OperationClass = 'general';
  let matchedVerbs: string[] = [];

  if (matchedDestructive.length > 0) {
    operationClass = 'destructive';
    matchedVerbs = matchedDestructive;
  } else if (matchedSend.length > 0) {
    operationClass = 'send';
    matchedVerbs = matchedSend;
  } else if (matchedWrite.length > 0) {
    operationClass = 'write';
    matchedVerbs = matchedWrite;
  } else if (matchedAction.length > 0) {
    operationClass = 'action';
    matchedVerbs = matchedAction;
  } else if (matchedRead.length > 0) {
    operationClass = 'read';
    matchedVerbs = matchedRead;
  } else if (['write', 'send', 'execute'].includes(plannerClass)) {
    operationClass = plannerClass === 'send' ? 'send' : 'write';
  } else if (['write', 'send', 'inspect', 'schedule', 'search', 'read'].includes(childRouterOperationType)) {
    switch (childRouterOperationType) {
      case 'send':
        operationClass = 'send';
        break;
      case 'schedule':
        operationClass = 'action';
        break;
      case 'search':
      case 'inspect':
      case 'read':
        operationClass = 'read';
        break;
      case 'write':
      default:
        operationClass = 'write';
        break;
    }
  }

  const matchedBooksDomain = matchTerms(combined, BOOKS_DOMAIN_TERMS);
  const matchedZohoCrmDomain = matchTerms(combined, ZOHO_CRM_DOMAIN_TERMS);
  const matchedOutreachDomain = matchTerms(combined, OUTREACH_DOMAIN_TERMS);
  const matchedLarkDomain = matchTerms(combined, LARK_DOMAIN_TERMS);
  const matchedCalendarDomain = matchTerms(combined, CALENDAR_DOMAIN_TERMS);
  const matchedGmailDomain = matchTerms(combined, GMAIL_DOMAIN_TERMS);
  const matchedWebDomain = matchTerms(combined, WEB_SEARCH_TERMS);
  const matchedDocDomain = matchTerms(combined, LARK_DOC_TERMS);

  let domain: IntentDomain = 'general';
  let matchedDomainTerms: string[] = [];

  if (matchedBooksDomain.length > 0) {
    domain = 'zoho_books';
    matchedDomainTerms = matchedBooksDomain;
  } else if (matchedZohoCrmDomain.length > 0) {
    domain = 'zoho_crm';
    matchedDomainTerms = matchedZohoCrmDomain;
  } else if (matchedOutreachDomain.length > 0) {
    domain = 'outreach';
    matchedDomainTerms = matchedOutreachDomain;
  } else if (matchedCalendarDomain.length > 0) {
    domain = 'calendar';
    matchedDomainTerms = matchedCalendarDomain;
  } else if (matchedDocDomain.length > 0) {
    domain = 'lark_doc';
    matchedDomainTerms = matchedDocDomain;
  } else if (matchedLarkDomain.length > 0) {
    domain = 'lark';
    matchedDomainTerms = matchedLarkDomain;
  } else if (matchedGmailDomain.length > 0) {
    domain = 'gmail';
    matchedDomainTerms = matchedGmailDomain;
  } else if (matchedWebDomain.length > 0) {
    domain = 'web_search';
    matchedDomainTerms = matchedWebDomain;
  }

  if (supplementarySignals?.childRouterDomain && matchedDomainTerms.length === 0) {
    domain = supplementarySignals.childRouterDomain as IntentDomain;
  }

  const isWriteLike = ['write', 'send', 'action', 'destructive'].includes(operationClass);
  const isDestructive = operationClass === 'destructive';
  const isSendLike = operationClass === 'send';
  const totalMatches = matchedVerbs.length + matchedDomainTerms.length;
  const confidence = Math.min(1, totalMatches * 0.2 + 0.4);

  return {
    operationClass,
    domain,
    isWriteLike,
    isDestructive,
    isSendLike,
    matchedVerbs,
    matchedDomainTerms,
    confidence,
  };
}

export function detectRouteIntentCompat(
  text: string,
): 'zoho_read' | 'write_intent' | 'general' {
  const intent = classifyIntent(text);
  if (intent.domain === 'zoho_crm' || intent.domain === 'outreach') return 'zoho_read';
  if (intent.domain === 'zoho_books') return 'write_intent';
  if (intent.isWriteLike) return 'write_intent';
  return 'general';
}

export function isWriteLikeIntentCompat(
  latestUserMessage: string,
  normalizedIntent?: string | null,
  plannerChosenOperationClass?: string | null,
): boolean {
  return classifyIntent(latestUserMessage, {
    normalizedIntent,
    plannerChosenOperationClass,
  }).isWriteLike;
}

export function isDestructiveIntentCompat(
  latestUserMessage: string,
  normalizedIntent?: string | null,
): boolean {
  return classifyIntent(latestUserMessage, { normalizedIntent }).isDestructive;
}
