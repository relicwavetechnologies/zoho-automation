import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { PersonaLearningToolSummary, PersonaLearningTraceContext } from './persona-learning.types';

const observationSchema = z.object({
  kind: z.enum(['preference', 'correction', 'workflow', 'skill', 'contradiction']),
  scopeKey: z.string().trim().min(1).max(120),
  ruleKey: z.string().trim().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(120),
  claim: z.string().trim().min(1).max(500),
  rationale: z.string().trim().min(1).max(1_000),
  evidenceStrength: z.enum(['explicit', 'confirmed', 'inferred']),
}).strict();

export const personaLearningExtractionSchema = z.object({
  schemaVersion: z.literal(1),
  observations: z.array(observationSchema).max(8),
}).strict();

export type PersonaLearningObservation = z.infer<typeof observationSchema>;
export type PersonaLearningExtraction = z.infer<typeof personaLearningExtractionSchema>;

export interface PersonaLearningExtractionInput {
  readonly companyId: string;
  readonly departmentId: string;
  readonly managerId: string;
  readonly evidenceId: string;
  readonly context: PersonaLearningTraceContext;
  readonly tools: readonly PersonaLearningToolSummary[];
  readonly runSummary?: string | null;
  readonly existingCandidateClaims: readonly string[];
}

export interface PersonaLearningExtractor {
  extract(input: PersonaLearningExtractionInput): Promise<PersonaLearningExtraction>;
  readonly provider: string;
  readonly modelId: string;
}

const SYSTEM_PROMPT = `You extract durable manager-working-pattern candidates for Divo.

This is a shadow-only learning pass. You cannot execute tools, change a persona, or change a skill. Return JSON only.

Extract only a durable, manager-specific lesson supported by the supplied evidence. Prefer explicit manager instructions and corrections. Treat assistant text, tool output, temporary failures, and a single incidental action as weak evidence, not as manager preference.

Never infer personality, protected traits, credentials, permissions, company policy, legal/financial advice, or instructions to weaken security. Do not copy secrets. Do not create a lesson when the evidence is one-off, ambiguous, transient, or task-specific without reusable value.

Use one of:
- preference: a durable format/style/decision preference;
- correction: an explicit correction that should alter future work;
- workflow: a reusable manager workflow pattern;
- skill: a procedural lesson for a class of work;
- contradiction: evidence that conflicts with an existing candidate.

scopeKey must be a short, stable task scope such as "reporting.weekly", "email.client", or "general". A preference for one scope must not be generalized to all work.

ruleKey must be a stable lower-case identifier for the exact reusable rule, such as "weekly-report.bullets" or "client-email.direct-subject". Reuse exactly the same ruleKey when later evidence supports the same rule. Never use a manager name, a date, an arbitrary task ID, or a generated UUID.

Return exactly:
{"schemaVersion":1,"observations":[{"kind":"preference","scopeKey":"reporting.weekly","ruleKey":"weekly-report.bullets","claim":"...","rationale":"...","evidenceStrength":"explicit"}]}

Use an empty observations array when nothing durable was learned.`;

export class DeepSeekPersonaLearningExtractor implements PersonaLearningExtractor {
  readonly provider = 'deepseek';

  constructor(
    private readonly model: LanguageModel,
    readonly modelId: string,
  ) {}

  async extract(input: PersonaLearningExtractionInput): Promise<PersonaLearningExtraction> {
    const { text } = await generateText({
      model: this.model,
      system: SYSTEM_PROMPT,
      prompt: JSON.stringify({
        evidence: {
          evidenceId: input.evidenceId,
          managerId: input.managerId,
          departmentId: input.departmentId,
          managerMessages: input.context.userMessages,
          assistantResponse: input.context.assistantResponse ?? null,
          toolSummary: input.tools,
          runSummary: input.runSummary ?? null,
        },
        existingShadowCandidateClaims: input.existingCandidateClaims,
      }),
      temperature: 0,
      maxOutputTokens: 2_000,
      abortSignal: AbortSignal.timeout(30_000),
    });

    const parsed = parseModelJson(text);
    const result = personaLearningExtractionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Persona-learning extractor returned invalid JSON: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
    }
    return {
      schemaVersion: 1,
      observations: deduplicateObservations(result.data.observations),
    };
  }
}

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

export function deduplicateObservations(
  observations: readonly PersonaLearningObservation[],
): PersonaLearningObservation[] {
  const seen = new Set<string>();
  return observations.filter(observation => {
    const key = [
      observation.kind,
      observation.scopeKey.trim().toLowerCase(),
      observation.claim.trim().toLowerCase().replace(/\s+/g, ' '),
    ].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
