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
router.post(
  '/onboarding/sync/historical',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.triggerHistoricalSync),
);
router.post(
  '/onboarding/lark-binding',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.upsertLarkBinding),
);
router.get(
  '/onboarding/provider-status',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.getProviderStatus),
);
router.get(
  '/channel-identities',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.listChannelIdentities),
);
router.get(
  '/onboarding/zoho-oauth-config',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.getZohoOAuthConfigStatus),
);
router.get(
  '/onboarding/zoho-authorize-url',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.getZohoAuthorizeUrl),
);
router.post(
  '/onboarding/zoho-oauth-config',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.upsertZohoOAuthConfig),
);
router.delete(
  '/onboarding/zoho-oauth-config',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.deleteZohoOAuthConfig),
);
router.get(
  '/tool-permissions',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.getToolPermissions),
);
router.put(
  '/tool-permissions/:toolId/:role',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.updateToolPermission),
);
router.put(
  '/channel-identities/:identityId/ai-role',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.setLarkUserRole),
);
router.get(
  '/ai-roles',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.listAiRoles),
);
router.post(
  '/ai-roles',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.createAiRole),
);
router.put(
  '/ai-roles/:roleId',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.updateAiRole),
);
router.delete(
  '/ai-roles/:roleId',
  requireRbacAction('onboarding.manage'),
  asyncHandler(companyAdminController.deleteAiRole),
);

export default router;
