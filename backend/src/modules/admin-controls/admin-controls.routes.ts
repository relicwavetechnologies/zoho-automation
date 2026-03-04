import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { adminControlsController } from './admin-controls.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/', requireRbacAction('audit.read'), adminControlsController.listControls);
router.post('/apply', requireRbacAction('system.controls.write'), adminControlsController.applyControl);

export default router;
