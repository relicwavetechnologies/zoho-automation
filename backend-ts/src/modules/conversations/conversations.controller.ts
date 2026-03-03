import { Request, Response } from 'express';

import { AuthRequest } from '../../middlewares/auth.middleware';
import { AppHttpError } from '../../middlewares/error.middleware';
import { prisma } from '../../utils/prisma';
import { isSupportedModel } from './conversations.constants';

async function getConversationForUser(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new AppHttpError(404, 'Conversation not found');
  if (conversation.user_id !== userId) {
    throw new AppHttpError(403, 'You are not allowed to access this conversation');
  }
  return conversation;
}

export async function listConversations(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const data = await prisma.conversation.findMany({
    where: { user_id: userId },
    orderBy: { updated_at: 'desc' },
  });
  return res.status(200).json(data);
}

export async function getConversation(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const conversation = await getConversationForUser(req.params.id, userId);
  return res.status(200).json(conversation);
}

export async function createConversation(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const title = req.body?.title?.trim() || 'New Conversation';
  const model = req.body?.model ?? 'gpt-4o';
  const system_prompt = req.body?.system_prompt ?? null;

  if (title.length > 500) throw new AppHttpError(400, 'Title must be <= 500 characters');
  if (!isSupportedModel(model)) throw new AppHttpError(400, 'Unsupported model');

  const conversation = await prisma.conversation.create({
    data: {
      user_id: userId,
      title,
      model,
      system_prompt,
      temperature: 0.7,
    },
  });

  return res.status(201).json(conversation);
}

export async function updateConversationSettings(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  const current = await getConversationForUser(req.params.id, userId);

  const model = req.body?.model ?? current.model;
  const system_prompt = req.body?.system_prompt === undefined ? current.system_prompt : req.body.system_prompt;
  const temperature = req.body?.temperature ?? current.temperature;

  if (!isSupportedModel(model)) throw new AppHttpError(400, 'Unsupported model');
  if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
    throw new AppHttpError(400, 'Temperature must be between 0.0 and 2.0');
  }

  const updated = await prisma.conversation.update({
    where: { id: req.params.id },
    data: {
      model,
      system_prompt,
      temperature,
      updated_at: new Date(),
    },
  });

  return res.status(200).json(updated);
}

export async function updateConversationTitle(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  await getConversationForUser(req.params.id, userId);

  const title = (req.body?.title ?? '').trim();
  if (!title) throw new AppHttpError(400, 'Title is required');
  if (title.length > 500) throw new AppHttpError(400, 'Title must be <= 500 characters');

  const updated = await prisma.conversation.update({
    where: { id: req.params.id },
    data: { title, updated_at: new Date() },
  });

  return res.status(200).json(updated);
}

export async function deleteConversation(req: Request, res: Response) {
  const userId = (req as AuthRequest).userId;
  await getConversationForUser(req.params.id, userId);

  await prisma.conversation.delete({ where: { id: req.params.id } });
  return res.status(204).send();
}

export { getConversationForUser };
