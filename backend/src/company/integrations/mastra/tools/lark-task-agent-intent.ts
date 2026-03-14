type ParsedCreateTaskIntent = {
  summary: string;
  assigneeNames: string[];
  assignToMe: boolean;
};

type ParsedReassignTaskIntent = {
  taskRef: string;
  assigneeNames: string[];
  assignToMe: boolean;
};

type ParsedTaskStatusIntent = {
  taskRef?: string;
  completed: boolean;
};

const CREATE_TASK_PATTERNS = [
  /\bcreate\b/i,
  /\bnew\b/i,
  /\badd\b/i,
];

const cleanSummary = (value: string): string => {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();
};

const extractSummary = (query: string): string | null => {
  const quotedMatch = query.match(/["']([^"']{2,200})["']/);
  if (quotedMatch?.[1]) {
    return cleanSummary(quotedMatch[1]);
  }

  const calledMatch = query.match(/\b(?:called|named|title[d]? as)\s+(.+?)(?:\s+\b(?:and\s+)?assign(?:ed)?\s+(?:it\s+)?to\b|$)/i);
  if (calledMatch?.[1]) {
    return cleanSummary(calledMatch[1]);
  }

  const taskMatch = query.match(/\btask\b\s+(.+?)(?:\s+\b(?:and\s+)?assign(?:ed)?\s+(?:it\s+)?to\b|$)/i);
  if (taskMatch?.[1]) {
    return cleanSummary(taskMatch[1]);
  }

  return null;
};

const normalizeAssigneeToken = (value: string): string | null => {
  const cleaned = value
    .replace(/^[,\s]+|[,\s.?!]+$/g, '')
    .replace(/\bplease\b/gi, '')
    .replace(/\bagain\b/gi, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
};

const parseAssigneeClause = (query: string): { assigneeNames: string[]; assignToMe: boolean } => {
  const match = query.match(/\bassign(?:ed)?(?:\s+it)?\s+to\s+(.+?)$/i);
  if (!match?.[1]) {
    return { assigneeNames: [], assignToMe: false };
  }

  const rawNames = match[1]
    .split(/\s*(?:,| and )\s*/i)
    .map((value) => normalizeAssigneeToken(value))
    .filter((value): value is string => Boolean(value));

  const assigneeNames: string[] = [];
  let assignToMe = false;

  for (const name of rawNames) {
    if (/^(me|myself|self)$/i.test(name)) {
      assignToMe = true;
      continue;
    }
    assigneeNames.push(name);
  }

  return { assigneeNames, assignToMe };
};

export const parseDirectCreateTaskIntent = (query: string): ParsedCreateTaskIntent | null => {
  const trimmed = query.trim();
  if (!trimmed || !/\btask\b/i.test(trimmed)) {
    return null;
  }
  if (!CREATE_TASK_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return null;
  }

  const summary = extractSummary(trimmed);
  if (!summary) {
    return null;
  }

  const { assigneeNames, assignToMe } = parseAssigneeClause(trimmed);
  return {
    summary,
    assigneeNames,
    assignToMe,
  };
};

const extractTaskReference = (query: string): string | null => {
  const taskIdMatch = query.match(/\btask\s+(t\d+)\b/i);
  if (taskIdMatch?.[1]) {
    return cleanSummary(taskIdMatch[1]);
  }

  const quotedTaskMatch = query.match(/\btask\b[^"'`]*["']([^"']{2,200})["']/i);
  if (quotedTaskMatch?.[1]) {
    return cleanSummary(quotedTaskMatch[1]);
  }

  const namedTaskMatch = query.match(/\b(?:assign|reassign|change|move)\b\s+(.+?)\s+\bto\b/i);
  if (namedTaskMatch?.[1] && /\btask\b/i.test(query)) {
    return cleanSummary(namedTaskMatch[1].replace(/\btask\b/ig, ''));
  }

  return null;
};

export const parseDirectReassignTaskIntent = (query: string): ParsedReassignTaskIntent | null => {
  const trimmed = query.trim();
  if (!trimmed || !/\btask\b/i.test(trimmed) || !/\b(assign|reassign)\b/i.test(trimmed)) {
    return null;
  }
  if (/\bcreate\b/i.test(trimmed) || /\bnew\b/i.test(trimmed) || /\badd\b/i.test(trimmed)) {
    return null;
  }

  const taskRef = extractTaskReference(trimmed);
  if (!taskRef) {
    return null;
  }

  const targetMatch = trimmed.match(/\bto\s+(.+?)$/i);
  const targetClause = targetMatch?.[1] ?? '';
  const rawNames = targetClause
    .split(/\s*(?:,| and )\s*/i)
    .map((value) => normalizeAssigneeToken(value))
    .filter((value): value is string => Boolean(value));
  const assigneeNames: string[] = [];
  let assignToMe = false;
  for (const rawName of rawNames) {
    if (/^(me|myself|self)$/i.test(rawName)) {
      assignToMe = true;
      continue;
    }
    assigneeNames.push(rawName);
  }
  if (assigneeNames.length === 0 && !assignToMe) {
    return null;
  }

  return {
    taskRef,
    assigneeNames,
    assignToMe,
  };
};

export const parseDirectTaskStatusIntent = (query: string): ParsedTaskStatusIntent | null => {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  const isComplete = /\b(mark|set|update|make|complete|finish|close)\b/i.test(trimmed)
    && /\b(done|complete|completed|finished|closed)\b/i.test(trimmed);
  const isReopen = /\b(reopen|undo)\b/i.test(trimmed)
    || (/\bmark\b/i.test(trimmed) && /\b(undone|open|todo)\b/i.test(trimmed));

  if (!isComplete && !isReopen) {
    return null;
  }

  const explicitTaskRef = extractTaskReference(trimmed)
    ?? (/(\bthis task\b|\bit\b)/i.test(trimmed) ? undefined : null);
  if (explicitTaskRef === null) {
    return null;
  }

  return {
    ...(explicitTaskRef ? { taskRef: explicitTaskRef } : {}),
    completed: isComplete,
  };
};
