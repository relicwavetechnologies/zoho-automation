/**
 * Expands a file search query into 2–6 semantic variants for parallel retrieval.
 * Ported from old backend's file-search-query.ts.
 */

const STOPWORDS = /\b(what|is|are|the|a|an|please|show|me|our|this|that|for|with|from|about|tell|give|latest|current|today|now|find|get|search|look|up|document|file|doc|pdf|html|sheet)\b/gi;

const EXACT_INTENT   = /\b(exact|verbatim|clause|definition|wording|quote)\b/i;
const POLICY_INTENT  = /\b(policy|handbook|rule|guideline|procedure|sop)\b/i;
const CONTRACT_INTENT = /\b(contract|agreement|terms|mou|nda|sla)\b/i;
const MULTI_INTENT   = /\b(compare|across|between|versus|vs|impact|relationship|related)\b/i;

function focusPhrase(query: string): string {
  return query
    .replace(STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBroadQuery(query: string): string[] {
  // Split on conjunctions/comparisons
  return query
    .split(/\b(and|,|versus|vs|between|compare|across)\b/i)
    .map(p => p.trim())
    .filter(p => p.length >= 3 && !/^(and|,|versus|vs|between|compare|across)$/i.test(p));
}

export function expandFileSearchQuery(query: string): string[] {
  const queries = new Set<string>([query]);
  const focused  = focusPhrase(query);
  if (focused && focused !== query) queries.add(focused);

  if (EXACT_INTENT.test(query)) {
    queries.add(`${focused} clause`);
    queries.add(`${focused} section`);
    queries.add(`${focused} policy`);
  }

  if (POLICY_INTENT.test(query)) {
    queries.add(`${focused} rule`);
    queries.add(`${focused} guidance`);
  }

  if (CONTRACT_INTENT.test(query)) {
    queries.add(`${focused} agreement terms`);
  }

  if (MULTI_INTENT.test(query) || /\band\b/i.test(query) || query.includes(',')) {
    splitBroadQuery(query).forEach(part => queries.add(part));
  }

  return Array.from(queries).slice(0, 6);
}

/** Strip noise to produce a broader fallback query for corrective retry. */
export function broadenQuery(query: string): string {
  return focusPhrase(query)
    .split(/\s+/)
    .slice(0, 4)   // keep first 4 meaningful tokens
    .join(' ');
}
