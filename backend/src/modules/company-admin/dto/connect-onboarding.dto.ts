import { z } from 'zod';

export const connectOnboardingSchema = z.object({
  authorizationCode: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  environment: z.enum(['prod', 'sandbox']).default('prod'),
  companyId: z.string().uuid().optional(),
});

export const disconnectOnboardingSchema = z.object({
  companyId: z.string().uuid().optional(),
});

export type ConnectOnboardingDto = z.infer<typeof connectOnboardingSchema>;
export type DisconnectOnboardingDto = z.infer<typeof disconnectOnboardingSchema>;
