import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { auditController } from './audit.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/logs', requireRbacAction('audit.read'), asyncHandler(auditController.queryLogs));

export default router;
