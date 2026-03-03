import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversationSettings,
  updateConversationTitle,
} from './conversations.controller';

const conversationsRouter = Router();

conversationsRouter.get('/', asyncHandler(listConversations));
conversationsRouter.post('/', asyncHandler(createConversation));
conversationsRouter.get('/:id', asyncHandler(getConversation));
conversationsRouter.patch('/:id/settings', asyncHandler(updateConversationSettings));
conversationsRouter.patch('/:id/title', asyncHandler(updateConversationTitle));
conversationsRouter.delete('/:id', asyncHandler(deleteConversation));

export default conversationsRouter;
