import type { z } from 'zod';
import {
  larkOperationalResultSchema,
  terminalOperationalResultSchema,
  type LarkOperationalResult,
  type TerminalOperationalResult,
} from '../schemas/specialist-results.schema';

const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;
const JSON_OBJECT_PATTERN = /\{[\s\S]*\}/;
const FAILURE_PATTERN = /\b(failed|error|not permitted|denied|unavailable|missing_document_id|could not)\b/i;
const URL_PATTERN = /https?:\/\/[^\s)]+/gi;
const LARK_DOC_URL_PATTERN = /\/docx\/([A-Za-z0-9]+)/i;
const KEYED_ID_PATTERN = /\b(?:record|deal|lead|contact|ticket|campaign|doc(?:ument)?|docx)(?:\s+(?:id|token))?[:#=\s'"]+([A-Za-z0-9_-]{6,})\b/ig;
const LONG_NUMERIC_ID_PATTERN = /\b(\d{12,})\b/g;
const LARK_TOKEN_PATTERN = /\b([A-Za-z0-9]{20,})\b/g;
const TASK_ID_PATTERN = /\btask(?:\s+id)?[:#=\s'"]+([A-Za-z0-9_-]{4,})\b/i;
const EVENT_ID_PATTERN = /\bevent(?:\s+id)?[:#=\s'"]+([A-Za-z0-9_-]{4,})\b/i;
const MISSING_INPUT_PATTERN = /\b(missing|required|provide|which|what time|what date|need more information|identifier)\b/i;
const PERMISSION_PATTERN = /\b(not permitted|permission denied|access to .* is not permitted|contact your admin)\b/i;
const UNSUPPORTED_PATTERN = /\b(not supported|unsupported|use lark calendar for day-based discovery)\b/i;
const RETRYABLE_FAILURE_PATTERN = /\b(timeout|temporar(?:ily)?|try again|rate limit|429|5\d\d|network)\b/i;
const API_FAILURE_PATTERN = /\b(failed|error|request failed|api failed|validation failed)\b/i;
const NO_RESULTS_PATTERN = /\b(no [^.]+ found|no [^.]+ matched|there are no [^.]+)\b/i;

const normalizeIdCandidate = (value: string): string => value.replace(/^['"`]+|['"`]+$/g, '').trim();

const isLikelyExternalId = (value: string): boolean => {
  const candidate = normalizeIdCandidate(value);
  if (!candidate || candidate.length < 6) {
    return false;
  }

  if (/^\d{12,}$/.test(candidate)) {
    return true;
  }

  if (/[_-]/.test(candidate)) {
    return true;
  }

  return /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate);
};

const extractLikelyIdFromPattern = (text: string, pattern: RegExp): string | undefined => {
  const scopedPattern = new RegExp(pattern.source, pattern.flags);
  let match = scopedPattern.exec(text);
  while (match) {
    const candidate = normalizeIdCandidate(match[1] ?? '');
    if (isLikelyExternalId(candidate)) {
      return candidate;
    }
    match = scopedPattern.exec(text);
  }
  return undefined;
};

export const parseJsonObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = JSON_CODE_BLOCK_PATTERN.exec(trimmed)?.[1]
    ?? JSON_OBJECT_PATTERN.exec(trimmed)?.[0]
    ?? trimmed;

  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

export const coerceSchema = <T>(schema: z.ZodType<T>, text: string): T | null => {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
};

export const summarizeSpecialistText = (text: string): string => {
  const summary = text.trim();
  return summary || 'No summary returned.';
};

export const hasFailureSignal = (text: string): boolean => FAILURE_PATTERN.test(text);

export const extractUrls = (text: string): string[] => {
  const matches = text.match(URL_PATTERN) ?? [];
  return Array.from(new Set(matches));
};

export const extractFirstUrl = (text: string): string | undefined => extractUrls(text)[0];

export const extractLarkDocToken = (text: string): string | undefined =>
  LARK_DOC_URL_PATTERN.exec(text)?.[1]
  ?? extractLikelyIdFromPattern(text, KEYED_ID_PATTERN)
  ?? extractLikelyIdFromPattern(text, LARK_TOKEN_PATTERN);

export const extractRecordId = (text: string): string | undefined =>
  extractLikelyIdFromPattern(text, KEYED_ID_PATTERN)
  ?? extractLikelyIdFromPattern(text, LONG_NUMERIC_ID_PATTERN);

export const extractZohoRecordId = (text: string): string | undefined =>
  extractLikelyIdFromPattern(text, LONG_NUMERIC_ID_PATTERN)
  ?? extractLikelyIdFromPattern(text, KEYED_ID_PATTERN);

export const buildStructuredJsonPrompt = (query: string, contract: string): string => [
  query.trim(),
  '',
  'Return JSON only matching this contract.',
  contract,
].join('\n');

const inferUserAction = (errorKind?: LarkOperationalResult['errorKind'], retryable?: boolean): string | undefined => {
  if (errorKind === 'permission') return 'Ask an admin to grant access to this Lark surface.';
  if (errorKind === 'missing_input') return 'Provide the missing identifier, date, or time detail and try again.';
  if (errorKind === 'unsupported') return 'Use the recommended Lark surface or provide a supported identifier.';
  if (errorKind === 'api_failure' && retryable) return 'Retry in a moment.';
  if (errorKind === 'api_failure') return 'Check the request details and try again.';
  return undefined;
};

export const normalizeLarkOperationalResult = (text: string): LarkOperationalResult => {
  const coerced = coerceSchema(larkOperationalResultSchema, text);
  if (coerced) {
    return larkOperationalResultSchema.parse({
      ...coerced,
      taskId: coerced.taskId ?? extractLikelyIdFromPattern(coerced.summary, TASK_ID_PATTERN),
      eventId: coerced.eventId ?? extractLikelyIdFromPattern(coerced.summary, EVENT_ID_PATTERN),
      documentId: coerced.documentId ?? extractLarkDocToken(coerced.summary),
      recordId: coerced.recordId ?? extractRecordId(coerced.summary),
      userAction: coerced.userAction ?? inferUserAction(coerced.errorKind, coerced.retryable),
    });
  }

  const summary = summarizeSpecialistText(text);
  const permission = PERMISSION_PATTERN.test(summary);
  const unsupported = UNSUPPORTED_PATTERN.test(summary);
  const missingInput = !permission && (
    (MISSING_INPUT_PATTERN.test(summary) && /\?$/.test(summary))
    || /ask for exactly/i.test(summary)
  );
  const apiFailure = !permission && !unsupported && API_FAILURE_PATTERN.test(summary);
  const noResults = !apiFailure && NO_RESULTS_PATTERN.test(summary);
  const errorKind: LarkOperationalResult['errorKind'] | undefined = permission
    ? 'permission'
    : unsupported
      ? 'unsupported'
      : missingInput
        ? 'missing_input'
        : apiFailure
          ? 'api_failure'
          : undefined;
  const retryable = errorKind === 'api_failure' ? RETRYABLE_FAILURE_PATTERN.test(summary) : undefined;
  const success = noResults || !errorKind;

  return larkOperationalResultSchema.parse({
    success,
    summary,
    ...(success ? {} : { error: summary, errorKind, retryable, userAction: inferUserAction(errorKind, retryable) }),
    ...(extractLikelyIdFromPattern(summary, TASK_ID_PATTERN) ? { taskId: extractLikelyIdFromPattern(summary, TASK_ID_PATTERN) } : {}),
    ...(extractLikelyIdFromPattern(summary, EVENT_ID_PATTERN) ? { eventId: extractLikelyIdFromPattern(summary, EVENT_ID_PATTERN) } : {}),
    ...(extractLarkDocToken(summary) ? { documentId: extractLarkDocToken(summary) } : {}),
    ...(extractRecordId(summary) ? { recordId: extractRecordId(summary) } : {}),
  });
};

export const normalizeTerminalOperationalResult = (text: string): TerminalOperationalResult => {
  const coerced = coerceSchema(terminalOperationalResultSchema, text);
  if (coerced) {
    return terminalOperationalResultSchema.parse({
      ...coerced,
      needsApproval: coerced.needsApproval ?? Boolean(coerced.command),
      userAction: coerced.userAction ?? (coerced.success ? undefined : 'Review the command plan or provide more context.'),
    });
  }

  const summary = summarizeSpecialistText(text);
  const permission = PERMISSION_PATTERN.test(summary);
  const missingInput = MISSING_INPUT_PATTERN.test(summary) && /\?$/.test(summary);
  const retryable = RETRYABLE_FAILURE_PATTERN.test(summary);
  const success = !FAILURE_PATTERN.test(summary);

  return terminalOperationalResultSchema.parse({
    success,
    summary,
    needsApproval: success ? undefined : undefined,
    ...(success ? {} : {
      error: summary,
      retryable,
      userAction: permission
        ? 'Ask an admin to grant terminal access.'
        : missingInput
          ? 'Provide the missing file path, command target, or runtime detail.'
          : retryable
            ? 'Retry the command plan in a moment.'
            : 'Review the command strategy or provide more context.',
    }),
  });
};
