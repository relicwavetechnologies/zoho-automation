declare global {
  namespace Express {
    interface Request {
      userId?: string;
      organizationId?: string;
      roleId?: string;
      roleKey?: string;
      membershipId?: string;
    }
  }
}

export {};
