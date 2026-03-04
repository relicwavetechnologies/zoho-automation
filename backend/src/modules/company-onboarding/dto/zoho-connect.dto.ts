import { z } from 'zod';

export const zohoConnectSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    companyName: z.string().min(2).max(120).optional(),
    authorizationCode: z.string().min(1),
    scopes: z.array(z.string().min(1)).min(1),
    environment: z.enum(['prod', 'sandbox']).default('prod'),
  })
  .superRefine((value, ctx) => {
    if (!value.companyId && !value.companyName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companyName'],
        message: 'companyName is required when companyId is not provided',
      });
    }
  });

export type ZohoConnectDto = z.infer<typeof zohoConnectSchema>;
