import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: string;
    };
    adminSession?: {
      userId: string;
      sessionId: string;
      role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
      companyId?: string;
      expiresAt: string;
    };
    rawBody?: string;
    requestId?: string;
  }
}
