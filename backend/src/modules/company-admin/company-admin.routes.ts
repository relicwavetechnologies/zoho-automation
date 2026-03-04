import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { companyAdminController } from './company-admin.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/members', requireRbacAction('onboarding.manage'), companyAdminController.listMembers);
router.get('/invites', requireRbacAction('onboarding.manage'), companyAdminController.listInvites);
router.post('/invites', requireRbacAction('onboarding.manage'), companyAdminController.createInvite);
router.post('/invites/:inviteId/cancel', requireRbacAction('onboarding.manage'), companyAdminController.cancelInvite);

export default router;
