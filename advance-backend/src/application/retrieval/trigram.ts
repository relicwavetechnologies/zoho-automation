/**
 * Trigram-based filename similarity for fuzzy file lookup.
 * Ported from old backend — token-overlap prioritized over character trigrams.
 */

const FILE_TYPE_WORDS = new Set([
  'pdf', 'doc', 'docx', 'excel', 'xlsx', 'xls', 'sheet', 'sheets',
  'report', 'contract', 'invoice', 'ppt', 'pptx', 'slides', 'txt',
  'image', 'photo', 'html', 'htm', 'csv', 'tsv',
]);

function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFilename(name: string): string {
  // Strip extension first, then punctuation
  const noExt = name.replace(/\.[^.]+$/, '');
  return noExt
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQueryTokens(normalized: string): string[] {
  return normalized
    .split(/\s+/)
    .filter(t => t.length >= 2 && !FILE_TYPE_WORDS.has(t));
}

function buildTrigrams(s: string): Set<string> {
  const padded = `  ${s}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccardTrigrams(a: string, b: string): number {
  const ga = buildTrigrams(a);
  const gb = buildTrigrams(b);
  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection++;
  }
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function trigramSimilarity(query: string, filename: string): number {
  const normQuery   = normalizeQuery(query);
  const normFile    = normalizeFilename(filename);
  const queryTokens = extractQueryTokens(normQuery);

  if (queryTokens.length === 0) {
    // Only file-type words — fall back to full string match
    return normFile.includes(normQuery) ? 0.85 : jaccardTrigrams(normQuery, normFile);
  }

  const matchCount = queryTokens.filter(t => normFile.includes(t)).length;
  const matchRatio = matchCount / queryTokens.length;

  // Stage 1: all meaningful tokens found → strong match
  if (matchRatio === 1) return 0.95;

  // Stage 2: majority of tokens found
  if (matchRatio >= 0.6) return 0.75;

  // Stage 3: tokens joined as a substring
  const querySubstring = queryTokens.join(' ');
  if (querySubstring.length >= 3 && normFile.includes(querySubstring)) return 0.88;

  // Stage 4: full normalized query as substring
  if (normQuery.length >= 3 && normFile.includes(normQuery)) return 0.85;

  // Stage 5: character-level Jaccard trigram
  return jaccardTrigrams(normQuery, normFile);
}

export const TRIGRAM_STRONG_THRESHOLD    = 0.8;
export const TRIGRAM_CANDIDATE_THRESHOLD = 0.2;

export function rankByTrigram(
  query: string,
  filenames: string[],
): Array<{ filename: string; score: number }> {
  return filenames
    .map(fn => ({ filename: fn, score: trigramSimilarity(query, fn) }))
    .filter(r => r.score >= TRIGRAM_CANDIDATE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}
