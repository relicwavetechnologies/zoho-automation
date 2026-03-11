import { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { RequestContext } from '@mastra/core/di';
import { ApiResponse } from '../../core/api-response';
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

const workspaceSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
});

const actionResultSchema = z.object({
  kind: z.enum(['list_files', 'read_file', 'write_file', 'mkdir', 'delete_path', 'run_command']),
  ok: z.boolean(),
  summary: z.string().min(1).max(30000),
});

const actSchema = z.object({
  message: z.string().min(1).max(10000).optional(),
  agentId: z.string().optional(),
  workspace: workspaceSchema,
  actionResult: actionResultSchema.optional(),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

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
// Thinking block carries live reasoning text streamed from the model
type ThinkingBlock = { type: 'thinking'; text?: string; durationMs?: number };
type ContentBlock = ToolBlock | TextBlock | ThinkingBlock;

type DesktopAction = {
  kind: 'list_files' | 'read_file' | 'write_file' | 'mkdir' | 'delete_path' | 'run_command';
  path?: string;
  content?: string;
  command?: string;
};

const LOCAL_ACTION_TAG = 'desktop-action';

const parseDesktopAction = (text: string): DesktopAction | null => {
  const match = text.match(new RegExp(`<${LOCAL_ACTION_TAG}>([\\s\\S]*?)</${LOCAL_ACTION_TAG}>`, 'i'));
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim()) as DesktopAction;
    if (typeof parsed?.kind !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
};

const buildDesktopCapabilityPrompt = (workspace: { name: string; path: string }, actionResult?: {
  kind: string;
  ok: boolean;
  summary: string;
}): string => {
  const resultSection = actionResult
    ? [
      '\n--- LOCAL ACTION RESULT ---',
      `kind: ${actionResult.kind}`,
      `ok: ${String(actionResult.ok)}`,
      actionResult.summary,
      '--- END LOCAL ACTION RESULT ---\n',
    ].join('\n')
    : '';

  return [
    '\n--- DESKTOP LOCAL WORKSPACE ---',
    'You are responding inside the macOS desktop app.',
    `Selected workspace name: ${workspace.name}`,
    `Selected workspace path: ${workspace.path}`,
    'You may request EXACTLY ONE local workspace action at a time.',
    `If you need one, respond with ONLY <${LOCAL_ACTION_TAG}>{{JSON}}</${LOCAL_ACTION_TAG}> and no other text.`,
    'Allowed action JSON shapes:',
    '{"kind":"list_files","path":"."}',
    '{"kind":"read_file","path":"relative/path.txt"}',
    '{"kind":"write_file","path":"relative/path.txt","content":"full file content"}',
    '{"kind":"mkdir","path":"relative/folder"}',
    '{"kind":"delete_path","path":"relative/path"}',
    '{"kind":"run_command","command":"pnpm test"}',
    'Rules:',
    '- All paths must be relative to the selected workspace.',
    '- Prefer list_files/read_file before write_file/delete_path.',
    '- Use run_command only when necessary.',
    '- After receiving a local action result, continue the task from that result.',
    '- If you do not need a local action, answer normally.',
    '--- END DESKTOP LOCAL WORKSPACE ---\n',
    resultSection,
  ].join('\n');
};

// Mirrors the frontend ContentBlock union type — kept in sync manually
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
        limit: 10, // Request slightly more to pad against filtered items
      });

      // Exclude vectors that came from the current thread to prevent context leakage
      const filteredMemories = memories
        .filter((m) => m.conversationKey !== conversationKey)
        .slice(0, 4);

      if (filteredMemories.length > 0) {
        memoryContext =
          '\n\n--- CONTEXT RETRIEVED FROM PAST CONVERSATIONS ---\n' +
          "(Note: The information below is retrieved from the user's past threads for context. Do NOT assume this is part of the current active conversation unless the user explicitly asks about it.)\n" +
          filteredMemories.map((m) => `[${m.role ?? 'unknown'}] ${m.content}`).join('\n') +
          '\n--- End past context ---\n';
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
    let thinkingText = '';
    let streamFailed = false;
    let streamErrorMessage: string | null = null;

    // Helper: push a new thinking block and record when it started
    const pushThinkingBlock = (): void => {
      (contentBlocks as any[]).push({ type: 'thinking', text: '', _startedAt: Date.now() });
    };

    // Helper: finalize the last open thinking block with duration
    const finalizeLastThinkingBlock = (): void => {
      const last = contentBlocks[contentBlocks.length - 1] as any;
      if (last?.type === 'thinking' && last._startedAt) {
        last.durationMs = Date.now() - last._startedAt;
        delete last._startedAt;
      }
    };

    // Helper: append a reasoning chunk to the current thinking block
    const appendThinkingChunk = (delta: string): void => {
      thinkingText += delta;
      const last = contentBlocks[contentBlocks.length - 1] as any;
      if (last?.type === 'thinking') {
        last.text = (last.text || '') + delta;
      }
      sendEvent('thinking_token', delta);
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
      requestContext.set('authProvider', session.authProvider);
      requestContext.set('larkTenantKey', session.larkTenantKey ?? '');
      requestContext.set('larkOpenId', session.larkOpenId ?? '');
      requestContext.set('larkUserId', session.larkUserId ?? '');
      requestContext.set(
        'larkAuthMode',
        session.authProvider === 'lark' ? 'user_linked' : 'tenant',
      );

      const agent = mastra.getAgent(
        agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent',
      );

      const runOptions = await buildMastraAgentRunOptions(
        MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
        { requestContext },
      );

      const streamResult = await agent.stream(objective, runOptions as any);

      // ── Background: collect reasoning/thinking chunks without blocking text ──
      // fullStream gives us fine-grained chunks. We consume reasoning-delta
      // in the background while textStream drives the main response.
      // NOTE: We intentionally do NOT await this — it races alongside textStream.
      (async () => {
        try {
          for await (const chunk of streamResult.fullStream) {
            const c = chunk as any;
            const type: string = c.type ?? '';
            if (type === 'reasoning-delta' || type === 'reasoning') {
              const delta: string = c.payload?.textDelta ?? c.textDelta ?? '';
              if (delta) appendThinkingChunk(delta);
            }
          }
        } catch {
          // Reasoning stream errors are non-fatal — ignore silently
        }
      })();

      // ── Foreground: reliable text delivery via textStream ─────────────────
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

  act = async (req: Request, res: Response) => {
    const session = this.session(req);
    const threadId = req.params.threadId;
    const parsed = actSchema.parse(req.body);
    const { workspace, actionResult, agentId: requestedAgent } = parsed;
    const message = parsed.message?.trim() ?? '';

    const agentId = requestedAgent && (KNOWN_AGENTS as readonly string[]).includes(requestedAgent)
      ? requestedAgent
      : DEFAULT_AGENT;

    const conversationKey = `desktop:${threadId}`;

    if (message && !actionResult) {
      const messageId = randomUUID();
      await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
      conversationMemoryStore.addUserMessage(conversationKey, messageId, message);
    }

    const history = conversationMemoryStore.getContextMessages(conversationKey, 12);
    let historyContext = '';
    if (history.length > 0) {
      historyContext = '\n\n--- Conversation history ---\n' +
        history.map((h) => `${h.role}: ${h.content}`).join('\n') +
        '\n--- End history ---\n';
    }

    await toolPermissionService.getAllowedTools(
      session.companyId,
      session.role as 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN',
    );

    const desktopPrompt = buildDesktopCapabilityPrompt(workspace, actionResult);
    const objective = [
      desktopPrompt,
      historyContext,
      message || 'Continue from the latest local workspace action result and finish the user request.',
    ]
      .filter(Boolean)
      .join('\n');

    const requestContext = new RequestContext<Record<string, string>>();
    requestContext.set('companyId', session.companyId);
    requestContext.set('userId', session.userId);
    requestContext.set('chatId', threadId);
    requestContext.set('channel', 'desktop');
    requestContext.set('requesterEmail', session.email ?? '');

    const agent = mastra.getAgent(
      agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent',
    );

    const runOptions = await buildMastraAgentRunOptions(
      MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
      { requestContext },
    );

    const result = await agent.generate(objective, runOptions as any);
    const assistantText = typeof result?.text === 'string' ? result.text.trim() : '';
    const requestedAction = parseDesktopAction(assistantText);

    if (requestedAction) {
      return res.json(ApiResponse.success({ kind: 'action', action: requestedAction }, 'Local action requested'));
    }

    const assistantMessage = await desktopThreadsService.addMessage(
      threadId,
      session.userId,
      'assistant',
      assistantText,
    );
    conversationMemoryStore.addAssistantMessage(conversationKey, randomUUID(), assistantText);

    return res.json(ApiResponse.success({ kind: 'answer', message: assistantMessage }, 'Assistant reply created'));
  };
}

export const desktopChatController = new DesktopChatController();
