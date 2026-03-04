import { z } from 'zod';

export const createInviteSchema = z.object({
  email: z.string().email(),
  roleId: z.enum(['MEMBER', 'COMPANY_ADMIN']).default('MEMBER'),
  companyId: z.string().uuid().optional(),
});

export type CreateInviteDto = z.infer<typeof createInviteSchema>;
