import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../permissions/permission.types';
import type { RunContext, ApprovalGrant } from '../../domain/orchestration/run-context';
import { ManagerApprovalConfigSchema } from './approval.types';
import { sha256 } from '../../shared/hash';

export interface ApprovalCheckInput {
  readonly toolId:     string;
  readonly action:     ToolActionGroup;
  readonly args:       unknown;
  readonly perm:       PermissionResult;
  readonly runContext: RunContext;
}

export interface ApprovalCheckResult {
  readonly required: boolean;
  readonly existingGrant?: ApprovalGrant;
  readonly isSelfBypass:   boolean;
  readonly managerId?:     string;   // userId of dept manager (for later resolution)
}

export function computeArgsHash(args: unknown): string {
  return sha256(JSON.stringify(args));
}

export function computeIdempotencyKey(
  conversationId: string,
  toolId:          string,
  action:          string,
  argsHash:        string,
): string {
  return sha256(`${conversationId}:${toolId}:${action}:${argsHash}`);
}

/**
 * Pure policy check — no I/O.
 * Determines whether an approval gate should fire for (tool, action).
 */
export function checkApprovalPolicy(input: ApprovalCheckInput): ApprovalCheckResult {
  const { toolId, action, args, perm, runContext } = input;

  // Reads are never gated
  if (action === 'read') {
    return { required: false, isSelfBypass: false };
  }

  const deptMeta = perm.department;
  if (!deptMeta?.managerApprovalJson) {
    return { required: false, isSelfBypass: false };
  }

  const configParsed = ManagerApprovalConfigSchema.safeParse(deptMeta.managerApprovalJson);
  if (!configParsed.success || !configParsed.data.enabled) {
    return { required: false, isSelfBypass: false };
  }

  const config = configParsed.data;

  // Check if (toolId, action) is gated via any of the three config formats
  const inRequiredActions     = config.requiredActions.some(
    entry => entry.toolId === toolId && entry.actions.includes(action),
  );
  const inRequiredActionGroups = config.requiredActionGroups.includes(action);
  const inLegacyToolIds        = config.requiredToolIds.includes(toolId); // all non-read actions

  if (!inRequiredActions && !inRequiredActionGroups && !inLegacyToolIds) {
    return { required: false, isSelfBypass: false };
  }

  // Check if a matching grant is already present
  const argsHash = computeArgsHash(args);
  const grants   = runContext.approvalGrants ?? [];
  const existingGrant = grants.find(
    g => g.toolId === toolId && g.action === action && g.argsHash === argsHash,
  );
  if (existingGrant) {
    return { required: false, isSelfBypass: false, existingGrant };
  }

  return { required: true, isSelfBypass: false };
}
