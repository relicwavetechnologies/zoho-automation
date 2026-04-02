import { z } from 'zod';

import config from '../../config';
import { logger } from '../../utils/logger';
import { withProviderRetry } from '../../utils/provider-retry';

export type SearchIntent = {
  queryType: 'company_entity' | 'person_entity' | 'financial_record' | 'document' | 'conversation' | 'general';
  extractedEntity: string | null;
  extractedEntityType: 'company' | 'person' | 'unknown' | null;
  lookupTarget: 'contact_info' | 'entity_info' | 'general';
  sourceHint: 'books' | 'crm' | 'files' | 'web' | 'history' | 'lark' | null;
  language: 'en' | 'hi' | 'mixed';
  dateRange: { from: string; to: string } | null;
  isBareMention: boolean;
  isContinuation: boolean;
  inheritEntityFromThread: boolean;
  confidence: number;
};

export type SearchIntentRuntimeCache = {
  searchIntent?: SearchIntent;
  searchIntentPromise?: Promise<SearchIntent>;
};

const SEARCH_INTENT_CLASSIFIER_MODEL = 'llama-3.1-8b-instant';
const SEARCH_INTENT_CLASSIFIER_TIMEOUT_MS = 3_000;

const SEARCH_INTENT_CLASSIFIER_SYSTEM_PROMPT = `
You are a search intent classifier. Return ONLY a JSON object, no other text.

queryType: company_entity | person_entity | financial_record | document | conversation | general
extractedEntity: the name being searched, or null
extractedEntityType: company | person | unknown | null
lookupTarget: contact_info | entity_info | general
sourceHint: books | crm | files | web | history | lark | null — ONLY if user explicitly named a source
language: en | hi | mixed
dateRange: {from: "YYYY-MM-DD", to: "YYYY-MM-DD"} or null
isBareMention: true if message is only a @mention with no real content
isContinuation: true if user says retry/again/same/wahi/fir se/continue
inheritEntityFromThread: true if message has no entity but references a prior search
confidence: 0.0-1.0

Rules:
- company_entity: searching for a company/vendor/customer by name (LLC/Inc/Ltd/Pvt are strong signals)
- contact_info: email/phone/mobile/contact number/address/contact info for a person
- financial_record: invoice/payment/overdue/statement/balance/bakaya/due
- extractedEntity: strip all search verbs, extract only the name
- sourceHint: null unless user says "in books", "from crm", "books mein", "on web" explicitly
- isBareMention: message stripped of @mentions is empty or under 3 words with no entity
- isContinuation: "retry", "fir se", "wahi", "same", "phir", "again", "continue"
- inheritEntityFromThread: message has clear search intent but no extractable entity
`.trim();

const searchIntentSchema = z.object({
  queryType: z.enum(['company_entity', 'person_entity', 'financial_record', 'document', 'conversation', 'general']),
  extractedEntity: z.string().trim().min(1).nullable(),
  extractedEntityType: z.enum(['company', 'person', 'unknown']).nullable(),
  lookupTarget: z.enum(['contact_info', 'entity_info', 'general']),
  sourceHint: z.enum(['books', 'crm', 'files', 'web', 'history', 'lark']).nullable(),
  language: z.enum(['en', 'hi', 'mixed']),
  dateRange: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).nullable(),
  isBareMention: z.boolean(),
  isContinuation: z.boolean(),
  inheritEntityFromThread: z.boolean(),
  confidence: z.number().min(0).max(1),
});

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

const inferFallbackLanguage = (message: string): SearchIntent['language'] => {
  if (/[\u0900-\u097f]/u.test(message)) {
    return /[a-z]/i.test(message) ? 'mixed' : 'hi';
  }
  if (/\b(bakaya|fir se|phir|wahi|mein|tak|do)\b/i.test(message)) {
    return 'mixed';
  }
  return 'en';
};

const CONTINUATION_RE = /\b(retry|fir se|phir|wahi|same|again|continue)\b/i;
const INHERIT_ENTITY_RE = /\b(it|this|that|same|wahi|phir|again|continue)\b/i;
const SEARCH_REFERENCE_RE = /\b(search|search context|context|lookup|look up|find|use search context)\b/i;
const COMPANY_SUFFIX_RE = /\b(llc|inc|ltd|limited|corp|corporation|company|private limited|pvt ltd|gmbh|plc)\b/i;
const CONTACT_LOOKUP_RE = /\b(contact|contact info|email|mail|phone|mobile|number|address)\b/i;
const PERSON_QUERY_HINT_RE = /\b([a-z]{2,}\s*(?:,\s*[a-z]{2,})+|[a-z]{2,}\s+and\s+[a-z]{2,})\b/i;

const stripMentions = (message: string): string =>
  message.replace(/@[a-z0-9._-]+/gi, ' ').replace(/\s+/g, ' ').trim();

const inferBareMention = (message: string, extractedEntity: string | null): boolean => {
  const stripped = stripMentions(message);
  if (!stripped) {
    return true;
  }
  const tokenCount = stripped.split(/\s+/).filter(Boolean).length;
  return tokenCount < 3 && !extractedEntity;
};

const shouldInheritEntityFromThread = (message: string, extractedEntity: string | null): boolean => {
  const stripped = stripMentions(message);
  if (extractedEntity && normalize(extractedEntity).length > 0 && normalize(stripped).includes(normalize(extractedEntity))) {
    return false;
  }
  return INHERIT_ENTITY_RE.test(stripped) && SEARCH_REFERENCE_RE.test(stripped);
};

const normalize = (value: string): string => value.trim().toLowerCase();

const buildFallbackIntent = (message: string): SearchIntent => ({
  queryType: 'general',
  extractedEntity: null,
  extractedEntityType: null,
  lookupTarget: 'general',
  sourceHint: null,
  language: inferFallbackLanguage(message),
  dateRange: null,
  isBareMention: false,
  isContinuation: false,
  inheritEntityFromThread: false,
  confidence: 0,
});

const normalizeIntent = (intent: SearchIntent, message: string): SearchIntent => {
  const normalizedLanguage = inferFallbackLanguage(message);
  const extractedEntity = intent.extractedEntity?.trim() ?? null;
  const inheritEntityFromThread = intent.inheritEntityFromThread || shouldInheritEntityFromThread(message, extractedEntity);
  const isContinuation = intent.isContinuation || CONTINUATION_RE.test(message);
  const isBareMention = intent.isBareMention || inferBareMention(message, extractedEntity);
  const language =
    intent.language === 'en' && normalizedLanguage !== 'en'
      ? normalizedLanguage
      : intent.language;
  const sanitizedExtractedEntity = inheritEntityFromThread
    ? null
    : extractedEntity;
  const extractedEntityType = sanitizedExtractedEntity
    ? (intent.extractedEntityType ?? (COMPANY_SUFFIX_RE.test(sanitizedExtractedEntity) ? 'company' : 'unknown'))
    : null;
  const lookupTarget = intent.lookupTarget === 'general' && CONTACT_LOOKUP_RE.test(message)
    ? 'contact_info'
    : intent.lookupTarget;
  const queryType =
    lookupTarget === 'contact_info'
      && (intent.queryType === 'conversation' || intent.queryType === 'general')
      && (
        extractedEntityType === 'person'
        || Boolean(sanitizedExtractedEntity)
        || PERSON_QUERY_HINT_RE.test(message)
      )
      ? 'person_entity'
      : intent.queryType;

  return {
    ...intent,
    queryType,
    extractedEntity: sanitizedExtractedEntity,
    extractedEntityType,
    lookupTarget,
    language,
    isBareMention,
    isContinuation,
    inheritEntityFromThread,
  };
};

const classifySearchIntentUncached = async (message: string): Promise<SearchIntent> => {
  const trimmedMessage = message.trim();
  if (!trimmedMessage || !config.GROQ_API_KEY.trim()) {
    return buildFallbackIntent(message);
  }

  try {
    const requestPayload = {
      model: SEARCH_INTENT_CLASSIFIER_MODEL,
      temperature: 0,
      max_tokens: 150,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SEARCH_INTENT_CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: trimmedMessage },
      ],
    };
    const response = await withProviderRetry('groq', async () => {
      const nextResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(SEARCH_INTENT_CLASSIFIER_TIMEOUT_MS),
      });

      if (!nextResponse.ok) {
        const error: Error & {
          status?: number;
          headers?: Record<string, string>;
        } = new Error(`search_intent_classifier_http_${nextResponse.status}`);
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
      throw new Error('search_intent_classifier_no_json');
    }

    return normalizeIntent(searchIntentSchema.parse(JSON.parse(json)), trimmedMessage);
  } catch (error) {
    logger.warn('search_intent_classifier.failed', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return buildFallbackIntent(message);
  }
};

export const resolveSearchIntent = async (input: {
  runtime?: SearchIntentRuntimeCache | null;
  message: string;
}): Promise<SearchIntent> => {
  if (input.runtime?.searchIntent) {
    return input.runtime.searchIntent;
  }
  if (input.runtime?.searchIntentPromise) {
    return input.runtime.searchIntentPromise;
  }

  const promise = classifySearchIntentUncached(input.message)
    .then((intent) => {
      if (input.runtime) {
        input.runtime.searchIntent = intent;
      }
      return intent;
    })
    .finally(() => {
      if (input.runtime) {
        delete input.runtime.searchIntentPromise;
      }
    });

  if (input.runtime) {
    input.runtime.searchIntentPromise = promise;
  }

  return promise;
};

export const searchIntentClassifier = {
  resolve: resolveSearchIntent,
  fallback: buildFallbackIntent,
};

export const classifySearchIntent = classifySearchIntentUncached;
export const getCachedSearchIntent = resolveSearchIntent;
export const SEARCH_INTENT_FALLBACK_RESULT = buildFallbackIntent('');
