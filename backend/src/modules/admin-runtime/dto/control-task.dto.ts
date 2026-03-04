import { z } from 'zod';

export const controlTaskSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel']),
});

export type ControlTaskDto = z.infer<typeof controlTaskSchema>;
