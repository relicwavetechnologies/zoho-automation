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

type QueryEnrichmentConversationRefs = {
  latestTaskSummary?: string | null;
  latestEventSummary?: string | null;
  latestDocTitle?: string | null;
  latestFileName?: string | null;
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
const REFERENTIAL_FOLLOWUP_RE =
  /\b(this|that|it|them|those|these|same one|same file|same image|same doc|same document|same meeting|same task|continue|try again|again|retry|make them|assign them|do that)\b/i;
const FILE_REFERENCE_RE =
  /\b(file|files|pdf|document|documents|doc|image|images|picture|pictures|screenshot|attachment|attachments|upload|uploaded|csv|sheet|spreadsheet)\b/i;
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

const extractConversationRefHints = (input?: QueryEnrichmentConversationRefs | null): {
  actionHints: string[];
  fileHints: string[];
} => {
  if (!input) {
    return { actionHints: [], fileHints: [] };
  }

  const actionHints = uniq([
    input.latestTaskSummary ? `Recent task: ${summarize(normalizeWhitespace(input.latestTaskSummary), 100)}` : '',
    input.latestEventSummary ? `Recent event: ${summarize(normalizeWhitespace(input.latestEventSummary), 100)}` : '',
    input.latestDocTitle ? `Recent doc: ${summarize(normalizeWhitespace(input.latestDocTitle), 100)}` : '',
  ]).filter(Boolean);

  const fileHints = uniq([
    input.latestFileName ? normalizeArtifactName(input.latestFileName) ?? '' : '',
  ]).filter(Boolean);

  return { actionHints, fileHints };
};

export const enrichQuery = (input: {
  rawMessage: string;
  attachedFiles?: QueryEnrichmentAttachment[];
  taskState?: QueryEnrichmentTaskState | null;
  threadSummary?: QueryEnrichmentThreadSummary | null;
  recentConversationRefs?: QueryEnrichmentConversationRefs | null;
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
  const referentialFollowup = REFERENTIAL_FOLLOWUP_RE.test(cleanQuery) || REFERENTIAL_QUERY_RE.test(cleanQuery);
  const explicitFileCue = FILE_REFERENCE_RE.test(cleanQuery) || exactTerms.some((term) => FILE_REFERENCE_RE.test(term));
  const conversationRefHints = extractConversationRefHints(input.recentConversationRefs ?? undefined);
  const prioritizedActionHints = referentialFollowup && !explicitFileCue
    ? conversationRefHints.actionHints
    : [];
  const prioritizedFileHints = explicitFileCue
    ? uniq([...artifactHints, ...conversationRefHints.fileHints]).slice(0, 4)
    : [];

  const contextHints = uniq([
    ...prioritizedActionHints,
    ...prioritizedFileHints,
    ...(REFERENTIAL_QUERY_RE.test(cleanQuery) && explicitFileCue ? artifactHints : []),
    ...(objectiveHint ? [objectiveHint] : []),
    ...summaryHints,
  ]).slice(0, 6);

  const entityHints = uniq([
    ...exactTerms,
    ...prioritizedActionHints,
    ...summaryHints,
    ...artifactHints,
    ...conversationRefHints.fileHints,
  ]).slice(0, 8);

  const retrievalQueries = uniq([
    rawMessage,
    cleanQuery !== rawMessage ? cleanQuery : '',
    exactTerms.length > 0 ? `${cleanQuery}\nExact terms: ${exactTerms.join(', ')}` : '',
    prioritizedActionHints.length > 0 ? `${cleanQuery}\nRecent thread refs: ${prioritizedActionHints.join(' | ')}` : '',
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
