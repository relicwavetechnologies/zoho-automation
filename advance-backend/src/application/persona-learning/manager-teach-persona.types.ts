import { z } from 'zod';

const personaKindSchema = z.enum(['preference', 'correction', 'workflow', 'skill']);
const stableKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const evidenceRefSchema = z.string().regex(/^(?:frame|transcript):[1-9][0-9]*$/);

export const managerTeachPersonaTargetSchema = z.object({
  kind: personaKindSchema,
  scopeKey: stableKeySchema,
  ruleKey: stableKeySchema,
}).strict();

const evidenceSchema = {
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(12),
} as const;

const addChangeSchema = z.object({
  operation: z.literal('add'),
  kind: personaKindSchema,
  scopeKey: stableKeySchema,
  ruleKey: stableKeySchema,
  instruction: z.string().trim().min(1).max(1_000),
  ...evidenceSchema,
}).strict();

const replaceChangeSchema = z.object({
  operation: z.literal('replace'),
  target: managerTeachPersonaTargetSchema,
  instruction: z.string().trim().min(1).max(1_000),
  ...evidenceSchema,
}).strict();

const retireChangeSchema = z.object({
  operation: z.literal('retire'),
  target: managerTeachPersonaTargetSchema,
  ...evidenceSchema,
}).strict();

export const managerTeachPersonaPatchSchema = z.object({
  schemaVersion: z.literal(1),
  baseRevision: z.number().int().nonnegative(),
  understanding: z.string().trim().min(1).max(2_000),
  changes: z.array(z.discriminatedUnion('operation', [
    addChangeSchema,
    replaceChangeSchema,
    retireChangeSchema,
  ])).max(8),
}).strict();

export const managerTeachPersonaApplySchema = z.object({
  teachSessionId: z.string().trim().min(1).max(200),
  mutationKey: z.string().trim().min(8).max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  patch: managerTeachPersonaPatchSchema,
}).strict();

export type ManagerTeachPersonaPatch = z.infer<typeof managerTeachPersonaPatchSchema>;
export type ManagerTeachPersonaChange = ManagerTeachPersonaPatch['changes'][number];
export type ManagerTeachPersonaTarget = z.infer<typeof managerTeachPersonaTargetSchema>;

export interface ManagerTeachPersonaEvidenceInput {
  readonly baseRevision: number;
  readonly existingPersona: readonly {
    readonly kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
    readonly scopeKey: string;
    readonly ruleKey: string;
    readonly instruction: string;
    readonly status: 'active' | 'superseded' | 'quarantined';
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
