import { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { RequestContext } from '@mastra/core/di';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import { mastra } from '../../company/integrations/mastra';
import {
  buildMastraAgentRunOptions,
  MASTRA_AGENT_TARGETS,
  type MastraAgentTargetId,
} from '../../company/integrations/mastra/mastra-model-control';
import { personalVectorMemoryService } from '../../company/integrations/vector/personal-vector-memory.service';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { logger } from '../../utils/logger';
import {
  registerActivityBus,
  unregisterActivityBus,
} from '../../company/integrations/mastra/tools/activity-bus';

const KNOWN_AGENTS = ['supervisorAgent', 'zohoAgent', 'outreachAgent', 'searchAgent'] as const;
const DEFAULT_AGENT = 'supervisorAgent';

const sendSchema = z.object({
  message: z.string().min(1).max(10000),
  agentId: z.string().optional(),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class DesktopChatController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const s = (req as MemberRequest).memberSession;
    if (!s) throw new HttpException(401, 'Member session required');
    return s;
  }

  /** POST /api/desktop/chat/:threadId/send — Accept message, persist, then stream response. */
  send = async (req: Request, res: Response) => {
    const session = this.session(req);
    const threadId = req.params.threadId;
    const { message, agentId: requestedAgent } = sendSchema.parse(req.body);

    const agentId = requestedAgent && (KNOWN_AGENTS as readonly string[]).includes(requestedAgent)
      ? requestedAgent
      : DEFAULT_AGENT;

    const messageId = randomUUID();
    const taskId = randomUUID();
    const conversationKey = `desktop:${threadId}`;

    // 1. Persist user message
    await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
    conversationMemoryStore.addUserMessage(conversationKey, messageId, message);

    // 2. Store user turn in vector memory (fire-and-forget)
    personalVectorMemoryService.storeChatTurn({
      companyId: session.companyId,
      requesterUserId: session.userId,
      conversationKey,
      sourceId: `desktop-user-${messageId}`,
      role: 'user',
      text: message,
      channel: 'desktop',
      chatId: threadId,
    }).catch((err) => logger.error('desktop.vector.user.store.failed', { error: err }));

    // 3. Retrieve personal memory context
    let memoryContext = '';
    try {
      const memories = await personalVectorMemoryService.query({
        companyId: session.companyId,
        requesterUserId: session.userId,
        text: message,
        limit: 4,
      });
      if (memories.length > 0) {
        memoryContext = '\n\n--- Relevant personal memory ---\n' +
          memories.map((m) => `[${m.role ?? 'unknown'}] ${m.content}`).join('\n') +
          '\n--- End memory ---\n';
      }
    } catch (err) {
      logger.warn('desktop.vector.query.failed', { error: err });
    }

    // 4. Get conversation history
    const history = conversationMemoryStore.getContextMessages(conversationKey, 12);
    let historyContext = '';
    if (history.length > 1) {
      historyContext = '\n\n--- Conversation history ---\n' +
        history.slice(0, -1).map((h) => `${h.role}: ${h.content}`).join('\n') +
        '\n--- End history ---\n';
    }

    // 5. Check allowed tools
    await toolPermissionService.getAllowedTools(
      session.companyId,
      session.role as 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN',
    );

    // 6. Build objective
    const objective = [memoryContext, historyContext, message].filter(Boolean).join('\n');

    // 7. Set up SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (type: string, data: unknown): void => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    // Immediately signal "thinking" so the shimmer appears right away
    sendEvent('thinking', 'Thinking...');

    let assistantText = '';

    // Each request gets a unique ID used as the key in the activity bus
    const streamRequestId = randomUUID();

    // Register callback so agent tools can emit live activity events to this stream
    registerActivityBus(streamRequestId, (type, payload) => {
      sendEvent(type, payload);
    });

    try {
      const requestContext = new RequestContext<Record<string, string>>();
      requestContext.set('companyId', session.companyId);
      requestContext.set('userId', session.userId);
      requestContext.set('chatId', threadId);
      requestContext.set('taskId', taskId);
      requestContext.set('messageId', messageId);
      // Use streamRequestId so tools can look up the bus
      requestContext.set('requestId', streamRequestId);
      requestContext.set('channel', 'desktop');

      const agent = mastra.getAgent(
        agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent',
      );

      const runOptions = await buildMastraAgentRunOptions(
        MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
        { requestContext },
      );

      const streamResult = await agent.stream(objective, runOptions as any);
      const textStream = streamResult.textStream;

      for await (const chunk of textStream) {
        assistantText += chunk;
        sendEvent('text', chunk);
      }

      sendEvent('done', 'complete');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error('desktop.chat.stream.error', { threadId, userId: session.userId, error: errorMessage });
      sendEvent('error', errorMessage);
    } finally {
      // Deregister the bus for this request
      unregisterActivityBus(streamRequestId);

      if (assistantText) {
        conversationMemoryStore.addAssistantMessage(conversationKey, taskId, assistantText);
        await desktopThreadsService
          .addMessage(threadId, session.userId, 'assistant', assistantText)
          .catch((err) => logger.error('desktop.message.persist.failed', { error: err }));
        personalVectorMemoryService.storeChatTurn({
          companyId: session.companyId,
          requesterUserId: session.userId,
          conversationKey,
          sourceId: `desktop-assistant-${taskId}`,
          role: 'assistant',
          text: assistantText,
          channel: 'desktop',
          chatId: threadId,
        }).catch((err) => logger.error('desktop.vector.assistant.store.failed', { error: err }));
      }
      res.end();
    }
  };
}

export const desktopChatController = new DesktopChatController();
