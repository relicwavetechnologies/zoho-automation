import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { listMessages, sendMessage } from './messages.controller';

const messagesRouter = Router({ mergeParams: true });

messagesRouter.get('/', asyncHandler(listMessages));
messagesRouter.post('/', asyncHandler(sendMessage));

export default messagesRouter;
