import { Router } from 'express';

import {
  requireAdminRole,
  requireAdminSession,
  requireCompanyScope,
} from '../../middlewares/admin-auth.middleware';
import { adminAuthController } from './admin-auth.controller';

const router = Router();

router.post('/bootstrap-super-admin', adminAuthController.bootstrapSuperAdmin);
router.post('/login/super-admin', adminAuthController.loginSuperAdmin);
router.post('/login/company-admin', adminAuthController.loginCompanyAdmin);
router.post(
  '/memberships/company-admin',
  requireAdminSession(),
  requireAdminRole('SUPER_ADMIN'),
  adminAuthController.grantCompanyAdminMembership,
);

router.get('/me', requireAdminSession(), adminAuthController.me);
router.get('/capabilities', requireAdminSession(), adminAuthController.capabilities);
router.post('/logout', requireAdminSession(), adminAuthController.logout);

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
