const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  COMPANY_ADMIN: 'Workspace Admin',
  MEMBER: 'Member',
  GUEST: 'Guest',
};

export const roleLabel = (role?: string | null): string => {
  if (!role) return 'Unknown';
  return ROLE_LABELS[role] ?? role;
};
