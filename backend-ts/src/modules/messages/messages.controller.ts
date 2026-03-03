import { Request, Response } from 'express';

import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppHttpError } from '../../middlewares/error.middleware';
import { prisma } from '../../utils/prisma';
import { getConversationForUser } from '../conversations/conversations.controller';

export async function listMessages(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const conversationId = req.params.id;

  await getConversationForUser(conversationId, userId);

  const messages = await prisma.message.findMany({
    where: { conversation_id: conversationId },
    orderBy: { created_at: 'asc' },
  });

  return res.status(200).json(messages);
}

export async function sendMessage(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const conversationId = req.params.id;

  await getConversationForUser(conversationId, userId);

  const content = (req.body?.content ?? '').trim();
  if (!content) throw new AppHttpError(400, 'Message content cannot be empty');
  if (content.length > 32000) throw new AppHttpError(400, 'Message content too long (max 32000 chars)');

  const message = await prisma.message.create({
    data: {
      conversation_id: conversationId,
      role: 'user',
      content,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updated_at: new Date() },
  });

  return res.status(201).json(message);
}
