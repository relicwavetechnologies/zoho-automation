export type ZohoRateLimitUserOverride = {
  userId: string;
  maxCallsPerWindow: number;
};

export type ZohoRateLimitConfig = {
  enabled: boolean;
  windowSeconds: number;
  totalCallsPerWindow: number;
  roleBudgets: Record<string, number>;
  userOverrides: ZohoRateLimitUserOverride[];
};

export type ZohoRateLimitContext = {
  companyId: string;
  userId?: string;
  departmentId?: string;
  departmentRoleSlug?: string;
  config?: ZohoRateLimitConfig;
};
