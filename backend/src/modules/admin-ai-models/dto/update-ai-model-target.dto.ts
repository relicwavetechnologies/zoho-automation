import { z } from 'zod';

export const updateAiModelTargetSchema = z.object({
  provider: z.enum(['google', 'openai']),
  modelId: z.string().trim().min(1),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional().nullable(),
});
