import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { userController } from './user.controller';

const router = Router();

router.post('/register', asyncHandler(userController.register));
router.post('/login', asyncHandler(userController.login));

export default router;

