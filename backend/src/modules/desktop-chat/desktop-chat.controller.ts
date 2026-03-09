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
  type ActivityPayload,
} from '../../company/integrations/mastra/tools/activity-bus';

const KNOWN_AGENTS = ['supervisorAgent', 'zohoAgent', 'outreachAgent', 'searchAgent'] as const;
const DEFAULT_AGENT = 'supervisorAgent';

const sendSchema = z.object({
  message: z.string().min(1).max(10000),
  agentId: z.string().optional(),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

// Mirrors the frontend ContentBlock union type — kept in sync manually
type ToolBlock = {
  type: 'tool';
  id: string;
  name: string;
  label: string;
  icon: string;
  status: 'running' | 'done' | 'failed';
  resultSummary?: string;
};
type TextBlock = { type: 'text'; content: string };
type ThinkingBlock = { type: 'thinking' };
type ContentBlock = ToolBlock | TextBlock | ThinkingBlock;

class DesktopChatController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const s = (req as MemberRequest).memberSession;
    if (!s) throw new HttpException(401, 'Member session required');
    return s;
  }

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

    await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
    conversationMemoryStore.addUserMessage(conversationKey, messageId, message);

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

    const history = conversationMemoryStore.getContextMessages(conversationKey, 12);
    let historyContext = '';
    if (history.length > 1) {
      historyContext = '\n\n--- Conversation history ---\n' +
        history.slice(0, -1).map((h) => `${h.role}: ${h.content}`).join('\n') +
        '\n--- End history ---\n';
    }

    await toolPermissionService.getAllowedTools(
      session.companyId,
      session.role as 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN',
    );

    const objective = [memoryContext, historyContext, message].filter(Boolean).join('\n');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (type: string, data: unknown): void => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    sendEvent('thinking', 'Thinking...');

    // ── Ordered content blocks accumulator ──────────────────────────────────
    const contentBlocks: ContentBlock[] = [];
    let assistantText = '';
    let streamFailed = false;
    let streamErrorMessage: string | null = null;

    // Helper: push a new thinking block and record when it started
    const pushThinkingBlock = (): void => {
      (contentBlocks as any[]).push({ type: 'thinking', _startedAt: Date.now() });
    };

    // Helper: finalize the last open thinking block with duration
    const finalizeLastThinkingBlock = (): void => {
      const last = contentBlocks[contentBlocks.length - 1] as any;
      if (last?.type === 'thinking' && last._startedAt) {
        last.durationMs = Date.now() - last._startedAt;
        delete last._startedAt;
      }
    };

    // First block is always thinking
    pushThinkingBlock();

    const appendTextChunk = (chunk: string): void => {
      assistantText += chunk;
      // If transitioning from thinking → text, finalize the thinking block
      const last = contentBlocks[contentBlocks.length - 1];
      if (last?.type === 'thinking') {
        finalizeLastThinkingBlock();
        contentBlocks.push({ type: 'text', content: chunk });
      } else if (last?.type === 'text') {
        last.content += chunk;
      } else {
        contentBlocks.push({ type: 'text', content: chunk });
      }
    };

    const onActivity = (payload: ActivityPayload): void => {
      // Finalize any open thinking block before the tool starts
      finalizeLastThinkingBlock();
      contentBlocks.push({
        type: 'tool',
        id: payload.id,
        name: payload.name,
        label: payload.label,
        icon: payload.icon,
        status: 'running',
      });
    };

    const onActivityDone = (payload: ActivityPayload): void => {
      const block = contentBlocks.find(
        (b): b is ToolBlock => b.type === 'tool' && b.id === payload.id,
      );
      if (block) {
        block.status = 'done';
        if (payload.resultSummary) block.resultSummary = payload.resultSummary;
        if (payload.label) block.label = payload.label;
      }
      // AI starts thinking again after a tool finishes
      pushThinkingBlock();
    };

    const streamRequestId = randomUUID();

    registerActivityBus(streamRequestId, (type, payload) => {
      if (type === 'activity') onActivity(payload);
      if (type === 'activity_done') onActivityDone(payload);
      sendEvent(type, payload);
    });

    try {
      const requestContext = new RequestContext<Record<string, string>>();
      requestContext.set('companyId', session.companyId);
      requestContext.set('userId', session.userId);
      requestContext.set('chatId', threadId);
      requestContext.set('taskId', taskId);
      requestContext.set('messageId', messageId);
      requestContext.set('requestId', streamRequestId);
      requestContext.set('channel', 'desktop');
      requestContext.set('requesterEmail', session.email ?? '');

      const agent = mastra.getAgent(
        agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent',
      );

      const runOptions = await buildMastraAgentRunOptions(
        MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
        { requestContext },
      );

      const streamResult = await agent.stream(objective, runOptions as any);

      for await (const chunk of streamResult.textStream) {
        appendTextChunk(chunk);
        sendEvent('text', chunk);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      streamFailed = true;
      streamErrorMessage = errorMessage;
      logger.error('desktop.chat.stream.error', { threadId, userId: session.userId, error: errorMessage });
      // Mark any running tool blocks as failed
      for (const b of contentBlocks) {
        if (b.type === 'tool' && b.status === 'running') b.status = 'failed';
      }
      sendEvent('error', errorMessage);
    } finally {
      unregisterActivityBus(streamRequestId);

      // Finalize any trailing thinking block that never got resolved
      finalizeLastThinkingBlock();

      if (assistantText || contentBlocks.length > 0) {
        const metadata: Record<string, unknown> = {
          // Save the full ordered timeline — this is what the UI reads on reload
          contentBlocks,
        };
        if (streamErrorMessage) metadata.error = streamErrorMessage;

        const persistedMessage = await desktopThreadsService
          .addMessage(
            threadId,
            session.userId,
            'assistant',
            assistantText,
            Object.keys(metadata).length > 0 ? metadata : undefined,
          )
          .catch((err) => {
            logger.error('desktop.message.persist.failed', { error: err });
            return undefined;
          });

        if (!streamFailed) {
          sendEvent('done', persistedMessage ? { message: persistedMessage } : 'complete');
        }

        if (assistantText) {
          conversationMemoryStore.addAssistantMessage(conversationKey, taskId, assistantText);
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
      } else if (!streamFailed) {
        sendEvent('done', 'complete');
      }

      res.end();
    }
  };
}

export const desktopChatController = new DesktopChatController();
