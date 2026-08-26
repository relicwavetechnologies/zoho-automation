import { err, ok, type Result } from '../../shared/result';

/**
 * Where an invite puts somebody, decided once for both ends of the flow.
 *
 * An invite is raised on one day and accepted on another, and the department it
 * named can be archived or have its roles edited in between. So the same
 * question — may this invite place this person here, and in what role — has to
 * be answered twice, by two routes, from two different snapshots of the world.
 * Two answers is how the create side comes to accept a placement the accept
 * side then silently drops.
 */

export type InvitePlacement =
  | { readonly kind: 'company_only' }
  | { readonly kind: 'department'; readonly departmentId: string; readonly roleId: string };

export type PlacementRefusal =
  | { readonly reason: 'department_not_in_company'; readonly departmentId: string }
  | { readonly reason: 'department_archived'; readonly departmentId: string }
  | { readonly reason: 'role_not_in_department'; readonly roleId: string; readonly departmentId: string }
  | { readonly reason: 'department_has_no_role'; readonly departmentId: string };

export function placementFor(input: {
  readonly companyId: string;
  readonly departmentId: string | null;
  readonly departmentRoleId: string | null;
  readonly department: {
    readonly id: string;
    readonly companyId: string;
    /** `active` or `archived`. Read here rather than by each caller. */
    readonly status: string;
    readonly roles: readonly { readonly id: string; readonly isDefault: boolean }[];
  } | null;
}): Result<InvitePlacement, PlacementRefusal> {
  if (input.departmentId === null) {
    return ok({ kind: 'company_only' });
  }

  const dept = input.department;
  if (!dept || dept.companyId !== input.companyId) {
    return err({ reason: 'department_not_in_company', departmentId: input.departmentId });
  }

  // Kept apart from `department_not_in_company`, because the two want different
  // answers: one is a request that should never have been made, the other is a
  // department that was fine when the invite was raised. The accept side turns
  // this one into "account yes, placement no" rather than a refusal.
  if (dept.status !== 'active') {
    return err({ reason: 'department_archived', departmentId: input.departmentId });
  }

  if (input.departmentRoleId !== null) {
    const found = dept.roles.some((r) => r.id === input.departmentRoleId);
    if (!found) {
      return err({
        reason: 'role_not_in_department',
        roleId: input.departmentRoleId,
        departmentId: input.departmentId,
      });
    }
    return ok({ kind: 'department', departmentId: input.departmentId, roleId: input.departmentRoleId });
  }

  const def = dept.roles.find((r) => r.isDefault);
  if (!def) {
    return err({ reason: 'department_has_no_role', departmentId: input.departmentId });
  }
  return ok({ kind: 'department', departmentId: input.departmentId, roleId: def.id });
}
