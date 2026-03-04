export type AdminRole = 'SUPER_ADMIN' | 'COMPANY_ADMIN';

export type AdminSession = {
  userId: string;
  companyId?: string;
  role: AdminRole;
  sessionId: string;
  expiresAt: string;
};

export type AdminNavItem = {
  id: string;
  label: string;
  path: string;
  roles: AdminRole[];
};
