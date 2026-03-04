import { z } from 'zod';

export const grantCompanyAdminSchema = z.object({
  userId: z.string().uuid(),
  companyId: z.string().uuid(),
});

export type GrantCompanyAdminDto = z.infer<typeof grantCompanyAdminSchema>;
