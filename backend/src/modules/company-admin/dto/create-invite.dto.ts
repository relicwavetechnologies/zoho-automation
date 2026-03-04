import { z } from 'zod';

export const createInviteSchema = z.object({
  email: z.string().email(),
  roleId: z.enum(['COMPANY_ADMIN']).default('COMPANY_ADMIN'),
  companyId: z.string().uuid().optional(),
});

export type CreateInviteDto = z.infer<typeof createInviteSchema>;
