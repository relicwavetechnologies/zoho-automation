import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { auditController } from './audit.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/logs', requireRbacAction('audit.read'), auditController.queryLogs);

export default router;
