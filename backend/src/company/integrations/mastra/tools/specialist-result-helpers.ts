import type { z } from 'zod';

const JSON_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;
const JSON_OBJECT_PATTERN = /\{[\s\S]*\}/;
const FAILURE_PATTERN = /\b(failed|error|not permitted|denied|unavailable|missing_document_id|could not)\b/i;
const URL_PATTERN = /https?:\/\/[^\s)]+/gi;
const LARK_DOC_URL_PATTERN = /\/docx\/([A-Za-z0-9]+)/i;
const KEYED_ID_PATTERN = /\b(?:record|deal|lead|contact|ticket|campaign|doc(?:ument)?|docx)(?:\s+(?:id|token))?[:#=\s'"]+([A-Za-z0-9_-]{6,})\b/ig;
const LONG_NUMERIC_ID_PATTERN = /\b(\d{12,})\b/g;
const LARK_TOKEN_PATTERN = /\b([A-Za-z0-9]{20,})\b/g;

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
