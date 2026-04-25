import { z } from 'zod';

export const PlanStepSchema = z.object({
  stepId: z.string(),
  agentId: z.string(),
  objective: z.string(),
  toolIds: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
  wave: z.number().int().min(0),
});

export const PlanSchema = z.object({
  planId: z.string(),
  intent: z.string(),
  steps: z.array(PlanStepSchema),
  synthesisHint: z.string().optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
