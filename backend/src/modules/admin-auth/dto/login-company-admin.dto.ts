import { z } from 'zod';

export const loginCompanyAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  companyId: z.string().uuid(),
});

export type LoginCompanyAdminDto = z.infer<typeof loginCompanyAdminSchema>;
