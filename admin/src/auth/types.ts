/**
 * Three role axes, kept separate because conflating them is how permission UIs
 * go wrong.
 *
 *   company role   the ceiling   AdminMembership.role
 *   department     the grant     DepartmentMembership -> DepartmentRole.slug
 *   scope          a UI concept, derived from the two above
 *
 * Note there is no DEPARTMENT_MANAGER company role. Managing a department is
 * the second axis, not a value on the first — the old admin session type had it
 * as a company role and then had to refuse those people at the door.
 */
export type CompanyRole = 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN';

export type ScopeKind = 'you' | 'team' | 'company';

export type SessionDepartment = {
  id: string;
  name: string;
  /** Stable identifier. `roleName` is user-editable and must not be keyed on. */
  roleSlug: string;
  roleName: string;
  isManager: boolean;
};

/** What GET /api/desktop/auth/me returns, minus the parts the shell ignores. */
export type Session = {
  userId: string;
  companyId: string;
  companyName: string | null;
  email: string | null;
  name: string | null;
  role: CompanyRole;
  departments: SessionDepartment[];
  /**
   * A session created by password sign-in carries no Lark identity, so that
   * person's Lark chat cannot resolve it until they link Lark once. Surfaced
   * rather than hidden — a silently half-working agent is worse than a warning.
   */
  larkLinked: boolean;
};

export type Scope = {
  kind: ScopeKind;
  label: string;
  detail: string;
  /** Present on a team scope: which department the scope is about. */
  departmentId?: string;
};
