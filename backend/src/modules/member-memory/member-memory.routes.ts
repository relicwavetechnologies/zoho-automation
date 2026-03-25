import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { memberMemoryController } from './member-memory.controller';

const router = Router();

router.get('/', requireMemberSession(), asyncHandler(memberMemoryController.list));
router.delete('/:memoryId', requireMemberSession(), asyncHandler(memberMemoryController.forget));
router.post('/clear', requireMemberSession(), asyncHandler(memberMemoryController.clear));

export default router;
