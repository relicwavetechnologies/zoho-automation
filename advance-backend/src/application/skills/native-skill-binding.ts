import { createHash } from 'node:crypto';
import type { PermissionResult } from '../permissions/permission.types';

/**
 * Versioned fingerprint for the native skill bundle a runtime is entitled to.
 *
 * The value is only a conditional-read hint. Membership and authorization are
 * still resolved before it is computed, and matching it never authorizes a
 * tool call. Changing the version forces every controller to fetch a complete
 * bundle after the binding inputs or projection rules change.
 */
const NATIVE_SKILL_BINDING_VERSION = 1;

export function nativeSkillBinding(input: {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId: string;
  readonly channel: string;
  readonly registryRevision: number;
  readonly permission: PermissionResult;
  readonly grantedSkillIds: ReadonlySet<string>;
}): string {
  const allowedActions = [...input.permission.allowedActionsByTool]
    .map(([toolId, actions]) => [String(toolId), [...actions].map(String).sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return createHash('sha256')
    .update(JSON.stringify({
      version: NATIVE_SKILL_BINDING_VERSION,
      companyId: input.companyId,
      userId: input.userId,
      departmentId: input.departmentId,
      channel: input.channel,
      registryRevision: input.registryRevision,
      allowedToolIds: [...input.permission.allowedToolIds].map(String).sort(),
      allowedActions,
      grantedSkillIds: [...input.grantedSkillIds].sort(),
    }))
    .digest('hex');
}
