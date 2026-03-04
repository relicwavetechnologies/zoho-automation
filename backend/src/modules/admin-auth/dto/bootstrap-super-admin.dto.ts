import { z } from 'zod';

export const bootstrapSuperAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(120).optional(),
});

export type BootstrapSuperAdminDto = z.infer<typeof bootstrapSuperAdminSchema>;
