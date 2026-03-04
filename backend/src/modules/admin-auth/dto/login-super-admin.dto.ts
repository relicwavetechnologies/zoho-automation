import { z } from 'zod';

export const loginSuperAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginSuperAdminDto = z.infer<typeof loginSuperAdminSchema>;
