import { retrievalFeatureFlags } from './retrieval-feature-flags';

export const DOCUMENT_SEARCH_ENHANCEMENTS = [
  'none',
  'query_expansion',
  'multi_query',
  'self_reflective_retry',
] as const;

export type DocumentSearchEnhancement = (typeof DOCUMENT_SEARCH_ENHANCEMENTS)[number];

const normalizeQuery = (value: string): string => value.trim().replace(/\s+/g, ' ');

const stopwordPattern = /\b(what|is|are|the|a|an|please|show|me|our|this|that|for|with|from|about|tell|give|latest|current|today|now)\b/gi;
const exactIntentPattern = /\b(exact|verbatim|quote|wording|clause|definition|exception|exceptions|section)\b/i;
const multiIntentPattern = /\b(compare|across|between|impact|connected|relationship|related|versus|vs)\b/i;

const focusDocPhrase = (query: string): string => {
  const normalized = normalizeQuery(query);
  const stripped = normalized
    .replace(stopwordPattern, ' ')
    .replace(/[?"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : normalized;
};

export const determineDocumentSearchEnhancements = (query: string): DocumentSearchEnhancement[] => {
  const normalized = normalizeQuery(query);
  const words = normalized.split(/\s+/).filter(Boolean);
  const enhancements = new Set<DocumentSearchEnhancement>();

  if (retrievalFeatureFlags.queryExpansion && (words.length <= 8 || exactIntentPattern.test(normalized))) {
    enhancements.add('query_expansion');
  }

  if (
    retrievalFeatureFlags.multiQuery
    && (multiIntentPattern.test(normalized) || /\band\b/i.test(normalized) || normalized.includes(','))
  ) {
    enhancements.add('multi_query');
  }

  if (retrievalFeatureFlags.selfReflectiveRetry) {
    enhancements.add('self_reflective_retry');
  }

  return enhancements.size > 0 ? Array.from(enhancements) : ['none'];
};

const splitBroadQuery = (query: string): string[] => {
  const normalized = normalizeQuery(query);
  if (!multiIntentPattern.test(normalized) && !/\band\b/i.test(normalized) && !normalized.includes(',')) {
    return [];
  }

  return normalized
    .split(/\bcompare\b|\bversus\b|\bvs\b|\bacross\b|\bbetween\b|\band\b|,/i)
    .map((part) => focusDocPhrase(part))
    .filter((part) => part.length >= 8);
};

export const buildDocumentSearchQueries = (query: string): string[] => {
  const normalized = normalizeQuery(query);
  const enhancements = determineDocumentSearchEnhancements(normalized);
  const queries = new Set<string>([normalized]);
  const focused = focusDocPhrase(normalized);

  if (enhancements.includes('query_expansion')) {
    queries.add(focused);
    if (exactIntentPattern.test(normalized)) {
      queries.add(`${focused} clause`);
      queries.add(`${focused} section`);
      queries.add(`${focused} policy`);
    }
    if (/\bpolicy|handbook\b/i.test(normalized)) {
      queries.add(`${focused} rule`);
      queries.add(`${focused} guidance`);
    }
    if (/\bcontract|agreement\b/i.test(normalized)) {
      queries.add(`${focused} agreement terms`);
    }
  }

  if (enhancements.includes('multi_query')) {
    splitBroadQuery(normalized).forEach((part) => queries.add(part));
  }

  return Array.from(queries).filter((entry) => entry.length > 0).slice(0, 6);
};

export const broadenDocumentSearchQuery = (query: string): string => {
  const broadened = normalizeQuery(query)
    .replace(/\b(exact|verbatim|quote|wording|latest|current|today|now|please)\b/gi, ' ')
    .replace(/\b(clause|definition|exception|exceptions)\b/gi, ' section ')
    .replace(/\s+/g, ' ')
    .trim();
  return broadened.length > 0 ? broadened : normalizeQuery(query);
};

