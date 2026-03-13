import { z } from 'zod';

export const updateAiModelTargetSchema = z.object({
  provider: z.enum(['google', 'openai', 'groq']),
  modelId: z.string().trim().min(1),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional().nullable(),
  fastProvider: z.enum(['google', 'openai', 'groq']).optional().nullable(),
  fastModelId: z.string().trim().min(1).optional().nullable(),
  fastThinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional().nullable(),
  xtremeProvider: z.enum(['google', 'openai', 'groq']).optional().nullable(),
  xtremeModelId: z.string().trim().min(1).optional().nullable(),
  xtremeThinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional().nullable(),
});
