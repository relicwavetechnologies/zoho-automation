/** Ported and adapted from old backend: file-search-query.ts */

const normalizeQuery = (value: string): string => value.trim().replace(/\s+/g, ' ');

const stopwordPattern = /\b(what|is|are|the|a|an|please|show|me|our|this|that|for|with|from|about|tell|give|latest|current|today|now)\b/gi;
const exactIntentPattern = /\b(exact|verbatim|quote|wording|clause|definition|exception|exceptions|section)\b/i;
const multiIntentPattern = /\b(compare|across|between|impact|connected|relationship|related|versus|vs)\b/i;

function focusDocPhrase(query: string): string {
  const normalized = normalizeQuery(query);
  const stripped = normalized
    .replace(stopwordPattern, ' ')
    .replace(/[?"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : normalized;
}

function splitBroadQuery(query: string): string[] {
  const normalized = normalizeQuery(query);
  if (!multiIntentPattern.test(normalized) && !/\band\b/i.test(normalized) && !normalized.includes(',')) {
    return [];
  }
  return normalized
    .split(/\bcompare\b|\bversus\b|\bvs\b|\bacross\b|\bbetween\b|\band\b|,/i)
    .map(part => focusDocPhrase(part))
    .filter(part => part.length >= 8);
}

/** Expand a user query into up to 6 retrieval variants. */
export function buildDocumentSearchQueries(query: string): string[] {
  const normalized = normalizeQuery(query);
  const queries = new Set<string>([normalized]);
  const focused = focusDocPhrase(normalized);

  const wantsExpansion = toWords(normalized).length <= 8 || exactIntentPattern.test(normalized);
  if (wantsExpansion) {
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

  if (multiIntentPattern.test(normalized) || /\band\b/i.test(normalized) || normalized.includes(',')) {
    splitBroadQuery(normalized).forEach(part => queries.add(part));
  }

  return Array.from(queries).filter(e => e.length > 0).slice(0, 6);
}

/** Relax a query for a retry — strip exactness markers. */
export function broadenDocumentSearchQuery(query: string): string {
  const broadened = normalizeQuery(query)
    .replace(/\b(exact|verbatim|quote|wording|latest|current|today|now|please)\b/gi, ' ')
    .replace(/\b(clause|definition|exception|exceptions)\b/gi, ' section ')
    .replace(/\s+/g, ' ')
    .trim();
  return broadened.length > 0 ? broadened : normalizeQuery(query);
}

/** Keywords that signal the user wants the full document text, not a chunk search. */
export const EXACT_DOC_KEYWORDS = /\b(exact|verbatim|quote|full text|full document|entire document|whole document|every word|precise wording|exact clause|give me the clause|cancellation clause|exact wording|exact phrase|section \d|article \d)\b/i;

export function looksLikeExactDocumentQuery(query: string): boolean {
  return EXACT_DOC_KEYWORDS.test(query);
}

function toWords(value: string): string[] {
  return value.split(/\s+/).filter(w => w.length > 0);
}
