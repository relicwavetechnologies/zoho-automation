import { z } from 'zod';

export const updateAiModelTargetSchema = z.object({
  provider: z.enum(['google', 'openai']),
  modelId: z.string().trim().min(1),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional().nullable(),
  fastProvider: z.enum(['google', 'openai']).optional().nullable(),
  fastModelId: z.string().trim().min(1).optional().nullable(),
  fastThinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional().nullable(),
});
