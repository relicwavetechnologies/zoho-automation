import { z } from 'zod';

export const agentProfileQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

export const upsertAgentProfileSchema = z.object({
  companyId: z.string().uuid().optional(),
  profileId: z.string().uuid().optional(),
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional().nullable(),
  systemPrompt: z.string().max(20000),
  modelKey: z.string().min(1).max(120),
  toolIds: z.array(z.string().trim().min(1).max(120)).max(500),
  routingHints: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  departmentIds: z.array(z.string().uuid()).max(500).optional(),
  isActive: z.boolean().optional(),
});

export const deleteAgentProfileParamsSchema = z.object({
  profileId: z.string().uuid(),
});

export type AgentProfileQueryDto = z.infer<typeof agentProfileQuerySchema>;
export type UpsertAgentProfileDto = z.infer<typeof upsertAgentProfileSchema>;
