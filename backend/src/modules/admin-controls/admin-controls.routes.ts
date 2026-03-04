import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { adminControlsController } from './admin-controls.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/', requireRbacAction('audit.read'), asyncHandler(adminControlsController.listControls));
router.post('/apply', requireRbacAction('system.controls.write'), asyncHandler(adminControlsController.applyControl));

export default router;
