import { z } from 'zod';

export const PERSONA_LEARNING_PIPELINE_VERSION = 1;

export const personaLearningTraceContextSchema = z.object({
  userMessages: z.array(z.string().max(4_000)).max(3),
  assistantResponse: z.string().max(6_000).optional(),
}).strict();

export type PersonaLearningTraceContext = z.infer<typeof personaLearningTraceContextSchema>;

export interface PersonaLearningToolSummary {
  readonly toolName: string;
  readonly isError: boolean;
  readonly summary?: string | undefined;
}

export const personaLearningToolSummarySchema = z.object({
  toolName: z.string().min(1).max(200),
  isError: z.boolean(),
  summary: z.string().max(500).optional(),
}).strict();

export const personaLearningToolSummariesSchema = z.array(personaLearningToolSummarySchema).max(20);

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(bearer\s+)[a-z0-9._~+/=-]{12,}/gi,
  /\b(sk-[a-z0-9_-]{12,})\b/gi,
  /\b(eyJ[a-z0-9_-]{10,}\.[a-z0-9._-]{10,}\.[a-z0-9._-]{10,})\b/gi,
  /\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;)}\]]+/gi,
];

/**
 * Keep only bounded text useful for learning and redact obvious authentication
 * material before it crosses into long-lived learning evidence.
 */
export function sanitizePersonaLearningText(value: string, maxChars: number): string {
  let text = value.replace(/\u0000/g, '').trim();
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '$1[REDACTED]');
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function sanitizePersonaLearningContext(raw: PersonaLearningTraceContext): PersonaLearningTraceContext {
  const userMessages = raw.userMessages
    .map(message => sanitizePersonaLearningText(message, 2_000))
    .filter(Boolean)
    .slice(-3);
  const assistantResponse = raw.assistantResponse
    ? sanitizePersonaLearningText(raw.assistantResponse, 4_000)
    : undefined;
  return {
    userMessages,
    ...(assistantResponse ? { assistantResponse } : {}),
  };
}

export function sanitizePersonaLearningToolSummaries(
  summaries: readonly PersonaLearningToolSummary[],
): PersonaLearningToolSummary[] {
  return summaries.slice(-20).map(summary => ({
    toolName: sanitizePersonaLearningText(summary.toolName, 200),
    isError: summary.isError,
    ...(summary.summary ? { summary: sanitizePersonaLearningText(summary.summary, 500) } : {}),
  }));
}
