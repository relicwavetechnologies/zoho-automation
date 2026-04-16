/**
 * Trigram similarity utility for fuzzy filename matching.
 *
 * Design principles:
 *   - Query and filename are normalized DIFFERENTLY
 *     Query:    strip punctuation only — keep all words including "pdf", "doc" etc as search signals
 *     Filename: strip extension from end + strip punctuation — keep content words only
 *   - Multi-stage scoring: token overlap first, then substring, then Jaccard trigrams
 *   - File-type words ("pdf", "doc", "excel" etc) are stripped from token matching
 *     because they are query signals not content discriminators
 *
 * Examples:
 *   trigramSimilarity("mr market pdf", "Mr. Market Functional Doc.pdf")   → 0.95 (token overlap)
 *   trigramSimilarity("Q3 report", "Q3-Financial-Report-2024.xlsx")        → 0.75 (partial token)
 *   trigramSimilarity("mr market", "mr-market-2024.pdf")                   → 0.95 (token overlap)
 *   trigramSimilarity("contract anthropic", "Anthropic-Contract-2024.pdf") → 0.95 (token overlap)
 *   trigramSimilarity("random query", "totally-unrelated-file.pdf")        → low  (Jaccard)
 */

// File-type words to exclude from token matching — they are query signals not content words
const FILE_TYPE_WORDS = new Set([
  'pdf', 'doc', 'docx', 'file', 'excel', 'xlsx', 'xls', 'csv',
  'sheet', 'sheets', 'slides', 'ppt', 'pptx', 'txt', 'image',
  'img', 'report', 'attachment', 'contract', 'invoice',
]);

/**
 * Normalize a QUERY string for matching.
 * Keeps all words but strips punctuation and lowercases.
 * Does NOT strip file extensions (because "pdf" in query is a signal).
 */
const normalizeQuery = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Normalize a FILENAME string for matching.
 * Strips the file extension from the end, then strips punctuation.
 */
const normalizeFilename = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,6}$/i, '')  // strip extension from end only
    .replace(/[^a-z0-9\s]/g, ' ')       // strip punctuation/separators
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Extract meaningful tokens from a normalized query string.
 * Strips file-type words and very short tokens.
 */
const extractQueryTokens = (normalizedQuery: string): string[] =>
  normalizedQuery
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !FILE_TYPE_WORDS.has(t));

const buildTrigrams = (value: string): Set<string> => {
  const padded = `  ${value}  `;
  const trigrams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.slice(i, i + 3));
  }
  return trigrams;
};

const jaccardTrigrams = (a: string, b: string): number => {
  const ta = buildTrigrams(a);
  const tb = buildTrigrams(b);
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Compute similarity between a user query and a filename.
 *
 * Scoring stages (returns on first strong match):
 *   1. All meaningful query tokens present in filename tokens → 0.95
 *   2. Most (≥60%) meaningful query tokens present → 0.75
 *   3. Normalized query tokens join present as substring in filename → 0.88
 *   4. Jaccard trigram baseline
 *
 * @param query    - the user's search query (e.g. "mr market pdf")
 * @param filename - the filename to match against (e.g. "Mr. Market Functional Doc.pdf")
 * @returns number between 0 (no match) and 1 (perfect match)
 */
export const trigramSimilarity = (query: string, filename: string): number => {
  const normQuery = normalizeQuery(query);
  const normFile = normalizeFilename(filename);

  if (!normQuery || !normFile) return 0;
  if (normQuery === normFile) return 1;

  const queryTokens = extractQueryTokens(normQuery);
  const fileTokens = new Set(normFile.split(/\s+/).filter((t) => t.length >= 2));

  // Stage 1 — all meaningful query tokens found in filename
  if (queryTokens.length > 0) {
    const matchCount = queryTokens.filter((t) => fileTokens.has(t)).length;
    const matchRatio = matchCount / queryTokens.length;

    if (matchRatio === 1) return 0.95;
    if (matchRatio >= 0.6) return 0.75;
  }

  // Stage 2 — query tokens joined appear as substring in filename
  const querySubstring = queryTokens.join(' ');
  if (querySubstring.length >= 3 && normFile.includes(querySubstring)) return 0.88;

  // Stage 3 — full normalized query (including file-type words) as substring
  if (normQuery.length >= 3 && normFile.includes(normQuery)) return 0.85;

  // Stage 4 — Jaccard trigram baseline
  return jaccardTrigrams(normQuery, normFile);
};

/**
 * Score a query against a list of filenames.
 * Returns scored candidates sorted by score descending.
 *
 * Thresholds:
 *   score >= 0.8  → strong match (skip semantic search entirely, return immediately)
 *   score >  0.2  → candidate (include in Groq escalation pool)
 *   score <= 0.2  → skip
 */
export const scoreFilenameMatches = (
  query: string,
  filenames: string[],
): Array<{ filename: string; score: number }> =>
  filenames
    .map((filename) => ({ filename, score: trigramSimilarity(query, filename) }))
    .filter(({ score }) => score > 0.2)
    .sort((a, b) => b.score - a.score);

export const TRIGRAM_STRONG_MATCH_THRESHOLD = 0.8;
export const TRIGRAM_CANDIDATE_THRESHOLD = 0.2;

/**
 * Detect if a query looks like a filename reference.
 * Matches: has file extension, or contains known file-type keywords.
 */
export const isFilenameQuery = (query: string): boolean => {
  const lower = query.toLowerCase();
  return (
    /\.[a-z0-9]{2,6}\b/.test(lower) ||
    /\b(pdf|doc|docx|sheet|excel|xlsx|csv|file|report|contract|attachment|invoice|slides|ppt|pptx|txt|image|img)\b/.test(lower)
  );
};