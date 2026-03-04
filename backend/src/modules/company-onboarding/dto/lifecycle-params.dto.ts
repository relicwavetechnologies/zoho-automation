import { z } from 'zod';

export const lifecycleParamsSchema = z.object({
  companyId: z.string().uuid(),
});

export type LifecycleParamsDto = z.infer<typeof lifecycleParamsSchema>;
