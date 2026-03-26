type QueryEnrichmentAttachment = {
  fileName?: string;
  mimeType?: string;
};

type QueryEnrichmentTaskState = {
  activeObjective?: string | null;
  activeSourceArtifacts?: Array<{
    fileName?: string;
  }>;
};

type QueryEnrichmentThreadSummary = {
  latestUserGoal?: string | null;
  activeEntities?: string[];
  constraints?: string[];
};

export type QueryEnrichment = {
  rawMessage: string;
  cleanQuery: string;
  retrievalQuery: string;
  retrievalQueries: string[];
  exactTerms: string[];
  entityHints: string[];
  contextHints: string[];
};

const SHORTHAND_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bimg\b/gi, 'image'],
  [/\bpic\b/gi, 'picture'],
  [/\bmsg\b/gi, 'message'],
  [/\bdm\b/gi, 'direct message'],
  [/\bcal\b/gi, 'calendar'],
  [/\bschdeule\b/gi, 'schedule'],
  [/\bscehdule\b/gi, 'schedule'],
  [/\bcehck\b/gi, 'check'],
  [/\bwht\b/gi, 'what'],
];

const REFERENTIAL_QUERY_RE = /\b(this|that|it|same one|same file|same image|same doc|same document|same meeting|same task)\b/i;
const FILENAME_RE = /\b[\w @()+-]+\.(?:csv|pdf|png|jpg|jpeg|gif|doc|docx|xls|xlsx|txt)\b/gi;
const QUOTED_RE = /["']([^"']{2,160})["']/g;

const normalizeWhitespace = (value: string): string =>
  value.trim().replace(/\s+/g, ' ');

const uniq = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const summarize = (value: string, maxLength = 140): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

const normalizeArtifactName = (value?: string | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^lark_attachment_/i.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const expandShorthand = (value: string): string => {
  let next = value;
  for (const [pattern, replacement] of SHORTHAND_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  return normalizeWhitespace(next);
};

const extractQuotedTerms = (value: string): string[] => {
  const terms: string[] = [];
  for (const match of value.matchAll(QUOTED_RE)) {
    const captured = normalizeWhitespace(match[1] ?? '');
    if (captured) {
      terms.push(captured);
    }
  }
  return uniq(terms);
};

const extractFileNames = (value: string): string[] =>
  uniq(Array.from(value.matchAll(FILENAME_RE)).map((match) => normalizeWhitespace(match[0] ?? '')));

const extractSummaryEntities = (input?: QueryEnrichmentThreadSummary): string[] => {
  if (!input) {
    return [];
  }
  const values = [
    ...(input.activeEntities ?? []),
    ...(input.constraints ?? []),
    input.latestUserGoal ?? '',
  ];
  return uniq(values.map((value) =>
    summarize(
      normalizeWhitespace(
        value
          .replace(/^source:/i, '')
          .replace(/^Active source artifact:\s*/i, ''),
      ),
    ),
  ).filter((value) => value.length > 0 && !/^lark_attachment_/i.test(value)));
};

export const enrichQuery = (input: {
  rawMessage: string;
  attachedFiles?: QueryEnrichmentAttachment[];
  taskState?: QueryEnrichmentTaskState | null;
  threadSummary?: QueryEnrichmentThreadSummary | null;
  relevantMemoryFacts?: string[];
}): QueryEnrichment => {
  const rawMessage = normalizeWhitespace(input.rawMessage);
  const cleanQuery = expandShorthand(rawMessage);
  const exactTerms = uniq([
    ...extractQuotedTerms(rawMessage),
    ...extractFileNames(rawMessage),
  ]);

  const artifactHints = uniq([
    ...(input.attachedFiles ?? []).map((file) => normalizeArtifactName(file.fileName)).filter((value): value is string => Boolean(value)),
    ...((input.taskState?.activeSourceArtifacts ?? []).map((artifact) => normalizeArtifactName(artifact.fileName)).filter((value): value is string => Boolean(value))),
  ]).slice(0, 4);

  const memoryHints = uniq((input.relevantMemoryFacts ?? []).map((value) => summarize(normalizeWhitespace(value), 120))).slice(0, 3);
  const summaryHints = extractSummaryEntities(input.threadSummary ?? undefined).slice(0, 3);
  const objectiveHint = input.taskState?.activeObjective ? summarize(normalizeWhitespace(input.taskState.activeObjective), 120) : null;

  const contextHints = uniq([
    ...(REFERENTIAL_QUERY_RE.test(cleanQuery) ? artifactHints : []),
    ...(objectiveHint ? [objectiveHint] : []),
    ...summaryHints,
  ]).slice(0, 4);

  const entityHints = uniq([
    ...exactTerms,
    ...artifactHints,
    ...summaryHints,
  ]).slice(0, 6);

  const retrievalQueries = uniq([
    rawMessage,
    cleanQuery !== rawMessage ? cleanQuery : '',
    exactTerms.length > 0 ? `${cleanQuery}\nExact terms: ${exactTerms.join(', ')}` : '',
    contextHints.length > 0 ? `${cleanQuery}\nContext hints: ${contextHints.join(', ')}` : '',
    memoryHints.length > 0 ? `${cleanQuery}\nRelevant memory: ${memoryHints.join(' | ')}` : '',
  ]).slice(0, 5);

  const retrievalQuery = retrievalQueries[retrievalQueries.length - 1] ?? cleanQuery;

  return {
    rawMessage,
    cleanQuery,
    retrievalQuery,
    retrievalQueries,
    exactTerms,
    entityHints,
    contextHints,
  };
};
