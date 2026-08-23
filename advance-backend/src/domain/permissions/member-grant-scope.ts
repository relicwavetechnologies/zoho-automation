/**
 * Fresh grantee identities resolved for one authenticated company member.
 *
 * This is input to grant matching, never proof that a skill, connection, or
 * tool is allowed. Each owning module still evaluates its own grants. Binding
 * the scope to company and user prevents one request's projection from being
 * reused for another principal.
 */
export interface MemberGrantScope {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentIds: readonly string[];
  readonly departmentRoleIds: readonly string[];
  readonly adminRole: string | null;
}

export function createMemberGrantScope(input: MemberGrantScope): MemberGrantScope {
  return {
    companyId: input.companyId,
    userId: input.userId,
    departmentIds: [...new Set(input.departmentIds)],
    departmentRoleIds: [...new Set(input.departmentRoleIds)],
    adminRole: input.adminRole,
  };
}

export function assertMemberGrantScope(
  scope: MemberGrantScope,
  identity: { readonly companyId: string; readonly userId: string },
): void {
  if (scope.companyId !== identity.companyId || scope.userId !== identity.userId) {
    throw new Error('Member grant scope does not match the requested principal');
  }
}
