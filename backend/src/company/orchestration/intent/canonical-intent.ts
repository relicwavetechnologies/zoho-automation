// ============================================================
// CANONICAL INTENT CLASSIFIER
// Single source of truth for operation and domain classification.
// All consumers must read from here — never add local keyword lists.
// ============================================================

import { z } from 'zod';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { withProviderRetry } from '../../../utils/provider-retry';

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
  'bakaya', 'baaki',
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

export const CONTINUATION_PHRASES = [
  'try again',
  'retry',
  'check again',
  'once more',
  'do it again',
  'again',
  'redo',
  'repeat',
  're-check',
  'recheck',
  'try once more',
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
  isContinuation?: boolean;
  matchedVerbs: string[];
  matchedDomainTerms: string[];
  confidence: number;
}

export type CanonicalIntentRuntimeCache = {
  canonicalIntent?: CanonicalIntent;
  canonicalIntentPromise?: Promise<CanonicalIntent>;
};

export type PriorToolResultSignal = {
  status?: string | null;
  confirmedAction?: boolean | null;
  attemptedWrite?: boolean | null;
  operation?: string | null;
};

export type NarrowOperationClass =
  | 'read'
  | 'write'
  | 'send'
  | 'inspect'
  | 'schedule'
  | 'search';

const CANONICAL_INTENT_CLASSIFIER_TIMEOUT_MS = 3_000;

const CANONICAL_INTENT_CLASSIFIER_SYSTEM_PROMPT = `
You are a canonical intent classifier. Return ONLY a JSON object, no other text.

operationClass: read | write | send | action | destructive | general
domain: zoho_books | zoho_crm | outreach | lark | calendar | gmail | web_search | lark_doc | general
isContinuation: boolean
matchedVerbs: array of short verb/domain cue strings found in the request
matchedDomainTerms: array of short domain cue strings found in the request
confidence: 0.0-1.0

Rules:
- send: email/mail/draft/reply/forward/message/dm/remind/notify
- write: create/save/update/edit/modify/rename/write/add/set/change/import/upload/generate
- action: schedule/enable/disable/pause/resume/run/approve/assign/reconcile/book/confirm/submit/process/execute/trigger
- destructive: delete/remove/drop/archive/clear/overwrite/destroy/wipe/purge
- read: get/show/list/find/fetch/retrieve/search/look up/check/view/inspect/open/read
- Use domain=zoho_books for invoices, estimates, bills, payments, vendors, overdue, balances, bank statements
- Use domain=zoho_crm for CRM/deals/contacts/accounts/leads/tickets/pipeline
- Use domain=outreach for outreach/publishers/guest posts/domain authority/domain rating
- Use domain=calendar for meetings/events/appointments/calendar scheduling
- Use domain=gmail for gmail/google mail/inbox/email operations
- Use domain=lark_doc for Lark docs/documents/write-up/export/save this document
- Use domain=lark for Lark tasks/messages/base/approvals when no more specific write doc/calendar domain applies
- Use domain=web_search for web/google/news/latest/current/research requests
- Set isContinuation=true only when the message is clearly a retry/continue/follow-up with little standalone intent
- Do not include explanatory prose.
`.trim();

const canonicalIntentSchema = z.object({
  operationClass: z.enum(['read', 'write', 'send', 'action', 'destructive', 'general']),
  domain: z.enum(['zoho_books', 'zoho_crm', 'outreach', 'lark', 'calendar', 'gmail', 'web_search', 'lark_doc', 'general']),
  isContinuation: z.boolean().optional().default(false),
  matchedVerbs: z.array(z.string().trim().min(1)).max(16).optional().default([]),
  matchedDomainTerms: z.array(z.string().trim().min(1)).max(16).optional().default([]),
  confidence: z.number().min(0).max(1),
});

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

const extractFirstJsonObject = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return trimmed.slice(start, end + 1);
};

export const isBareContinuationMessage = (value: string | null | undefined): boolean => {
  const normalized = normalizeText(value ?? '').replace(/[.!?]+$/g, '').trim();
  return CONTINUATION_PHRASES.some((phrase) => normalized === phrase);
};

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

const HINGLISH_BOOKS_DOMAIN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bbakaya\b/i, label: 'bakaya' },
  { pattern: /\bbaaki\b/i, label: 'baaki' },
  { pattern: /\boverdue\s+payment/i, label: 'overdue payment' },
  { pattern: /\bpending\s+payment/i, label: 'pending payment' },
  { pattern: /\bpayment\s+list/i, label: 'payment list' },
  { pattern: /\bcustomer\s+overdue/i, label: 'customer overdue' },
  { pattern: /\boverdue\s+customer/i, label: 'overdue customer' },
  { pattern: /\binvoice\s+no\b/i, label: 'invoice no' },
  { pattern: /\bnikal(?:\s+ke)?\s+de\s+do\b/i, label: 'nikal ke de do' },
];

const matchRegexTerms = (
  text: string,
  patterns: Array<{ pattern: RegExp; label: string }>,
): string[] => patterns
  .filter(({ pattern }) => pattern.test(text))
  .map(({ label }) => label);

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
    priorToolResults?: PriorToolResultSignal[] | null;
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
  const priorToolResults = supplementarySignals?.priorToolResults ?? [];
  const bareContinuation = isBareContinuationMessage(text);

  let operationClass: OperationClass = 'general';
  let matchedVerbs: string[] = [];

  if (bareContinuation && priorToolResults.length > 0) {
    const priorHadWriteAttempt = priorToolResults.some((result) => result.confirmedAction === true || result.attemptedWrite === true);
    const priorHadSendAttempt = priorToolResults.some((result) =>
      (result.confirmedAction === true || result.attemptedWrite === true)
      && normalizeText(result.operation ?? '') === 'send',
    );
    operationClass = priorHadWriteAttempt
      ? (priorHadSendAttempt ? 'send' : 'write')
      : 'read';
    matchedVerbs = ['continuation'];
  } else if (matchedDestructive.length > 0) {
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

  const matchedBooksDomain = [
    ...matchTerms(combined, BOOKS_DOMAIN_TERMS),
    ...matchRegexTerms(combined, HINGLISH_BOOKS_DOMAIN_PATTERNS),
  ].filter((term, index, values) => values.indexOf(term) === index);
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
    ...(bareContinuation ? { isContinuation: true } : {}),
    matchedVerbs,
    matchedDomainTerms,
    confidence,
  };
}

const normalizeCanonicalIntent = (input: {
  parsed: z.infer<typeof canonicalIntentSchema>;
  text: string;
  supplementarySignals?: {
    normalizedIntent?: string | null;
    plannerChosenOperationClass?: string | null;
    childRouterDomain?: string | null;
    childRouterOperationType?: string | null;
    priorToolResults?: PriorToolResultSignal[] | null;
  };
}): CanonicalIntent => {
  const fallback = classifyIntent(input.text, input.supplementarySignals);
  const bareContinuation = isBareContinuationMessage(input.text);
  const priorToolResults = input.supplementarySignals?.priorToolResults ?? [];
  const parsedContinuation = input.parsed.isContinuation || bareContinuation;

  let operationClass = input.parsed.operationClass;
  if (parsedContinuation && priorToolResults.length > 0) {
    operationClass = fallback.operationClass;
  }

  let domain = input.parsed.domain;
  if (
    domain === 'general'
    && input.supplementarySignals?.childRouterDomain
    && fallback.domain !== 'general'
  ) {
    domain = fallback.domain;
  }

  const matchedVerbs = input.parsed.matchedVerbs.length > 0
    ? input.parsed.matchedVerbs
    : fallback.matchedVerbs;
  const matchedDomainTerms = input.parsed.matchedDomainTerms.length > 0
    ? input.parsed.matchedDomainTerms
    : fallback.matchedDomainTerms;

  return {
    operationClass,
    domain,
    isWriteLike: ['write', 'send', 'action', 'destructive'].includes(operationClass),
    isDestructive: operationClass === 'destructive',
    isSendLike: operationClass === 'send',
    ...(parsedContinuation ? { isContinuation: true } : {}),
    matchedVerbs,
    matchedDomainTerms,
    confidence: Math.max(input.parsed.confidence, fallback.confidence * 0.5),
  };
};

const buildCanonicalIntentClassifierPrompt = (input: {
  message: string;
  supplementarySignals?: {
    normalizedIntent?: string | null;
    plannerChosenOperationClass?: string | null;
    childRouterDomain?: string | null;
    childRouterOperationType?: string | null;
    priorToolResults?: PriorToolResultSignal[] | null;
  };
}): string => {
  const parts = [
    `Message: ${input.message.trim()}`,
  ];
  if (input.supplementarySignals?.normalizedIntent?.trim()) {
    parts.push(`Normalized intent hint: ${input.supplementarySignals.normalizedIntent.trim()}`);
  }
  if (input.supplementarySignals?.plannerChosenOperationClass?.trim()) {
    parts.push(`Planner operation hint: ${input.supplementarySignals.plannerChosenOperationClass.trim()}`);
  }
  if (input.supplementarySignals?.childRouterDomain?.trim()) {
    parts.push(`Child-router domain hint: ${input.supplementarySignals.childRouterDomain.trim()}`);
  }
  if (input.supplementarySignals?.childRouterOperationType?.trim()) {
    parts.push(`Child-router operation hint: ${input.supplementarySignals.childRouterOperationType.trim()}`);
  }
  if ((input.supplementarySignals?.priorToolResults?.length ?? 0) > 0) {
    parts.push(`Prior tool result hints: ${JSON.stringify(input.supplementarySignals?.priorToolResults ?? [])}`);
  }
  return parts.join('\n');
};

const classifyIntentWithGroq = async (input: {
  message: string;
  supplementarySignals?: {
    normalizedIntent?: string | null;
    plannerChosenOperationClass?: string | null;
    childRouterDomain?: string | null;
    childRouterOperationType?: string | null;
    priorToolResults?: PriorToolResultSignal[] | null;
  };
}): Promise<CanonicalIntent> => {
  const trimmedMessage = input.message.trim();
  if (!trimmedMessage || !config.GROQ_API_KEY.trim()) {
    return classifyIntent(input.message, input.supplementarySignals);
  }

  try {
    const response = await withProviderRetry('groq', async () => {
      const nextResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.GROQ_ROUTER_MODEL,
          temperature: 0,
          max_tokens: 180,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: CANONICAL_INTENT_CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: buildCanonicalIntentClassifierPrompt(input) },
          ],
        }),
        signal: AbortSignal.timeout(CANONICAL_INTENT_CLASSIFIER_TIMEOUT_MS),
      });

      if (!nextResponse.ok) {
        const error: Error & {
          status?: number;
          headers?: Record<string, string>;
        } = new Error(`canonical_intent_classifier_http_${nextResponse.status}`);
        error.status = nextResponse.status;
        error.headers = Object.fromEntries(nextResponse.headers.entries());
        throw error;
      }

      return nextResponse;
    });

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
    const json = extractFirstJsonObject(content);
    if (!json) {
      throw new Error('canonical_intent_classifier_no_json');
    }

    return normalizeCanonicalIntent({
      parsed: canonicalIntentSchema.parse(JSON.parse(json)),
      text: trimmedMessage,
      supplementarySignals: input.supplementarySignals,
    });
  } catch (error) {
    logger.warn('canonical_intent_classifier.failed', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return classifyIntent(input.message, input.supplementarySignals);
  }
};

export const resolveCanonicalIntent = async (input: {
  runtime?: CanonicalIntentRuntimeCache | null;
  message: string;
  supplementarySignals?: {
    normalizedIntent?: string | null;
    plannerChosenOperationClass?: string | null;
    childRouterDomain?: string | null;
    childRouterOperationType?: string | null;
    priorToolResults?: PriorToolResultSignal[] | null;
  };
}): Promise<CanonicalIntent> => {
  if (input.runtime?.canonicalIntent) {
    return input.runtime.canonicalIntent;
  }
  if (input.runtime?.canonicalIntentPromise) {
    return input.runtime.canonicalIntentPromise;
  }

  const promise = classifyIntentWithGroq({
    message: input.message,
    supplementarySignals: input.supplementarySignals,
  })
    .then((intent) => {
      if (input.runtime) {
        input.runtime.canonicalIntent = intent;
      }
      return intent;
    })
    .finally(() => {
      if (input.runtime) {
        delete input.runtime.canonicalIntentPromise;
      }
    });

  if (input.runtime) {
    input.runtime.canonicalIntentPromise = promise;
  }

  return promise;
};

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

export const getCachedCanonicalIntent = resolveCanonicalIntent;
