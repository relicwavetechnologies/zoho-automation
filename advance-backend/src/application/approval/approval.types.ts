import { z } from 'zod';

// Re-export from domain so application layer uses the same type
export type { ApprovalGrant } from '../../domain/orchestration/run-context';

// ─── Gate decision returned by ApprovalGateService ────────────────────────────

export type ApprovalAuthority = 'connection_owner' | 'company_admin' | 'department_manager';
export type ApprovalRequestState = 'dispatching' | 'created' | 'reused' | 'replaced_expired';

export type ApprovalDecision =
  | { readonly kind: 'allowed'; readonly executionGrant?: ApprovalExecutionGrant }
  | {
      readonly kind: 'completed';
      readonly approvalId: string;
      readonly result: unknown;
    }
  | {
      readonly kind: 'pending';
      readonly approvalId: string;
      readonly message: string;
      readonly authority: ApprovalAuthority;
      readonly approverName: string;
      readonly requestState: ApprovalRequestState;
      readonly nextAction: 'wait';
      readonly retry: 'retry_exact';
    }
  | {
      readonly kind: 'rejected';
      readonly approvalId: string;
      readonly message: string;
      readonly authority: ApprovalAuthority;
      readonly approverName: string;
      readonly requestState: 'reused';
      readonly nextAction: 'change_request';
      readonly retry: 'change_request';
    }
  | {
      readonly kind: 'execution_failed';
      readonly approvalId: string;
      readonly message: string;
      readonly authority: ApprovalAuthority;
      readonly approverName: string;
      readonly requestState: 'reused';
      readonly nextAction: 'change_request';
      readonly retry: 'change_request';
    }
  | { readonly kind: 'misconfigured'; readonly message: string };

export interface ApprovalExecutionGrant {
  readonly approvalId: string;
  readonly authority: ApprovalAuthority;
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

/**
 * The person whose yes is required. `larkOpenId` is a delivery address, not part
 * of their authority — null means Divo cannot card them, and the request waits
 * in their approval inbox instead.
 */
export interface ResolvedManager {
  readonly userId:      string;
  readonly larkOpenId:  string | null;
  readonly displayName: string;
}
