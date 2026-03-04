import { Router } from 'express';

import { Request, Response, NextFunction } from 'express';
import { HttpException } from '../../core/http-exception';
import { requireAdminRole, requireAdminSession } from '../../middlewares/admin-auth.middleware';
import { companyOnboardingController } from './company-onboarding.controller';

const router = Router();

const enforceBodyCompanyScope = (req: Request, _res: Response, next: NextFunction) => {
  const requestedCompanyId =
    (req.body as { companyId?: string })?.companyId ??
    (req.params as { companyId?: string })?.companyId;
  const session = (req as Request & {
    adminSession?: {
      userId: string;
      sessionId: string;
      role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
      companyId?: string;
      expiresAt: string;
    };
  }).adminSession;

  if (!session) {
    throw new HttpException(401, 'Admin session required');
  }

  if (session.role === 'SUPER_ADMIN') {
    return next();
  }

  if (!requestedCompanyId) {
    throw new HttpException(400, 'companyId is required for company-admin routes');
  }

  if (session.companyId !== requestedCompanyId) {
    throw new HttpException(403, 'Company-admin can only act within assigned company scope');
  }

  return next();
};

router.use(requireAdminSession(), requireAdminRole('SUPER_ADMIN', 'COMPANY_ADMIN'));

router.post('/zoho/connect', enforceBodyCompanyScope, companyOnboardingController.connectZoho);
router.get('/zoho/sync/jobs/:jobId', companyOnboardingController.getHistoricalSyncStatus);
router.post('/zoho/sync/delta', enforceBodyCompanyScope, companyOnboardingController.processDeltaSyncEvent);
router.get('/zoho/lifecycle/:companyId/validate', enforceBodyCompanyScope, companyOnboardingController.validateLifecycle);

export default router;
