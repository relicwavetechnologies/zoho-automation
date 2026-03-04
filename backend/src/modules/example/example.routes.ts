import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { exampleController } from './example.controller';

const router = Router();

router.post('/', asyncHandler(exampleController.createExample));
router.get('/', asyncHandler(exampleController.getExamples));

export default router;

