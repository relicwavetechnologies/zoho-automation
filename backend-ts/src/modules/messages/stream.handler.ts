import { openai } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { Request, Response } from 'express';
import { z } from 'zod';

import { prisma } from '../../utils/prisma';
import { logAudit } from '../../utils/audit';
import { resolvePolicy } from '../policy/policy.service';

interface IncomingMessagePart {
  type: string;
  text?: string;
}

interface IncomingMessage {
  role: string;
  content?: string;
  parts?: IncomingMessagePart[];
}

function extractContent(req: Request): string {
  const incomingMessages: IncomingMessage[] = req.body?.messages ?? [];
  const lastUserMsg = [...incomingMessages].reverse().find((m) => m.role === 'user');

  const bodyContent = (
    lastUserMsg?.parts
      ?.filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('') ?? lastUserMsg?.content ?? ''
  ).trim();

  if (bodyContent) return bodyContent;

  const queryRaw = typeof req.query.message === 'string' ? req.query.message : '';
  return decodeURIComponent(queryRaw).trim();
}

export async function streamHandler(req: Request, res: Response) {
  const streamTextAny: any = streamText;
  const toolAny: any = tool;

  const userId = req.userId;
  const organizationId = req.organizationId;
  const roleKey = req.roleKey;

  if (!userId) return res.status(401).json({ error: 'Missing auth token' });
  if (!organizationId || !roleKey) {
    return res.status(403).json({ error: 'Organization setup incomplete' });
  }

  const content = extractContent(req);
  if (!content) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 32000) return res.status(400).json({ error: 'Message too long' });

  const conversationId = req.params.id;
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  if (conversation.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

  const history = await prisma.message.findMany({
    where: { conversation_id: conversationId },
    orderBy: { created_at: 'desc' },
    take: 20,
  });
  history.reverse();

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(401).json({ error: 'User not found' });

  const userContext = `The user's full name is ${user.first_name} ${user.last_name}. Their email is ${user.email}. Address them by their first name (${user.first_name}) when greeting.`;
  const systemPrompt = conversation.system_prompt?.trim()
    ? `${conversation.system_prompt}\n\n${userContext}`
    : `You are Halo, a helpful and intelligent AI assistant. You are thoughtful, concise, and accurate.\n\n${userContext}`;

  const messages = [
    ...history.map((m: { role: string; content: string }) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content },
  ];

  const result: any = streamTextAny({
    model: openai(conversation.model),
    system: systemPrompt,
    messages,
    temperature: conversation.temperature,
    maxSteps: 10,
    tools: {
      get_current_time: toolAny({
        description: 'Get the current date and time in UTC',
        inputSchema: z.object({}),
        execute: async () => {
          const policy = await resolvePolicy({
            organizationId,
            roleKey,
            toolKey: 'get_current_time',
          });

          if (!policy.allowed || policy.requires_approval) {
            await logAudit({
              organizationId,
              actorUserId: userId,
              action: 'tool.denied',
              targetType: 'tool',
              targetId: 'get_current_time',
              metadata: {
                reason: policy.allowed ? 'requires_approval' : policy.reason,
                requires_approval: policy.requires_approval,
              },
            });
            return `Tool execution denied: ${
              policy.allowed ? 'requires_approval' : policy.reason
            }`;
          }

          await logAudit({
            organizationId,
            actorUserId: userId,
            action: 'tool.allowed',
            targetType: 'tool',
            targetId: 'get_current_time',
          });

          return new Date().toISOString();
        },
      }),
    },
    onFinish: async ({ text }: { text: string }) => {
      await prisma.message.create({
        data: { conversation_id: conversationId, role: 'user', content },
      });

      if (text.trim()) {
        await prisma.message.create({
          data: { conversation_id: conversationId, role: 'assistant', content: text },
        });
      }

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updated_at: new Date() },
      });
    },
  });

  result.pipeUIMessageStreamToResponse(res);
}
