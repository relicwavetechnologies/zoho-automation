import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { mastraRuntimeController } from './mastra-runtime.controller';

const router = Router();

router.get('/', asyncHandler(mastraRuntimeController.listAgents));
router.post('/:agentId/generate', asyncHandler(mastraRuntimeController.generate));
router.post('/:agentId/stream', asyncHandler(mastraRuntimeController.stream));

export default router;
