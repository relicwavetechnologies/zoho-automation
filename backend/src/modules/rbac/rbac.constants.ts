export const RBAC_ACTIONS = [
  'rbac.permissions.read',
  'rbac.permissions.write',
  'rbac.assignments.write',
  'onboarding.manage',
  'audit.read',
  'system.controls.write',
] as const;

export type RbacAction = (typeof RBAC_ACTIONS)[number];

export const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN'] as const;
export type AdminRoleId = (typeof ADMIN_ROLES)[number];
