import { z } from 'zod';

/**
 * These groups deliberately match the backend's existing tool action groups.
 * A connection policy is evaluated alongside RBAC; it never grants a user
 * access to a connection by itself.
 */
export const CONNECTION_ACTIONS = ['read', 'create', 'update', 'delete', 'send', 'execute'] as const;
export type ConnectionAction = typeof CONNECTION_ACTIONS[number];

export const CONNECTION_APPROVAL_MODES = ['none', 'connection_owner', 'company_admin'] as const;
export type ConnectionApprovalMode = typeof CONNECTION_APPROVAL_MODES[number];

const actionOverrideSchema = z.object({
  mode: z.enum(['inherit', 'enforced']),
  requestsPerMinute: z.number().int().min(1).max(100_000).nullable().optional(),
  requestsPerDay: z.number().int().min(1).max(10_000_000).nullable().optional(),
  approval: z.enum(CONNECTION_APPROVAL_MODES).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === 'enforced' && !value.approval) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An enforced action needs an approval mode' });
  }
});

export const connectionGovernancePolicySchema = z.object({
  version: z.literal(1),
  actions: z.object({
    read: actionOverrideSchema.optional(),
    create: actionOverrideSchema.optional(),
    update: actionOverrideSchema.optional(),
    delete: actionOverrideSchema.optional(),
    send: actionOverrideSchema.optional(),
    execute: actionOverrideSchema.optional(),
  }).strict(),
}).strict();

export type ConnectionGovernancePolicy = z.infer<typeof connectionGovernancePolicySchema>;

export const defaultConnectionGovernancePolicy = (): ConnectionGovernancePolicy => ({
  version: 1,
  actions: Object.fromEntries(
    CONNECTION_ACTIONS.map(action => [action, { mode: 'inherit' as const }]),
  ) as ConnectionGovernancePolicy['actions'],
});

export const COMPANY_CAPABILITIES = [
  { id: 'webSearch', label: 'Web search', description: 'Company-backed public web research and search credits.' },
  { id: 'sharedSkills', label: 'Shared skills', description: 'Skills published for use across the company.' },
  { id: 'sharedPersonaMemory', label: 'Shared persona & memory', description: 'Department persona and shared working knowledge.' },
] as const;

export type CompanyCapabilityId = typeof COMPANY_CAPABILITIES[number]['id'];

export const companyCapabilityPolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  requestsPerMinute: z.number().int().min(1).max(100_000).nullable(),
  requestsPerDay: z.number().int().min(1).max(10_000_000).nullable(),
  approval: z.enum(['none', 'company_admin']),
}).strict();

export type CompanyCapabilityPolicy = z.infer<typeof companyCapabilityPolicySchema>;

export const defaultCompanyCapabilityPolicy = (): CompanyCapabilityPolicy => ({
  version: 1,
  enabled: true,
  requestsPerMinute: null,
  requestsPerDay: null,
  approval: 'none',
});

export function parseConnectionGovernancePolicy(value: unknown): ConnectionGovernancePolicy {
  const parsed = connectionGovernancePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : defaultConnectionGovernancePolicy();
}

export function parseCompanyCapabilityPolicy(value: unknown): CompanyCapabilityPolicy {
  const parsed = companyCapabilityPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : defaultCompanyCapabilityPolicy();
}
