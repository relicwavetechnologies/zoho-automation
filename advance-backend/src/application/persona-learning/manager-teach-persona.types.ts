import { z } from 'zod';

const writablePersonaKindSchema = z.enum(['preference', 'correction', 'workflow']);
const existingPersonaKindSchema = z.enum(['preference', 'correction', 'workflow', 'skill']);
const stableKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const skillSlugSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const evidenceRefSchema = z.string().regex(/^(?:frame|transcript):[1-9][0-9]*$/);

export const managerTeachPersonaTargetSchema = z.object({
  nodeId: z.string().uuid(),
  kind: existingPersonaKindSchema,
  scopeKey: stableKeySchema,
  ruleKey: stableKeySchema,
}).strict();

const evidenceSchema = {
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(12),
} as const;

const createChangeSchema = z.object({
  operation: z.literal('create'),
  kind: writablePersonaKindSchema,
  scopeKey: stableKeySchema,
  ruleKey: stableKeySchema,
  instruction: z.string().trim().min(1).max(1_000),
  skillSlugs: z.array(skillSlugSchema).max(5).default([]),
  ...evidenceSchema,
}).strict();

const mergeChangeSchema = z.object({
  operation: z.literal('merge'),
  target: managerTeachPersonaTargetSchema,
  instruction: z.string().trim().min(1).max(1_000),
  skillSlugs: z.array(skillSlugSchema).max(5).optional(),
  ...evidenceSchema,
}).strict();

const replaceChangeSchema = z.object({
  operation: z.literal('replace'),
  target: managerTeachPersonaTargetSchema,
  instruction: z.string().trim().min(1).max(1_000),
  skillSlugs: z.array(skillSlugSchema).max(5).optional(),
  ...evidenceSchema,
}).strict();

const retireChangeSchema = z.object({
  operation: z.literal('retire'),
  target: managerTeachPersonaTargetSchema,
  ...evidenceSchema,
}).strict();

const skillBodySchema = {
  slug: skillSlugSchema,
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(1_024).default(''),
  markdown: z.string().trim().min(1).max(40_000),
  toolIds: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  ...evidenceSchema,
} as const;

const skillCreateSchema = z.object({
  operation: z.literal('create'),
  ...skillBodySchema,
}).strict();

const skillMergeSchema = z.object({
  operation: z.literal('merge'),
  targetSkillId: z.string().uuid(),
  ...skillBodySchema,
}).strict();

const ignoredLearningSchema = z.object({
  conceptKey: stableKeySchema,
  matchedTarget: managerTeachPersonaTargetSchema.optional(),
  reason: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(12),
}).strict();

const readinessNullableAnswerSchema = z.string().trim().min(1).max(1_000).nullable();

const teachLearningReadinessSchema = z.object({
  classifications: z.array(z.enum([
    'preference',
    'skill',
    'workflow',
    'automation_candidate',
    'no_learning',
  ])).min(1).max(4),
  outcome: z.string().trim().min(1).max(1_000),
  whenToUse: z.string().trim().min(1).max(1_000),
  inputs: readinessNullableAnswerSchema,
  expectedOutput: readinessNullableAnswerSchema,
  decisionRules: readinessNullableAnswerSchema,
  exceptions: readinessNullableAnswerSchema,
  automationTrigger: readinessNullableAnswerSchema,
  monitoringScope: readinessNullableAnswerSchema,
  autonomyBoundary: readinessNullableAnswerSchema,
  failureHandling: readinessNullableAnswerSchema,
  clarificationAnswers: z.array(z.object({
    questionId: stableKeySchema,
    answer: z.string().trim().min(1).max(2_000),
  }).strict()).max(12).default([]),
  unresolvedMaterialQuestions: z.array(z.string().trim().min(1).max(1_000)).max(0),
}).strict().superRefine((readiness, ctx) => {
  const requiresProcedure = readiness.classifications.some((value) =>
    value === 'skill' || value === 'workflow' || value === 'automation_candidate');
  if (requiresProcedure) {
    for (const field of ['inputs', 'expectedOutput', 'decisionRules', 'exceptions'] as const) {
      if (readiness[field] === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be answered for a reusable procedure`,
        });
      }
    }
  }
  if (readiness.classifications.includes('automation_candidate')) {
    for (const field of ['automationTrigger', 'monitoringScope', 'autonomyBoundary', 'failureHandling'] as const) {
      if (readiness[field] === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be answered for an automation candidate`,
        });
      }
    }
  }
});

export const managerTeachLearningPatchSchema = z.object({
  schemaVersion: z.literal(2),
  baseRevision: z.number().int().nonnegative(),
  understanding: z.string().trim().min(1).max(2_000),
  readiness: teachLearningReadinessSchema,
  skills: z.array(z.discriminatedUnion('operation', [
    skillCreateSchema,
    skillMergeSchema,
  ])).max(4).default([]),
  changes: z.array(z.discriminatedUnion('operation', [
    createChangeSchema,
    mergeChangeSchema,
    replaceChangeSchema,
    retireChangeSchema,
  ])).max(8),
  ignored: z.array(ignoredLearningSchema).max(8).default([]),
}).strict();

export const managerTeachLearningApplySchema = z.object({
  teachSessionId: z.string().trim().min(1).max(200),
  mutationKey: z.string().trim().min(8).max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  patch: managerTeachLearningPatchSchema,
}).strict();

export type ManagerTeachLearningPatch = z.infer<typeof managerTeachLearningPatchSchema>;
export type ManagerTeachPersonaChange = ManagerTeachLearningPatch['changes'][number];
export type ManagerTeachSkillChange = ManagerTeachLearningPatch['skills'][number];
export type ManagerTeachIgnoredLearning = ManagerTeachLearningPatch['ignored'][number];
export type ManagerTeachPersonaTarget = z.infer<typeof managerTeachPersonaTargetSchema>;

export interface ManagerTeachPersonaEvidenceInput {
  readonly baseRevision: number;
  readonly existingPersona: readonly {
    readonly id: string;
    readonly kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
    readonly scopeKey: string;
    readonly ruleKey: string;
    readonly instruction: string;
    readonly confidence: number;
    readonly evidenceCount: number;
    readonly status: 'active' | 'superseded' | 'quarantined';
    readonly linkedSkills: readonly {
      readonly id: string;
      readonly slug: string;
      readonly name: string;
      readonly revision: number;
    }[];
  }[];
  readonly existingSkills: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly summary: string;
    readonly revision: number;
    readonly toolIds: readonly string[];
    readonly tags: readonly string[];
  }[];
  readonly transcript: readonly {
    readonly ref: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[];
  readonly frames: readonly {
    readonly ref: string;
    readonly caption: string;
    readonly ocrText: string;
    readonly uiElements: readonly string[];
  }[];
  readonly warnings: readonly string[];
}
