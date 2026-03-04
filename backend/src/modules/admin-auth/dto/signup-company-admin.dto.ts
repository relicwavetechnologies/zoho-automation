import { z } from 'zod';

export const signupCompanyAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(120).optional(),
  companyName: z.string().min(2).max(160),
});

export type SignupCompanyAdminDto = z.infer<typeof signupCompanyAdminSchema>;
