import { Router } from 'express';

import { exampleController } from './example.controller';

const router = Router();

router.post('/', exampleController.createExample);
router.get('/', exampleController.getExamples);

export default router;


