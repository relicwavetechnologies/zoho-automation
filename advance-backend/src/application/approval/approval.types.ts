import { z } from 'zod';

// Re-export from domain so application layer uses the same type
export type { ApprovalGrant } from '../../domain/orchestration/run-context';

// ─── Gate decision returned by ApprovalGateService ────────────────────────────

export type ApprovalDecision =
  | { readonly kind: 'allowed'; readonly executionGrant?: ApprovalExecutionGrant }
  | { readonly kind: 'pending';       readonly approvalId: string; readonly message: string }
  | { readonly kind: 'rejected';      readonly approvalId: string; readonly message: string }
  | { readonly kind: 'misconfigured'; readonly message: string };

export interface ApprovalExecutionGrant {
  readonly approvalId: string;
}

// ─── managerApprovalJson schema ───────────────────────────────────────────────

const RequiredActionEntrySchema = z.object({
  toolId:   z.string(),
  actions:  z.array(z.string()),
});

export const ManagerApprovalConfigSchema = z.object({
  enabled:                    z.boolean().default(false),
  // per-tool, per-action gating (new format)
  requiredActions:            z.array(RequiredActionEntrySchema).default([]),
  // flat action-group list — any tool calling this action group is gated
  requiredActionGroups:       z.array(z.string()).default([]),
  requiredToolIds:            z.array(z.string()).default([]),   // legacy compat
  managerDmAuditToolIds:      z.array(z.string()).default([]),
  managerDmAuditActionGroups: z.array(z.string()).default([]),
});

export type ManagerApprovalConfig = z.infer<typeof ManagerApprovalConfigSchema>;

// ─── Resolved manager info ────────────────────────────────────────────────────

export interface ResolvedManager {
  readonly userId:      string;
  readonly larkOpenId:  string;
  readonly displayName: string;
}
