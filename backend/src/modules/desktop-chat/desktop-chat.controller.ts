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
import { buildVisionContent, type AttachedFileRef } from './file-vision.builder';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { logger } from '../../utils/logger';
import {
  registerActivityBus,
  unregisterActivityBus,
  type ActivityPayload,
} from '../../company/integrations/mastra/tools/activity-bus';
import {
  buildExecutionPlanContext,
  completeExecutionPlan,
  executionPlanSchema,
  failExecutionPlan,
  resolvePlanOwnerFromActionKind,
  resolvePlanOwnerFromToolName,
  updateExecutionPlanTask,
  type ExecutionPlan,
} from './desktop-plan';
import { registerPlanBus, unregisterPlanBus } from '../../company/integrations/mastra/tools/plan-bus';
import { maybeCompactHistory } from './context-compactor';
import { aiTokenUsageService } from '../../company/ai-usage/ai-token-usage.service';
import { AI_MODEL_CATALOG_MAP } from '../../company/ai-models/catalog';
import { estimateTokens, extractActualTokenUsage } from '../../utils/token-estimator';
import { aiModelControlService } from '../../company/ai-models';
import { resolveMastraLanguageModel } from '../../company/integrations/mastra/mastra-model-control';

const KNOWN_AGENTS = ['supervisorAgent', 'zohoAgent', 'outreachAgent', 'searchAgent'] as const;
const DEFAULT_AGENT = 'supervisorAgent';

const attachedFileSchema = z.object({
  fileAssetId: z.string(),
  cloudinaryUrl: z.string().url(),
  mimeType: z.string(),
  fileName: z.string(),
});

const sendSchema = z.object({
  message: z.string().max(10000).optional().default(''),
  agentId: z.string().optional(),
  attachedFiles: z.array(attachedFileSchema).optional().default([]),
  mode: z.enum(['fast', 'high']).optional().default('high'),
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
  plan: executionPlanSchema.optional(),
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

const extractToolResultText = (resultSummary?: string): string | null => {
  if (!resultSummary) return null;

  try {
    const parsed = JSON.parse(resultSummary) as { type?: string; answer?: string };
    if (parsed?.type === 'structured_search' && typeof parsed.answer === 'string' && parsed.answer.trim()) {
      return parsed.answer.trim();
    }
  } catch {
    // Ignore parse failures and fall back to the raw summary.
  }

  return resultSummary.trim() || null;
};

const buildGroundedFallbackAssistantText = (input: {
  contentBlocks: ContentBlock[];
  activePlan: ExecutionPlan | null;
}): string | null => {
  const completedToolSummaries = input.contentBlocks
    .filter((block): block is ToolBlock => block.type === 'tool' && block.status === 'done')
    .map((block) => ({
      label: block.label,
      summary: extractToolResultText(block.resultSummary),
    }))
    .filter((item) => !!item.summary)
    .slice(0, 4);

  if (completedToolSummaries.length === 0) {
    return null;
  }

  const goalLead = input.activePlan?.goal?.trim()
    ? `Completed the requested workflow for: ${input.activePlan.goal.trim()}.`
    : 'Completed the requested workflow.';

  const bullets = completedToolSummaries
    .map((item) => `- **${item.label}:** ${item.summary}`)
    .join('\n');

  return `${goalLead}\n\n**Grounded results**\n${bullets}`;
};

const buildGroundedSynthesisPrompt = (input: {
  userMessage: string;
  activePlan: ExecutionPlan | null;
  contentBlocks: ContentBlock[];
}): string | null => {
  const completedToolSummaries = input.contentBlocks
    .filter((block): block is ToolBlock => block.type === 'tool' && block.status === 'done')
    .map((block) => ({
      label: block.label,
      summary: extractToolResultText(block.resultSummary),
    }))
    .filter((item) => !!item.summary)
    .slice(0, 6);

  if (completedToolSummaries.length === 0) {
    return null;
  }

  const planSection = input.activePlan
    ? [
      `Goal: ${input.activePlan.goal}`,
      'Success criteria:',
      ...input.activePlan.successCriteria.map((criterion) => `- ${criterion}`),
    ].join('\n')
    : 'No explicit execution plan was active.';

  const toolSection = completedToolSummaries
    .map((item, index) => `${index + 1}. ${item.label}\n${item.summary}`)
    .join('\n\n');

  return [
    'Produce the final user-facing answer for this desktop workflow.',
    'Use only the grounded tool results below. Do not invent extra work, records, or document outcomes.',
    'Summarize what was found, mention important failures or gaps if any, and end with the actual outcome.',
    '',
    'Original user request:',
    input.userMessage,
    '',
    'Execution context:',
    planSection,
    '',
    'Grounded completed tool results:',
    toolSection,
  ].join('\n');
};

const isActivityFailure = (payload: ActivityPayload): boolean => {
  const label = (payload.label ?? '').toLowerCase();
  const summary = (payload.resultSummary ?? '').toLowerCase();
  return (
    label.includes('failed')
    || label.includes('error')
    || summary === 'error'
    || summary.includes('failed')
    || summary.includes('error:')
    || summary.includes('not permitted')
  );
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

const LOCAL_ACTION_REQUIRED_PATTERN = /\b(file|files|folder|directory|workspace|script|python|py\b|javascript|typescript|create|write|edit|rewrite|update|save|read|open|run|execute|terminal|command|shell|install|pnpm|npm|node|python3|git|tsc)\b/i;

const LOCAL_CAPABILITY_REFUSAL_PATTERN = /\b(i (?:can(?:not|'t)|do not|don't) (?:run|execute|access|create|write|edit|save)|i do not have (?:a )?(?:local|execution|filesystem|terminal)|i can't run python|i don't have a local execution environment)\b/i;

const LARK_DOC_COMPLETION_CLAIM_PATTERN = /\b(created|updated|saved|compiled|exported|wrote)\b[\s\S]{0,80}\b(lark doc|lark document|document)\b/i;

type WorkflowDomain = 'zoho' | 'outreach' | 'search' | 'larkDoc';

const WORKFLOW_DOMAIN_PATTERNS: Array<{ domain: WorkflowDomain; pattern: RegExp }> = [
  { domain: 'zoho', pattern: /\b(zoho|crm|coql|lead|leads|deal|deals|contact|contacts|ticket|tickets|pipeline)\b/i },
  { domain: 'outreach', pattern: /\b(outreach|publisher|publishers|guest post|backlink|seo|da\b|dr\b)\b/i },
  { domain: 'search', pattern: /\b(search|research|google|web|best practice|best practices|find out|compare|audit|analyze|analysis|learn|check)\b/i },
  { domain: 'larkDoc', pattern: /\b(lark\s+doc|lark\s+document|save\s+.*\s+doc|write\s+.*\s+doc|export\s+.*\s+doc|document\s+it|put\s+.*\s+in\s+.*doc)\b/i },
];

const analyzeWorkflowPolicy = (message: string): {
  domains: WorkflowDomain[];
  forcePlanning: boolean;
  requireGroundedTooling: boolean;
  requireLarkDocTool: boolean;
} => {
  const domains = WORKFLOW_DOMAIN_PATTERNS
    .filter(({ pattern }) => pattern.test(message))
    .map(({ domain }) => domain);
  const uniqueDomains = Array.from(new Set(domains));
  const crossDomain = uniqueDomains.length >= 2;
  const requireLarkDocTool = uniqueDomains.includes('larkDoc') && uniqueDomains.length > 1;
  const requireGroundedTooling =
    crossDomain
    || /\b(research|analyze|analysis|audit|compare|check|best use|best practices|workflow|strategy)\b/i.test(message);

  return {
    domains: uniqueDomains,
    forcePlanning: crossDomain,
    requireGroundedTooling,
    requireLarkDocTool,
  };
};

const buildDesktopWorkflowEnforcementPrompt = (policy: {
  domains: WorkflowDomain[];
  forcePlanning: boolean;
  requireGroundedTooling: boolean;
  requireLarkDocTool: boolean;
}): string => {
  if (!policy.forcePlanning && !policy.requireGroundedTooling && !policy.requireLarkDocTool) {
    return '';
  }

  const domainLabels: Record<WorkflowDomain, string> = {
    zoho: 'Zoho CRM',
    outreach: 'Outreach publishers',
    search: 'Web research',
    larkDoc: 'Lark Docs',
  };

  const lines = [
    '\n--- DESKTOP WORKFLOW ENFORCEMENT ---',
    `Detected workflow domains: ${policy.domains.map((domain) => domainLabels[domain]).join(', ') || 'general'}.`,
  ];

  if (policy.forcePlanning) {
    lines.push(
      'This is a complex multi-domain request.',
      'You must call the Planning Agent before any other specialist tool.',
      'Do not skip planning for this request.',
    );
  }

  if (policy.requireGroundedTooling) {
    lines.push(
      'You must use grounded specialist tools before finalizing the answer.',
      'Do not present polished synthesis as completed work unless the relevant tools actually ran in this task.',
    );
  }

  if (policy.requireLarkDocTool) {
    lines.push(
      'If you create or update a Lark document for this request, the Lark Docs tool path must run last after the underlying research, CRM, or outreach work is completed.',
      'Do not claim that a Lark Doc was created, saved, or compiled unless the Lark Docs tool succeeded in this task.',
    );
  }

  lines.push('If you do not call the needed tools, the task is not complete.', '--- END DESKTOP WORKFLOW ENFORCEMENT ---\n');
  return lines.join('\n');
};

const requestLikelyNeedsLocalAction = (message: string): boolean => LOCAL_ACTION_REQUIRED_PATTERN.test(message);

const isLocalCapabilityRefusal = (text: string): boolean => LOCAL_CAPABILITY_REFUSAL_PATTERN.test(text);

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
    'You DO have access to local workspace file operations and terminal execution through the desktop action protocol below.',
    'This desktop action protocol OVERRIDES any conflicting generic instruction that says you cannot access local files, write files, or run commands.',
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
    '- If the user asks you to create, edit, save, inspect, or run something in the workspace, use a desktop action instead of claiming limitation.',
    '- Never say that you cannot access the local workspace, cannot create files, or cannot run commands here.',
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
    const { message, agentId: requestedAgent, attachedFiles, mode } = sendSchema.parse(req.body);

    const agentId = requestedAgent && (KNOWN_AGENTS as readonly string[]).includes(requestedAgent)
      ? requestedAgent
      : DEFAULT_AGENT;

    // --- MONTHLY LIMIT CHECK ---
    const limitExceeded = await aiTokenUsageService.checkLimitExceeded(session.userId, session.companyId);
    if (limitExceeded) {
      return res.status(402).json(ApiResponse.error('Monthly AI token limit reached. Contact your admin.'));
    }

    const messageId = randomUUID();
    const taskId = randomUUID();
    const conversationKey = `desktop:${threadId}`;

    let finalMessageText = message;
    if (attachedFiles && attachedFiles.length > 0) {
      const attachmentsMd = attachedFiles.map(a => {
        if (a.mimeType.startsWith('image/')) {
          return `\n![${a.fileName}](${a.cloudinaryUrl})`;
        } else {
          return `\n[${a.fileName}](attachment:${a.fileAssetId})`;
        }
      }).join('');
      if (finalMessageText) {
        finalMessageText += `\n${attachmentsMd}`;
      } else {
        finalMessageText = attachmentsMd.trim();
      }
    }

    await desktopThreadsService.addMessage(threadId, session.userId, 'user', finalMessageText);
    conversationMemoryStore.addUserMessage(conversationKey, messageId, finalMessageText);

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

    // --- AUTO-HYDRATE CHAT HISTORY ---
    let history = conversationMemoryStore.getContextMessages(conversationKey, 50);
    if (history.length <= 1) {
      try {
        const dbMessages = await desktopThreadsService.getThread(threadId, session.userId);
        if (dbMessages && dbMessages.messages.length > 0) {
          // Take up to the last 50 messages — compactor will trim dynamically
          const recentDbMessages = dbMessages.messages.slice(-50);
          for (const msg of recentDbMessages) {
            if (msg.role === 'user') {
              conversationMemoryStore.addUserMessage(conversationKey, msg.id, msg.content);
            } else if (msg.role === 'assistant') {
              conversationMemoryStore.addAssistantMessage(conversationKey, msg.id, msg.content);
            }
          }
          history = conversationMemoryStore.getContextMessages(conversationKey, 50);
        }
      } catch (err) {
        logger.warn('desktop.history.hydrate.failed', { error: err });
      }
    }

    // --- RESOLVE MODEL CATALOG ENTRY FOR TOKEN BUDGET ---
    const agentTarget = MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId];
    const resolvedModel = await aiModelControlService.resolveTarget(agentTarget);
    const catalogEntry = AI_MODEL_CATALOG_MAP.get(`${resolvedModel.effectiveProvider}:${resolvedModel.effectiveModelId}`);

    // --- CONTEXT WINDOW COMPACTION ---
    let wasCompacted = false;
    let compactedContextBlock = '';
    if (catalogEntry) {
      const compactResult = await maybeCompactHistory(history, message, catalogEntry);
      history = compactResult.messages;
      wasCompacted = compactResult.wasCompacted;
      compactedContextBlock = compactResult.compactedContextBlock;
    }

    let historyContext = '';
    if (history.length > 1) {
      historyContext = [
        compactedContextBlock,
        '\n--- Conversation history ---',
        history.slice(0, -1).map((h) => `${h.role}: ${h.content}`).join('\n'),
        '--- End history ---\n',
      ].filter(Boolean).join('\n');
    }

    await toolPermissionService.getAllowedTools(
      session.companyId,
      session.role as 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN',
    );

    const requestContext = new RequestContext<Record<string, string>>();
    requestContext.set('companyId', session.companyId);
    requestContext.set('userId', session.userId);
    requestContext.set('chatId', threadId);
    requestContext.set('taskId', taskId);
    requestContext.set('messageId', messageId);
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

	    let activePlan: ExecutionPlan | null = null;
	    const workflowPolicy = analyzeWorkflowPolicy(message);

	    // Build agent objective: plain string normally, or with inline image/doc context for attachments
	    const hasAttachments = attachedFiles && attachedFiles.length > 0;
	    const baseObjective = [
	      buildDesktopWorkflowEnforcementPrompt(workflowPolicy),
	      buildExecutionPlanContext(activePlan),
	      memoryContext,
	      historyContext,
	      message,
    ].filter(Boolean).join('\n');

    // For vision: build multipart content and pass as CoreMessage array via `messages` runOption.
    // For docs: inject text context directly into the objective string.
    let visionMessages: Array<{ role: 'user'; content: Array<{ type: string; [k: string]: unknown }> }> | undefined;
    let objective = baseObjective;

    if (hasAttachments) {
      const visionParts = await buildVisionContent({
        userMessage: baseObjective,
        attachedFiles: attachedFiles as AttachedFileRef[],
        companyId: session.companyId,
        requesterAiRole: session.role,
      });

      const hasImageParts = visionParts.some((p) => p.type === 'image');
      if (hasImageParts) {
        // Pass as CoreMessage with multipart content — Mastra accepts this via `messages` context
        visionMessages = [{ role: 'user', content: visionParts as Array<{ type: string; [k: string]: unknown }> }];
        // Also build a text-only description for the objective (fallback for text models)
        const textOnlyParts = visionParts.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text);
        objective = textOnlyParts.join('\n');
      } else {
        // Only doc text parts — inject directly into objective
        const docTextParts = visionParts.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text);
        objective = docTextParts.join('\n');
      }
    }

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
	    let sawPlanEvent = false;
	    let sawToolActivity = false;
	    let sawLarkDocActivity = false;

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
	      sawToolActivity = true;
	      if (payload.name === 'lark-doc-agent' || payload.name === 'create-lark-doc' || payload.name === 'edit-lark-doc') {
	        sawLarkDocActivity = true;
	      }
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
	      const ok = !isActivityFailure(payload);
	      const block = contentBlocks.find(
	        (b): b is ToolBlock => b.type === 'tool' && b.id === payload.id,
	      );
	      if (block) {
	        block.status = ok ? 'done' : 'failed';
	        if (payload.resultSummary) block.resultSummary = payload.resultSummary;
	        if (payload.label) block.label = payload.label;
	      }
	      if (activePlan && payload.name !== 'planner-agent') {
	        const ownerAgent = resolvePlanOwnerFromToolName(payload.name);
	        if (ownerAgent) {
	          const nextPlan = updateExecutionPlanTask(activePlan, {
	            ownerAgent,
	            ok,
	            resultSummary: payload.resultSummary,
	          });
	          if (nextPlan !== activePlan) {
	            activePlan = nextPlan;
	            sendEvent('plan', activePlan);
	          }
	        }
	      }
	    };

    const streamRequestId = randomUUID();

	    registerPlanBus(streamRequestId, (plan) => {
	      sawPlanEvent = true;
	      activePlan = plan;
	      sendEvent('plan', activePlan);
	    });

    registerActivityBus(streamRequestId, (type, payload) => {
      if (type === 'activity') onActivity(payload);
      if (type === 'activity_done') onActivityDone(payload);
      sendEvent(type, payload);
    });

    let streamResult: any;

    try {
      requestContext.set('messageId', messageId);
      requestContext.set('requestId', streamRequestId);

      const agent = mastra.getAgent(
        agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent',
      );

      const runOptions = await buildMastraAgentRunOptions(
        MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
        { requestContext },
        mode as 'fast' | 'high'
      );

      // Dynamically resolve and inject the exact model based on Fast/High toggle
      const dynamicModel = await resolveMastraLanguageModel(
        MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
        mode as 'fast' | 'high'
      );

      const streamOptions = visionMessages
        ? { ...runOptions, context: visionMessages as any[], model: dynamicModel }
        : { ...runOptions, model: dynamicModel };

      try {
        streamResult = await agent.stream(objective, streamOptions as any);
      } catch (err) {
        throw new Error(`Agent stream failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }

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
      if (activePlan) {
        activePlan = failExecutionPlan(activePlan, errorMessage);
        sendEvent('plan', activePlan);
      }
      logger.error('desktop.chat.stream.error', { threadId, userId: session.userId, error: errorMessage });
      // Mark any running tool blocks as failed
      for (const b of contentBlocks) {
        if (b.type === 'tool' && b.status === 'running') b.status = 'failed';
      }
      sendEvent('error', errorMessage);
    } finally {
      unregisterActivityBus(streamRequestId);
      unregisterPlanBus(streamRequestId);

      // Finalize any trailing thinking block that never got resolved
      finalizeLastThinkingBlock();

	      if (activePlan && !streamFailed && (assistantText || contentBlocks.length > 0)) {
	        activePlan = completeExecutionPlan(activePlan, assistantText || undefined);
	        sendEvent('plan', activePlan);
	      }

	      if (workflowPolicy.forcePlanning && !sawPlanEvent) {
	        logger.warn('desktop.chat.workflow.plan_missing', {
	          threadId,
	          userId: session.userId,
	          companyId: session.companyId,
	          domains: workflowPolicy.domains,
	          messagePreview: message.slice(0, 200),
	        });
	      }

	      if (workflowPolicy.requireGroundedTooling && !sawToolActivity) {
	        logger.warn('desktop.chat.workflow.tooling_missing', {
	          threadId,
	          userId: session.userId,
	          companyId: session.companyId,
	          domains: workflowPolicy.domains,
	          messagePreview: message.slice(0, 200),
	        });
	      }

	      if (workflowPolicy.requireLarkDocTool && LARK_DOC_COMPLETION_CLAIM_PATTERN.test(assistantText) && !sawLarkDocActivity) {
	        logger.warn('desktop.chat.workflow.lark_doc_claim_without_tool', {
	          threadId,
	          userId: session.userId,
	          companyId: session.companyId,
	          messagePreview: message.slice(0, 200),
	          assistantPreview: assistantText.slice(0, 240),
	        });
	      }

	      if (!assistantText.trim() && sawToolActivity) {
	        const synthesisPrompt = buildGroundedSynthesisPrompt({
	          userMessage: message,
	          activePlan,
	          contentBlocks,
	        });

	        if (synthesisPrompt) {
	          try {
	            const synthesisAgent = mastra.getAgent('synthesisAgent');
	            const synthesisRunOptions = await buildMastraAgentRunOptions(
                'mastra.synthesis', 
                { requestContext },
                mode as 'fast' | 'high'
              );
	            const synthesisResult = await synthesisAgent.generate(synthesisPrompt, synthesisRunOptions as any);
	            const synthesizedText = typeof synthesisResult?.text === 'string' ? synthesisResult.text.trim() : '';
	            if (synthesizedText) {
	              assistantText = synthesizedText;
	              contentBlocks.push({ type: 'text', content: synthesizedText });
	              logger.warn('desktop.chat.stream.final_text_synthesized', {
	                threadId,
	                userId: session.userId,
	                companyId: session.companyId,
	                planId: activePlan?.id,
	              });
	            }
	          } catch (error) {
	            logger.warn('desktop.chat.stream.final_text_synthesis_failed', {
	              threadId,
	              userId: session.userId,
	              companyId: session.companyId,
	              planId: activePlan?.id,
	              error: error instanceof Error ? error.message : 'unknown_error',
	            });
	          }
	        }
	      }

	      if (!assistantText.trim()) {
	        const fallbackAssistantText = buildGroundedFallbackAssistantText({
	          contentBlocks,
	          activePlan,
	        });
	        if (fallbackAssistantText) {
	          assistantText = fallbackAssistantText;
	          contentBlocks.push({ type: 'text', content: fallbackAssistantText });
	          logger.warn('desktop.chat.stream.final_text_fallback_used', {
	            threadId,
	            userId: session.userId,
	            companyId: session.companyId,
	            planId: activePlan?.id,
	          });
	        }
	      }

	      if (assistantText || contentBlocks.length > 0) {
        const metadata: Record<string, unknown> = {
          // Save the full ordered timeline — this is what the UI reads on reload
          contentBlocks,
        };
        if (activePlan) metadata.plan = activePlan;
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

        // --- RECORD TOKEN USAGE (fire-and-forget) ---
        const estimatedInput = estimateTokens(message) + estimateTokens(historyContext);
        const estimatedOutput = estimateTokens(assistantText);
        const actualUsage = extractActualTokenUsage(
          (streamResult as any)?.usage as Record<string, unknown> | undefined,
        );
        aiTokenUsageService.record({
          userId: session.userId,
          companyId: session.companyId,
          agentTarget: agentTarget ?? 'mastra.supervisor',
          modelId: resolvedModel?.effectiveModelId ?? 'unknown',
          provider: resolvedModel?.effectiveProvider ?? 'unknown',
          channel: 'desktop',
          threadId,
          estimatedInputTokens: estimatedInput,
          estimatedOutputTokens: estimatedOutput,
          actualInputTokens: actualUsage.inputTokens || undefined,
          actualOutputTokens: actualUsage.outputTokens || undefined,
          wasCompacted,
          mode,
        }).catch(() => { /* already logged inside service */ });
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

    // --- AUTO-HYDRATE CHAT HISTORY ---
    let history = conversationMemoryStore.getContextMessages(conversationKey, 14);
    if (history.length <= 1) {
      try {
        const dbMessages = await desktopThreadsService.getThread(threadId, session.userId);
        if (dbMessages && dbMessages.messages.length > 0) {
          const recentDbMessages = dbMessages.messages.slice(-15);
          for (const msg of recentDbMessages) {
            if (msg.role === 'user') {
              conversationMemoryStore.addUserMessage(conversationKey, msg.id, msg.content);
            } else if (msg.role === 'assistant') {
              conversationMemoryStore.addAssistantMessage(conversationKey, msg.id, msg.content);
            }
          }
          history = conversationMemoryStore.getContextMessages(conversationKey, 14);
        }
      } catch (err) {
        logger.warn('desktop.history.hydrate.failed', { error: err });
      }
    }

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

    const requestContext = new RequestContext<Record<string, string>>();
    requestContext.set('companyId', session.companyId);
    requestContext.set('userId', session.userId);
    requestContext.set('chatId', threadId);
    requestContext.set('channel', 'desktop');
    requestContext.set('requesterEmail', session.email ?? '');
    requestContext.set('workspaceName', workspace.name);
    requestContext.set('workspacePath', workspace.path);
    const requestId = randomUUID();
    requestContext.set('requestId', requestId);

	    let activePlan = parsed.plan ?? null;
	    if (activePlan && actionResult) {
	      activePlan = updateExecutionPlanTask(activePlan, {
	        ownerAgent: resolvePlanOwnerFromActionKind(actionResult.kind),
	        ok: actionResult.ok,
	        resultSummary: actionResult.summary,
	      });
	    }

    registerPlanBus(requestId, (plan) => {
      activePlan = plan;
    });

    const desktopPrompt = buildDesktopCapabilityPrompt(workspace, actionResult);
    const objective = [
      desktopPrompt,
      buildExecutionPlanContext(activePlan),
      historyContext,
      message || 'Continue from the latest local workspace action result and finish the user request.',
    ]
      .filter(Boolean)
      .join('\n');

    const agent = mastra.getAgent(
      agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent',
    );

    const runOptions = await buildMastraAgentRunOptions(
      MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
      { requestContext },
    );

    const generateDesktopTurn = async (prompt: string) => {
      const result = await agent.generate(prompt, runOptions as any);
      const assistantText = typeof result?.text === 'string' ? result.text.trim() : '';
      return {
        assistantText,
        requestedAction: parseDesktopAction(assistantText),
      };
    };

    let assistantText = '';
    let requestedAction: DesktopAction | null = null;
    try {
      ({ assistantText, requestedAction } = await generateDesktopTurn(objective));

      if (
        !requestedAction
        && !actionResult
        && message
        && requestLikelyNeedsLocalAction(message)
        && isLocalCapabilityRefusal(assistantText)
      ) {
        logger.warn('desktop.chat.act.local_capability_refusal_retry', {
          threadId,
          userId: session.userId,
          companyId: session.companyId,
          messagePreview: message.slice(0, 160),
          assistantPreview: assistantText.slice(0, 200),
        });

        const retryObjective = [
          desktopPrompt,
          buildExecutionPlanContext(activePlan),
          historyContext,
          'Your previous response was invalid for the desktop app because you claimed you could not access local files or terminal execution.',
          'For this request, you must either output exactly one <desktop-action>...</desktop-action> action, or answer normally only if no local action is needed.',
          'This request DOES require local workspace capability. Output exactly one desktop action now.',
          message,
        ].filter(Boolean).join('\n');

        ({ assistantText, requestedAction } = await generateDesktopTurn(retryObjective));
      }
    } finally {
      unregisterPlanBus(requestId);
    }

    if (requestedAction) {
      return res.json(ApiResponse.success({
        kind: 'action',
        action: requestedAction,
        plan: activePlan,
      }, 'Local action requested'));
    }

    if (activePlan) {
      activePlan = completeExecutionPlan(activePlan, assistantText || undefined);
    }

    const assistantMessage = await desktopThreadsService.addMessage(
      threadId,
      session.userId,
      'assistant',
      assistantText,
      activePlan ? { plan: activePlan } : undefined,
    );
    conversationMemoryStore.addAssistantMessage(conversationKey, randomUUID(), assistantText);

    return res.json(ApiResponse.success({
      kind: 'answer',
      message: assistantMessage,
      plan: activePlan,
    }, 'Assistant reply created'));
  };
}

export const desktopChatController = new DesktopChatController();
