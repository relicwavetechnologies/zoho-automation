import { Router } from 'express';

import {
  requireAdminRole,
  requireAdminSession,
  requireCompanyScope,
} from '../../middlewares/admin-auth.middleware';
import { createRateLimitMiddleware } from '../../middlewares/rate-limit.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { adminAuthController } from './admin-auth.controller';

const router = Router();

const adminLoginRateLimit = createRateLimitMiddleware({
  name: 'admin_login',
  max: 5,
  windowMs: 15 * 60_000,
  message: 'Too many admin login attempts. Please wait a few minutes and try again.',
  key: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown_email';
    return `${req.ip}:${email}`;
  },
});

router.post('/bootstrap-super-admin', asyncHandler(adminAuthController.bootstrapSuperAdmin));
router.post('/login/super-admin', adminLoginRateLimit, asyncHandler(adminAuthController.loginSuperAdmin));
router.post('/login/company-admin', adminLoginRateLimit, asyncHandler(adminAuthController.loginCompanyAdmin));
router.post('/signup/company-admin', asyncHandler(adminAuthController.signupCompanyAdmin));
router.post('/signup/member-invite', asyncHandler(adminAuthController.signupFromInvite));
router.post(
  '/memberships/company-admin',
  requireAdminSession(),
  requireAdminRole('SUPER_ADMIN'),
  asyncHandler(adminAuthController.grantCompanyAdminMembership),
);

router.get('/me', requireAdminSession(), asyncHandler(adminAuthController.me));
router.get('/capabilities', requireAdminSession(), asyncHandler(adminAuthController.capabilities));
router.post('/logout', requireAdminSession(), asyncHandler(adminAuthController.logout));

router.get('/protected/super-admin', requireAdminSession(), requireAdminRole('SUPER_ADMIN'), (_req, res) => {
  res.json({ success: true, message: 'Super-admin protected route access granted' });
});

router.get(
  '/protected/company/:companyId',
  requireAdminSession(),
  requireAdminRole('SUPER_ADMIN', 'COMPANY_ADMIN'),
  requireCompanyScope(),
  (_req, res) => {
    res.json({ success: true, message: 'Company-scoped admin route access granted' });
  },
);

export default router;
