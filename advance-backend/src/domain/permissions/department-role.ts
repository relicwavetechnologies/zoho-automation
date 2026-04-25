/** DepartmentRole slugs are per-company custom strings (MANAGER, MEMBER, VIEWER, etc.).
 *  They live in the DepartmentRole table and are completely separate from CompanyRoleSlug. */
export type DepartmentRoleSlug = string & { readonly __deptRole: true };

export const asDepartmentRoleSlug = (s: string): DepartmentRoleSlug =>
  s.trim().toUpperCase() as DepartmentRoleSlug;
