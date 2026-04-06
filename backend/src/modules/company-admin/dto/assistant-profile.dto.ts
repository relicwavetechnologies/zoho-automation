import { z } from 'zod';

export const upsertAssistantProfileSchema = z.object({
  companyId: z.string().uuid().optional(),
  companyContext: z.string().default(''),
  systemsOfRecord: z.string().default(''),
  businessRules: z.string().default(''),
  communicationStyle: z.string().default(''),
  formattingDefaults: z.string().default(''),
  restrictedClaims: z.string().default(''),
  isActive: z.boolean().default(true),
});

export const assistantProfileQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

export type UpsertAssistantProfileDto = z.infer<typeof upsertAssistantProfileSchema>;
export type AssistantProfileQueryDto = z.infer<typeof assistantProfileQuerySchema>;
