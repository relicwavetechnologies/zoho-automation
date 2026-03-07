import { z } from 'zod';

const restConnectSchema = z.object({
  mode: z.literal('rest').default('rest'),
  authorizationCode: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  environment: z.enum(['prod', 'sandbox']).default('prod'),
});

const mcpConnectSchema = z.object({
  mode: z.literal('mcp'),
  environment: z.enum(['prod', 'sandbox']).default('prod'),
  mcpBaseUrl: z.string().url(),
  mcpApiKey: z.string().min(1),
  mcpWorkspaceKey: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().min(1)).default([]),
});

export const connectOnboardingSchema = z
  .object({
    companyId: z.string().uuid().optional(),
  })
  .and(z.discriminatedUnion('mode', [restConnectSchema, mcpConnectSchema]));

export const upsertLarkBindingSchema = z.object({
  companyId: z.string().uuid().optional(),
  larkTenantKey: z.string().min(1),
  isActive: z.boolean().default(true),
});

export const upsertLarkWorkspaceConfigSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    appId: z.string().min(1),
    appSecret: z.string().optional(),
    verificationToken: z.string().optional(),
    signingSecret: z.string().optional(),
    staticTenantAccessToken: z.string().optional(),
    apiBaseUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    const hasVerificationToken = typeof value.verificationToken === 'string' && value.verificationToken.trim().length > 0;
    const hasSigningSecret = typeof value.signingSecret === 'string' && value.signingSecret.trim().length > 0;
    if (!hasVerificationToken && !hasSigningSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationToken'],
        message: 'Provide verificationToken or signingSecret',
      });
    }
  });

export const larkSyncQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

export const disconnectOnboardingSchema = z.object({
  companyId: z.string().uuid().optional(),
});

export const triggerHistoricalSyncSchema = z.object({
  companyId: z.string().uuid().optional(),
});

const isLikelyMcpUrl = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return normalized.includes('/mcp/') || normalized.includes('/message?') || normalized.includes('key=');
};

export const upsertZohoOAuthConfigSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    redirectUri: z.string().url(),
    accountsBaseUrl: z.string().url().optional(),
    apiBaseUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.apiBaseUrl && isLikelyMcpUrl(value.apiBaseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiBaseUrl'],
        message: 'apiBaseUrl must be a Zoho REST API base (for example https://www.zohoapis.in), not an MCP/message URL',
      });
    }

    if (value.accountsBaseUrl && isLikelyMcpUrl(value.accountsBaseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountsBaseUrl'],
        message: 'accountsBaseUrl must be a Zoho Accounts base (for example https://accounts.zoho.in), not an MCP/message URL',
      });
    }
  });

export const zohoAuthorizeUrlQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  scopes: z.string().optional(),
  environment: z.enum(['prod', 'sandbox']).optional(),
});

export type ConnectOnboardingDto = z.infer<typeof connectOnboardingSchema>;
export type DisconnectOnboardingDto = z.infer<typeof disconnectOnboardingSchema>;
export type UpsertLarkBindingDto = z.infer<typeof upsertLarkBindingSchema>;
export type UpsertLarkWorkspaceConfigDto = z.infer<typeof upsertLarkWorkspaceConfigSchema>;
export type UpsertZohoOAuthConfigDto = z.infer<typeof upsertZohoOAuthConfigSchema>;
export type ZohoAuthorizeUrlQueryDto = z.infer<typeof zohoAuthorizeUrlQuerySchema>;
export type TriggerHistoricalSyncDto = z.infer<typeof triggerHistoricalSyncSchema>;
export type LarkSyncQueryDto = z.infer<typeof larkSyncQuerySchema>;
