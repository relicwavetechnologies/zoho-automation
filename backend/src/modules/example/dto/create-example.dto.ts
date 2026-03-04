import { z } from 'zod';

export const createExampleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export type CreateExampleDto = z.infer<typeof createExampleSchema>;


