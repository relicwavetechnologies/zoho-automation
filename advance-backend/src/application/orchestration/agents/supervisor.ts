/**
 * SupervisorAgent — the single orchestration brain.
 *
 * Uses Vercel AI SDK streamText with:
 *   - 4 agent dispatcher tools (larkAgent, googleAgent, zohoAgent, contextAgent)
 *   - 5 orchestration tools (manageTodos, scheduleTask, list/cancel/run)
 *
 * The supervisor's own LLM response IS the final reply — no separate synthesis step.
 * Domain agents (runners) each call their own LLM with filtered real tools.
 *
 * Status card is edited at tool-call boundaries (not token-by-token).
 * Final accumulated text replaces the status card via sendFinalReply.
 */

import { streamText, stepCountIs, dynamicTool } from 'ai';
import { z } from 'zod';
import type { LanguageModel, ToolSet } from 'ai';
import {
  runWithCircuitBreaker,
  CircuitBreakerOpenError,
  GEMINI_CIRCUIT_OPTIONS,
} from '../../../shared/circuit-breaker';
import type { Result } from '../../../shared/result';
import { ok, err } from '../../../shared/result';
import { OrchestrationError } from '../../../shared/errors';
import type { Logger } from '../../../shared/logger';
import type { Clock } from '../../../shared/clock';
import type { FinalReply } from '../../../domain/channel/outbound';
import type { PermissionResult } from '../../permissions/permission.types';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ConversationWindow } from '../../../domain/conversation/turn';
import type { Tool as AppTool } from '../tools/tool.contract';
import type { StatusChannel } from '../engine/status-channel';
import type { OrchestrationTracer } from '../../observability/orchestration-tracer';
import type { SupervisorTodoRepository } from '../../../infrastructure/persistence/supervisor-todo.repository';
import type { PrismaClient } from '../../../generated/prisma';
import type { AgentDefinitionView } from '../../../infrastructure/persistence/agent-definition.repository';
import type { AgentResolver } from './agent-resolver';
import type { ApprovalGateService } from '../../approval/approval-gate.service';
import { buildSupervisorSystemPrompt } from './supervisor.prompt';
import { getLabelForTool } from './status-labels';
import { runLarkAgent } from '../agent-runners/lark.runner';
import { runGoogleAgent } from '../agent-runners/google.runner';
import { runZohoAgent } from '../agent-runners/zoho.runner';
import { runContextAgent } from '../agent-runners/context.runner';
import { createManageTodosTool } from '../tools/orchestration/manage-todos.tool';
import { createScheduleTaskTool } from '../tools/orchestration/schedule-task.tool';
import { createListScheduledTasksTool } from '../tools/orchestration/list-scheduled-tasks.tool';
import { createCancelScheduledTaskTool } from '../tools/orchestration/cancel-scheduled-task.tool';
import { createRunScheduledNowTool } from '../tools/orchestration/run-scheduled-now.tool';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SUPERVISOR_STEPS = 20;
const SUPERVISOR_TIMEOUT_MS = 90_000;

// ─── Public I/O ───────────────────────────────────────────────────────────────

export interface SupervisorInput {
  userMessage:    string;
  history:        ConversationWindow;
  channelType:    string;
  channelId:      string;
  perm:           PermissionResult;
  runContext:     RunContext;
  statusChannel:  StatusChannel;
  permittedTools: ReadonlyArray<AppTool<unknown, unknown>>;
  tracer?:        OrchestrationTracer;
  approvalGate?:  ApprovalGateService;
  chatId?:        string;
}

export interface SupervisorOutput {
  finalReply:  FinalReply;
  toolsCalled: string[];
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface SupervisorDeps {
  model:         LanguageModel;
  agentResolver: AgentResolver;
  todoRepo:      SupervisorTodoRepository;
  prisma:        PrismaClient;
  logger:        Logger;
  clock:         Clock;
  geminiApiKey?: string;
}

// ─── Supervisor ───────────────────────────────────────────────────────────────

export class SupervisorAgent {
  constructor(private readonly deps: SupervisorDeps) {}

  async run(input: SupervisorInput): Promise<Result<SupervisorOutput, OrchestrationError>> {
    const {
      userMessage, history, channelType, channelId,
      perm, runContext, statusChannel, permittedTools, tracer,
      approvalGate, chatId,
    } = input;
    const { model, agentResolver, todoRepo, prisma, logger, clock } = this.deps;

    const log = logger.child({ service: 'supervisor', userId: runContext.userId });

    // ── 1. Resolve optional AgentDefinition for custom system prompt ──────────
    let agentDef: AgentDefinitionView | null = null;
    try {
      agentDef = await agentResolver.resolve(
        String(runContext.companyId),
        channelType,
        channelId,
      );
    } catch (e) {
      log.warn('supervisor.agent_resolver.failed', { error: String(e) });
    }

    const systemPrompt = buildSupervisorSystemPrompt(
      agentDef?.systemPrompt,
      perm.department?.systemPrompt,
    );

    // ── 2. Build conversation messages ────────────────────────────────────────
    const messages = [
      ...history.turns.map(t => ({
        role:    t.role as 'user' | 'assistant',
        content: t.content,
      })),
      { role: 'user' as const, content: userMessage },
    ];

    // ── 3. Build agent runner context (shared across all dispatchers) ─────────
    const { geminiApiKey } = this.deps;
    const agentCtx = {
      model,
      allTools: permittedTools,
      perm,
      runContext,
      logger,
      clock,
      ...(approvalGate    ? { approvalGate }    : {}),
      ...(geminiApiKey    ? { geminiApiKey }    : {}),
      chatId: chatId ?? String(channelId),
    };

    // ── 4. Wire supervisor tools ──────────────────────────────────────────────
    // Each tool() call uses an explicit Zod schema declared inline. We cast the
    // assembled record to `ToolSet` to short-circuit deep type inference in
    // streamText (otherwise TS OOMs on AI SDK v6's distributive ToolSet types).
    const taskSchema = z.object({ task: z.string() });

    const supervisorTools = {
      larkAgent: dynamicTool({
        description: 'Execute Lark workspace operations: tasks, calendar events, messages, docs, Lark Base tables, approvals.',
        inputSchema: taskSchema as never,
        execute: async (input: unknown): Promise<string> => {
          const { task } = input as { task: string };
          log.info('supervisor.dispatch.lark', { task: task.slice(0, 100) });
          return runLarkAgent({ task }, agentCtx);
        },
      }),

      googleAgent: dynamicTool({
        description: 'Execute Google Workspace operations: Gmail, Google Drive, Google Calendar.',
        inputSchema: taskSchema as never,
        execute: async (input: unknown): Promise<string> => {
          const { task } = input as { task: string };
          log.info('supervisor.dispatch.google', { task: task.slice(0, 100) });
          return runGoogleAgent({ task }, agentCtx);
        },
      }),

      zohoAgent: dynamicTool({
        description: 'Execute Zoho operations. Prefix task with "CRM:" for contacts/leads/deals or "BOOKS:" for invoices/bills/payments.',
        inputSchema: taskSchema as never,
        execute: async (input: unknown): Promise<string> => {
          const { task } = input as { task: string };
          log.info('supervisor.dispatch.zoho', { task: task.slice(0, 100) });
          return runZohoAgent({ task }, agentCtx);
        },
      }),

      contextAgent: dynamicTool({
        description: 'Search internal knowledge (past conversations, files, Lark contacts) or live web facts.',
        inputSchema: taskSchema as never,
        execute: async (input: unknown): Promise<string> => {
          const { task } = input as { task: string };
          log.info('supervisor.dispatch.context', { task: task.slice(0, 100) });
          return runContextAgent({ task }, agentCtx);
        },
      }),

      manageTodos: createManageTodosTool(todoRepo, runContext),
      scheduleTask: createScheduleTaskTool(prisma, runContext),
      listScheduledTasks: createListScheduledTasksTool(prisma, runContext),
      cancelScheduledTask: createCancelScheduledTaskTool(prisma, runContext),
      runScheduledTaskNow: createRunScheduledNowTool(prisma, runContext),
    } as unknown as ToolSet;

    // ── 5. Stream the supervisor LLM ──────────────────────────────────────────
    let currentStatusHandle = null as Awaited<ReturnType<StatusChannel['sendStatus']>>;
    let toolsCalled: string[] = [];
    let finalText = '';

    tracer?.emit({
      phase: 'plan', eventType: 'supervisor_started',
      actorType: 'supervisor', title: 'Supervisor LLM started',
      status: 'info', payload: { toolCount: Object.keys(supervisorTools).length },
    });

    try {
      const outcome = await runWithCircuitBreaker(
        'gemini',
        'supervisor',
        GEMINI_CIRCUIT_OPTIONS,
        async () => {
          const result = streamText({
            model,
            system:  systemPrompt,
            messages,
            tools:   supervisorTools,
            stopWhen: [stepCountIs(MAX_SUPERVISOR_STEPS)],
            temperature: 0,
            abortSignal: AbortSignal.timeout(SUPERVISOR_TIMEOUT_MS),
          });

          const innerCalled: string[] = [];
          let innerText = '';

          for await (const chunk of result.fullStream) {
            if (chunk.type === 'tool-call') {
              const label = getLabelForTool(chunk.toolName);
              currentStatusHandle = await statusChannel.editStatus(currentStatusHandle, label);
              innerCalled.push(chunk.toolName);

              tracer?.emit({
                phase: 'execute', eventType: 'tool_call_started',
                actorType: 'supervisor', actorKey: chunk.toolName,
                title: `Calling ${chunk.toolName}`,
                status: 'info',
                payload: { toolName: chunk.toolName, args: chunk.input },
              });
            }

            if (chunk.type === 'tool-result') {
              tracer?.emit({
                phase: 'execute', eventType: 'tool_call_finished',
                actorType: 'supervisor', actorKey: chunk.toolName,
                title: `${chunk.toolName} completed`,
                status: 'success',
                payload: { toolName: chunk.toolName, resultLength: String(chunk.output).length },
              });
            }

            if (chunk.type === 'text-delta') {
              innerText += chunk.text;
            }

            if (chunk.type === 'error') {
              log.error('supervisor.stream.error', { error: String(chunk.error) });
            }
          }

          return { finalText: innerText, toolsCalled: innerCalled };
        },
        log,
      );

      finalText  = outcome.finalText;
      toolsCalled = outcome.toolsCalled;
    } catch (e) {
      if (e instanceof CircuitBreakerOpenError) {
        log.warn('supervisor.circuit_open', { provider: e.provider, retryAt: e.retryAt });
        return ok({
          finalReply: {
            kind:   'final',
            text:   "I'm temporarily unavailable due to high demand. Please try again in a moment.",
            format: 'markdown',
          },
          toolsCalled: [],
        });
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.error('supervisor.stream.failed', { error: msg });
      return err(new OrchestrationError({
        stage:   'plan',
        reason:  'llm_invalid_output',
        message: `Supervisor LLM failed: ${msg}`,
        cause:   e,
      }));
    }

    // ── 6. Ensure we have some reply text ─────────────────────────────────────
    if (!finalText.trim()) {
      finalText = 'Done.';
    }

    const finalReply: FinalReply = {
      kind:   'final',
      text:   finalText.trim(),
      format: 'markdown',
    };

    log.info('supervisor.complete', {
      toolsCalled,
      replyLength: finalText.length,
    });

    tracer?.emit({
      phase: 'complete', eventType: 'supervisor_complete',
      actorType: 'supervisor', title: 'Supervisor complete',
      status: 'success',
      payload: { toolsCalled, replyLength: finalText.length },
    });

    return ok({ finalReply, toolsCalled });
  }
}
