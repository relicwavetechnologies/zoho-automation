import { z } from 'zod';

export const signupMemberInviteSchema = z.object({
  inviteToken: z.string().uuid(),
  password: z.string().min(8),
  name: z.string().min(2).max(120).optional(),
});

export type SignupMemberInviteDto = z.infer<typeof signupMemberInviteSchema>;
