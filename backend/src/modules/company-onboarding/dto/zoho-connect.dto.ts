import { z } from 'zod';

const zohoRestConnectSchema = z.object({
  mode: z.literal('rest').default('rest'),
  authorizationCode: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  environment: z.enum(['prod', 'sandbox']).default('prod'),
});

const zohoMcpConnectSchema = z.object({
  mode: z.literal('mcp'),
  environment: z.enum(['prod', 'sandbox']).default('prod'),
  mcpBaseUrl: z.string().url(),
  mcpApiKey: z.string().min(1),
  mcpWorkspaceKey: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().min(1)).default([]),
});

export const zohoConnectSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    companyName: z.string().min(2).max(120).optional(),
  })
  .and(z.discriminatedUnion('mode', [zohoRestConnectSchema, zohoMcpConnectSchema]))
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
