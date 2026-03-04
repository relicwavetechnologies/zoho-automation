import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { companyAdminController } from './company-admin.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/members', requireRbacAction('onboarding.manage'), asyncHandler(companyAdminController.listMembers));
router.get('/invites', requireRbacAction('onboarding.manage'), asyncHandler(companyAdminController.listInvites));
router.post('/invites', requireRbacAction('onboarding.manage'), asyncHandler(companyAdminController.createInvite));
router.post(
  '/invites/:inviteId/cancel',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.cancelInvite),
);
router.get(
  '/onboarding/status',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.getOnboardingStatus),
);
router.post(
  '/onboarding/connect',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.connectOnboarding),
);
router.post(
  '/onboarding/disconnect',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.disconnectOnboarding),
);

export default router;
