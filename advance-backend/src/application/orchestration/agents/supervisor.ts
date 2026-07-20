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

function mergeAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!a) return b!;
  if (!b) return a;
  const controller = new AbortController();
  const onAbort = () => controller.abort(a.aborted ? a.reason : b.reason);
  if (a.aborted || b.aborted) { onAbort(); return controller.signal; }
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
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
import type { AgentCatalogCache } from '../../agents/agent-catalog.cache';
import { toDescriptor } from '../../agents/agent-catalog.service';
import type { ApprovalGateService } from '../../approval/approval-gate.service';
import { buildSupervisorSystemPrompt } from './supervisor.prompt';
import type { RunStatusAggregator } from '../run-status.aggregator';
import { runLarkAgent } from '../agent-runners/lark.runner';
import { runGoogleAgent } from '../agent-runners/google.runner';
import { runZohoAgent } from '../agent-runners/zoho.runner';
import { runContextAgent } from '../agent-runners/context.runner';
import { createManageTodosTool } from '../tools/orchestration/manage-todos.tool';
import { createScheduleTaskTool } from '../tools/orchestration/schedule-task.tool';
import { createListScheduledTasksTool } from '../tools/orchestration/list-scheduled-tasks.tool';
import { createCancelScheduledTaskTool } from '../tools/orchestration/cancel-scheduled-task.tool';
import { createRunScheduledNowTool } from '../tools/orchestration/run-scheduled-now.tool';
import { createRememberFactTool } from '../tools/orchestration/remember-fact.tool';
import { buildCapabilitiesForAgent } from '../agent-runners/dynamic/agent-as-tool';
import { buildDynamicSupervisorGraph, type DynamicSupervisorGraph } from '../graphs/dynamic-supervisor.graph';
import type { Mem0Service } from '../../memory/mem0.service';
import { buildToolFinishedPayload, isErrorOutput } from '../agent-runners/tool-trace';
import { debugSupervisorEntry, debugGraphInvoke, debugGraphOutput } from '../../../shared/debug-run-log';
import type { GroupContextContentPart } from '../../../domain/conversation/group-context';
import { isInternalHistoryMarker } from '../../../domain/conversation/internal-history-marker';
import type { SkillCatalogService, CatalogSkill } from '../../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../../skills/skill-access.port';
import { WorkResolutionService } from '../../gateway/work-resolution.service';
import type { ToolExecutor } from '../../gateway/tool-executor';
import { buildBrainSystemPrompt } from '../brain-prompt';
import { createGovernedDiscoverSkillTool } from '../tools/orchestration/discover-governed-skill';
import { createCallToolTool } from '../tools/orchestration/call-tool';
import { createResolveGovernedWorkTool } from '../tools/orchestration/resolve-governed-work';
import type { AuditService } from '../../observability/audit.service';
import { SCHEDULE_DIVO_WORK_SKILL_SLUG } from '../../skills/scheduled-work-system-skill';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SUPERVISOR_STEPS = 200;
const DEFAULT_SUPERVISOR_TIMEOUT_MS = 300_000;

// ─── Public I/O ───────────────────────────────────────────────────────────────

export interface SupervisorInput {
  userMessage:    string;
  history:        ConversationWindow;
  channelType:    string;
  channelId:      string;
  perm:           PermissionResult;
  runContext:     RunContext;
  statusChannel:  StatusChannel;
  aggregator:     RunStatusAggregator;
  permittedTools: ReadonlyArray<AppTool<unknown, unknown>>;
  tracer?:        OrchestrationTracer;
  approvalGate?:  ApprovalGateService;
  memoryContext?: string;
  conversationSummary?: string;
  groupContext?:  string;
  groupContextParts?: readonly GroupContextContentPart[];
  groupContextSystemHeader?: string;
  /** P2P inline image URLs for multimodal embedding (Cloudinary or base64). */
  inlineImageUrls?: readonly string[];
  chatId?:        string;
  abortSignal?:   AbortSignal;
  /** Per-run model authority. Lark supplies a backend-governed pinned model here. */
  model?:          LanguageModel;
  resolveModel?:   SupervisorDeps['resolveModel'];
}

export interface SupervisorOutput {
  finalReply:  FinalReply;
  toolsCalled: string[];
  toolResults: Array<{ toolName: string; output: string }>;
}

interface DynamicGraphRunInput {
  readonly userMessage: string;
  readonly history: ConversationWindow;
  readonly perm: PermissionResult;
  readonly runContext: RunContext;
  readonly permittedTools: ReadonlyArray<AppTool<unknown, unknown>>;
  readonly approvalGate?: ApprovalGateService;
  readonly memoryContext?: string;
  readonly conversationSummary?: string;
  readonly groupContext?: string;
  readonly groupContextParts?: readonly GroupContextContentPart[];
  readonly groupContextSystemHeader?: string;
  readonly inlineImageUrls?: readonly string[];
  readonly mem0?: Mem0Service;
  readonly chatId?: string;
  readonly tracer?: OrchestrationTracer;
  readonly statusChannel?: StatusChannel;
  readonly aggregator?: RunStatusAggregator;
  readonly model?: LanguageModel;
  readonly resolveModel?: SupervisorDeps['resolveModel'];
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface SupervisorDeps {
  model:             LanguageModel;
  defaultModel?:     {
    provider: string;
    modelId:  string;
  };
  resolveModel?:     (input: {
    provider: string;
    modelId: string;
    companyId: string;
    agentSlug?: string;
  }) => Promise<LanguageModel> | LanguageModel;
  agentResolver:     AgentResolver;
  agentCatalogCache?: AgentCatalogCache;
  todoRepo:          SupervisorTodoRepository;
  prisma:            PrismaClient;
  logger:            Logger;
  clock:             Clock;
  geminiApiKey?: string;
  dynamicGraphEnabled?: boolean;
  dynamicSupervisorGraph?: DynamicSupervisorGraph;
  supervisorTimeoutMs?: number;
  mem0?: Mem0Service;
  unifiedAgentMode?: boolean;
  skillRegistry?: import('../../skills/skill-registry').SkillRegistry;
  toolRegistry?: import('../tools/tool-registry').ToolRegistry;
  /** DB-backed company skill catalogue used by governed server channels. */
  skillCatalog?: SkillCatalogService;
  /** Explicit company/user/department/role skill grant resolver. */
  skillAccessEnforcement?: SkillAccessEnforcementPort;
  /** Shared desktop/Lark resolver for persona rules and company skill recipes. */
  workResolution?: WorkResolutionService;
  /** Shared governed executor used by backend-hosted channel tool calls. */
  toolExecutor?: ToolExecutor;
  auditService?: Pick<AuditService, 'record'>;
}

// ─── Supervisor ───────────────────────────────────────────────────────────────

export class SupervisorAgent {
  constructor(private readonly deps: SupervisorDeps) {}

  getModel(): LanguageModel { return this.deps.model; }

  async run(input: SupervisorInput): Promise<Result<SupervisorOutput, OrchestrationError>> {
    const {
      userMessage, history, channelType, channelId,
      perm, runContext, statusChannel, aggregator, permittedTools, tracer,
      approvalGate, memoryContext, conversationSummary, groupContext, groupContextParts, groupContextSystemHeader, inlineImageUrls, chatId,
    } = input;
    const { agentResolver, todoRepo, prisma, logger, clock } = this.deps;
    const model = input.model ?? this.deps.model;
    const resolveModel = input.resolveModel ?? this.deps.resolveModel;
    const useGovernedLarkRuntime = channelType === 'lark'
      && !!this.deps.skillCatalog
      && !!this.deps.skillAccessEnforcement
      && !!this.deps.toolRegistry;

    const log = logger.child({ service: 'supervisor', userId: runContext.userId });

    debugSupervisorEntry({
      path: (this.deps.dynamicGraphEnabled && this.deps.agentCatalogCache) ? 'dynamic_graph' : 'legacy',
      dynamicGraphEnabled: !!this.deps.dynamicGraphEnabled,
      hasAgentCatalogCache: !!this.deps.agentCatalogCache,
      hasMem0: !!this.deps.mem0,
      hasApprovalGate: !!approvalGate,
      hasMemoryContext: !!memoryContext,
      hasGroupContext: !!groupContext,
      historyTurnCount: history.turns.length,
      permittedToolCount: permittedTools.length,
    });

    if (!useGovernedLarkRuntime && this.deps.dynamicGraphEnabled && this.deps.agentCatalogCache) {
      const graphResult = await this.runDynamicGraph({
        userMessage,
        history,
        perm,
        runContext,
        permittedTools,
        chatId: chatId ?? String(channelId),
        ...(approvalGate ? { approvalGate } : {}),
        ...(memoryContext ? { memoryContext } : {}),
        ...(groupContext ? { groupContext } : {}),
        ...(groupContextParts ? { groupContextParts } : {}),
        ...(groupContextSystemHeader ? { groupContextSystemHeader } : {}),
        ...(inlineImageUrls?.length ? { inlineImageUrls } : {}),
        ...(this.deps.mem0 ? { mem0: this.deps.mem0 } : {}),
        ...(tracer ? { tracer } : {}),
        statusChannel,
        aggregator,
        ...(input.model ? { model: input.model } : {}),
        ...(input.resolveModel ? { resolveModel: input.resolveModel } : {}),
      });

      if (graphResult.ok) {
        tracer?.emit({
          phase: 'synthesis', eventType: 'synthesis_complete',
          actorType: 'synthesis', title: 'Response synthesized',
          status: 'success',
          payload: {
            replyLength: graphResult.value.finalText.length,
            replyPreview: graphResult.value.finalText.slice(0, 500),
          },
        });

        return ok({
          finalReply: {
            kind: 'final',
            text: graphResult.value.finalText,
            format: 'markdown',
          },
          toolsCalled: graphResult.value.toolsCalled,
          toolResults: graphResult.value.toolResults,
        });
      }

      log.warn('supervisor.dynamic_graph.failed_falling_back', {
        error: graphResult.error.message,
      });
    }

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

    let visibleSkills: CatalogSkill[] = [];
    let grantedSkillIds: ReadonlySet<string> = new Set();
    const governedPermittedTools = permittedTools.filter((tool) => String(tool.id) !== 'runCommand');
    const governedPermittedToolIds = new Set(governedPermittedTools.map((tool) => String(tool.id)));
    if (useGovernedLarkRuntime) {
      try {
        grantedSkillIds = await this.deps.skillAccessEnforcement!.listGrantedSkillIds(
          String(runContext.companyId),
          String(runContext.userId),
        );
        const grantedSkills = await this.deps.skillCatalog!.listVisible({
          companyId: String(runContext.companyId),
          ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
          permission: perm,
          grantedSkillIds,
          limit: 100,
        });
        // A skill grant permits reading the recipe; PermissionService still
        // governs execution. The server agent receives only skills that have
        // at least one executable tool in this request.
        visibleSkills = grantedSkills.filter((skill) =>
          skill.toolIds.some((toolId) => governedPermittedToolIds.has(toolId)),
        );
      } catch (error) {
        // Discovery is fail-closed. Tool execution remains protected by the
        // independently resolved PermissionResult even when this lookup fails.
        log.error('supervisor.governed_skill_discovery.failed', { error: String(error) });
        grantedSkillIds = new Set();
        visibleSkills = [];
      }
    }

    const governedSkillCatalog = visibleSkills.length > 0
      ? visibleSkills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
      : '- No skills are currently approved for this member.';
    const systemPrompt = useGovernedLarkRuntime
      ? buildBrainSystemPrompt({
        skillCatalog: governedSkillCatalog,
        currentDateTime: new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata',
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(clock.now()),
      })
      : buildSupervisorSystemPrompt(
        agentDef?.systemPrompt,
        perm.department?.systemPrompt,
      );
    let fullSystemPrompt = systemPrompt;
    if (useGovernedLarkRuntime && (agentDef?.systemPrompt || perm.department?.systemPrompt)) {
      fullSystemPrompt += [
        agentDef?.systemPrompt ? `\n\nAGENT CONTEXT:\n${agentDef.systemPrompt}` : '',
        perm.department?.systemPrompt ? `\n\nDEPARTMENT CONTEXT:\n${perm.department.systemPrompt}` : '',
      ].join('');
    }
    if (memoryContext) {
      fullSystemPrompt += `\n\nMEMORY CONTEXT - facts learned from past conversations. Use when relevant, but do not repeat verbatim to the user:\n${memoryContext}`;
    }
    if (groupContext) {
      fullSystemPrompt += `\n\n${groupContext}`;
    }

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
      ...(resolveModel ? { resolveModel } : {}),
      allTools: permittedTools,
      perm,
      runContext,
      logger,
      clock,
      ...(tracer ? { tracer } : {}),
      ...(approvalGate    ? { approvalGate }    : {}),
      ...(geminiApiKey    ? { geminiApiKey }    : {}),
      ...(groupContext    ? { groupContext }    : {}),
      chatId: chatId ?? String(channelId),
    };

    // ── 4. Wire supervisor tools ──────────────────────────────────────────────
    // Each tool() call uses an explicit Zod schema declared inline. We cast the
    // assembled record to `ToolSet` to short-circuit deep type inference in
    // streamText (otherwise TS OOMs on AI SDK v6's distributive ToolSet types).
    const taskSchema = z.object({ task: z.string() });

    const legacyAgentTools = {
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
        description: 'Execute governed Google Workspace operations across Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, and Apps Script.',
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
    } as unknown as ToolSet;

    const schedulingSkillResolution = { loaded: false };
    const orchestrationTools = {
      manageTodos: createManageTodosTool(todoRepo, runContext),
      scheduleTask: createScheduleTaskTool(prisma, runContext, {
        ...(useGovernedLarkRuntime
          ? { isSchedulingSkillResolved: () => schedulingSkillResolution.loaded }
          : {}),
      }),
      listScheduledTasks: createListScheduledTasksTool(prisma, runContext),
      cancelScheduledTask: createCancelScheduledTaskTool(prisma, runContext),
      runScheduledTaskNow: createRunScheduledNowTool(prisma, runContext),
      ...(this.deps.mem0 ? { rememberFact: createRememberFactTool(this.deps.mem0, runContext) } : {}),
    } as unknown as ToolSet;

    const allowedToolIds = governedPermittedToolIds;
    const workResolver = useGovernedLarkRuntime
      ? this.deps.workResolution ?? new WorkResolutionService({
        skillCatalog: this.deps.skillCatalog!,
        ...(this.deps.skillAccessEnforcement
          ? { skillAccessEnforcement: this.deps.skillAccessEnforcement }
          : {}),
      })
      : undefined;
    const governedSkillTools = useGovernedLarkRuntime
      ? {
        resolve_work: createResolveGovernedWorkTool({
          resolver: workResolver!,
          companyId: String(runContext.companyId),
          userId: String(runContext.userId),
          ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
          permission: perm,
          onResolution: (event) => {
            const selectedSkills = event.resolution
              ? [
                ...event.resolution.persona.linkedSkills.map(item => item.skill),
                ...event.resolution.additionalSkills.map(item => item.skill),
              ]
              : [];
            schedulingSkillResolution.loaded = selectedSkills.some(
              skill => skill.slug === SCHEDULE_DIVO_WORK_SKILL_SLUG,
            );
            if (this.deps.auditService) {
              void this.deps.auditService.record({
                actorId: String(runContext.userId),
                companyId: String(runContext.companyId),
                action: 'lark.work.resolve',
                outcome: event.outcome,
                metadata: {
                  departmentId: runContext.departmentId ? String(runContext.departmentId) : null,
                  queryCount: event.resolution?.queries.length ?? 0,
                  personaRuleCount: event.resolution?.persona.rules.length ?? 0,
                  personaSkillIds: event.resolution?.persona.linkedSkills.map((item) => item.skill.id) ?? [],
                  searchedSkillIds: event.resolution?.additionalSkills.map((item) => item.skill.id) ?? [],
                  rejectedSkillIds: event.resolution?.rejectedSkills.map((item) => item.id) ?? [],
                  registryRevision: event.resolution?.registryRevision ?? null,
                },
              });
            }
          },
        }),
        discover_skill: createGovernedDiscoverSkillTool({
          skillCatalog: this.deps.skillCatalog!,
          companyId: String(runContext.companyId),
          ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
          permission: perm,
          grantedSkillIds,
          visibleSkills,
          permittedTools: governedPermittedTools,
          ...(this.deps.auditService ? {
            onDiscovery: (event) => this.deps.auditService!.record({
              actorId: String(runContext.userId),
              companyId: String(runContext.companyId),
              action: 'lark.skill.discovery',
              outcome: event.outcome,
              metadata: {
                query: event.query,
                skillId: event.skillId ?? null,
                departmentId: runContext.departmentId ? String(runContext.departmentId) : null,
              },
            }),
          } : {}),
        }),
        call_tool: createCallToolTool(this.deps.toolRegistry!, {
          runContext,
          perm,
          logger,
          clock,
          ...(approvalGate ? { approvalGate } : {}),
          chatId: chatId ?? String(channelId),
        }, allowedToolIds, this.deps.auditService ? (event) => this.deps.auditService!.record({
          actorId: String(runContext.userId),
          companyId: String(runContext.companyId),
          action: 'lark.tool.execution',
          outcome: event.outcome,
          metadata: {
            toolId: event.toolId,
            actionGroup: event.action ?? null,
            status: event.status,
            departmentId: runContext.departmentId ? String(runContext.departmentId) : null,
          },
        }) : undefined, this.deps.toolExecutor),
      } as unknown as ToolSet
      : {} as ToolSet;

    let dynamicCapabilities = {} as ToolSet;
    if (agentDef && this.deps.agentCatalogCache) {
      const allAgents = await this.deps.agentCatalogCache.getForCompany(String(runContext.companyId));
      log.info('supervisor.catalog.loaded', { agentCount: allAgents.length, slugs: allAgents.map(a => a.slug) });
      const rootAgent = allAgents.find(agent => agent.id === agentDef.id) ?? toDescriptor(agentDef);
      dynamicCapabilities = buildCapabilitiesForAgent(rootAgent, allAgents, agentCtx);
      log.info('supervisor.capabilities.built', { dynamicToolNames: Object.keys(dynamicCapabilities) });
    }

    const hasDynamicCapabilities = Object.keys(dynamicCapabilities).length > 0;
    const supervisorTools = {
      ...(useGovernedLarkRuntime
        ? governedSkillTools
        : hasDynamicCapabilities ? dynamicCapabilities : legacyAgentTools),
      ...orchestrationTools,
    } as unknown as ToolSet;
    log.info('supervisor.tools.resolved', {
      mode: useGovernedLarkRuntime ? 'governed_db_skills' : hasDynamicCapabilities ? 'dynamic' : 'legacy',
      toolNames: Object.keys(supervisorTools),
      totalTools: Object.keys(supervisorTools).length,
      visibleSkillCount: useGovernedLarkRuntime ? visibleSkills.length : undefined,
    });

    // ── 5. Stream the supervisor LLM ──────────────────────────────────────────
    let currentStatusHandle = null as Awaited<ReturnType<StatusChannel['sendStatus']>>;
    let toolsCalled: string[] = [];
    let toolResults: Array<{ toolName: string; output: string }> = [];
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
          const timeoutMs = this.deps.supervisorTimeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS;
          const result = streamText({
            model,
            system:  fullSystemPrompt,
            messages,
            tools:   supervisorTools,
            stopWhen: [stepCountIs(MAX_SUPERVISOR_STEPS)],
            temperature: 0,
            ...(timeoutMs > 0 || input.abortSignal ? { abortSignal: mergeAbortSignals(timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined, input.abortSignal) } : {}),
          });

          const innerCalled: string[] = [];
          const toolResults: Array<{ toolName: string; output: string }> = [];
          const toolTimers = new Map<string, number>();
          let innerText = '';
          let stepCount = 0;
          let chunkCount = 0;

          for await (const chunk of result.fullStream) {
            chunkCount++;

            if ((chunk as { type: string }).type === 'step-start') {
              stepCount++;
              log.info('supervisor.stream.step_start', { step: stepCount, chunksSoFar: chunkCount });
            }

            if ((chunk as { type: string }).type === 'step-finish') {
              log.info('supervisor.stream.step_finish', {
                step: stepCount,
                finishReason: (chunk as { finishReason?: string }).finishReason ?? 'unknown',
                textSoFar: innerText.length,
                toolsSoFar: innerCalled.length,
              });
            }

            if (chunk.type === 'tool-call') {
              aggregator.recordCall(chunk.toolName);
              toolTimers.set(chunk.toolName, Date.now());
              currentStatusHandle = await statusChannel.editStatus(currentStatusHandle, {
                kind: 'status', terminal: false, timeline: aggregator.snapshot(),
              });
              innerCalled.push(chunk.toolName);
              log.info('supervisor.stream.tool_call', {
                toolName: chunk.toolName,
                argsPreview: JSON.stringify(chunk.input).substring(0, 300),
                step: stepCount,
              });

              tracer?.emit({
                phase: 'execute', eventType: 'tool_call_started',
                actorType: 'supervisor', actorKey: chunk.toolName,
                title: `Calling ${chunk.toolName}`,
                status: 'info',
                payload: { toolName: chunk.toolName, args: chunk.input },
              });
            }

            if (chunk.type === 'tool-result') {
              const output = String(chunk.output);
              const isError = isErrorOutput(output);
              const startMs = toolTimers.get(chunk.toolName);
              toolResults.push({ toolName: chunk.toolName, output });
              if (isError) {
                aggregator.recordFailure(chunk.toolName, output);
              } else {
                aggregator.recordResult(chunk.toolName, output);
              }
              currentStatusHandle = await statusChannel.editStatus(currentStatusHandle, {
                kind: 'status', terminal: false, timeline: aggregator.snapshot(),
              });
              log.info('supervisor.stream.tool_result', {
                toolName: chunk.toolName,
                resultLength: output.length,
                resultPreview: output.substring(0, 500),
                step: stepCount,
              });

              tracer?.emit({
                phase: 'execute', eventType: 'tool_call_finished',
                actorType: 'supervisor', actorKey: chunk.toolName,
                title: `${chunk.toolName} ${isError ? 'failed' : 'completed'}`,
                status: isError ? 'error' : 'success',
                payload: buildToolFinishedPayload(chunk.toolName, output, startMs),
              });
            }

            if (chunk.type === 'text-delta') {
              innerText += chunk.text;
              if (aggregator.appendTextDelta(chunk.text)) {
                currentStatusHandle = await statusChannel.editStatus(currentStatusHandle, {
                  kind: 'status', terminal: false, timeline: aggregator.snapshot(),
                });
              }
            }

            if (chunk.type === 'error') {
              const errorMsg = String(chunk.error);
              log.error('supervisor.stream.error', {
                error: errorMsg,
                step: stepCount,
                toolsSoFar: innerCalled,
                textSoFar: innerText.length,
              });
              const lastTool = innerCalled[innerCalled.length - 1];
              if (lastTool) aggregator.recordFailure(lastTool, errorMsg);
              throw chunk.error instanceof Error ? chunk.error : new Error(errorMsg);
            }
          }

          log.info('supervisor.stream.finished', {
            totalSteps: stepCount,
            totalChunks: chunkCount,
            totalToolCalls: innerCalled.length,
            finalTextLength: innerText.length,
            toolsCalled: innerCalled,
            hasText: innerText.trim().length > 0,
          });

          return { finalText: innerText, toolsCalled: innerCalled, toolResults };
        },
        log,
      );

      finalText  = outcome.finalText;
      toolsCalled = outcome.toolsCalled;
      toolResults = outcome.toolResults;

      // If model produced no text but made tool calls, build a summary from
      // agent results so the user sees something useful instead of "Done."
      if (!finalText.trim() && outcome.toolResults.length > 0) {
        const agentResults = outcome.toolResults
          .filter(r => r.toolName.startsWith('agent_'))
          .map(r => r.output)
          .filter(o => o && !o.startsWith('error:'));

        if (agentResults.length > 0) {
          finalText = agentResults.join('\n\n');
          log.info('supervisor.fallback_from_agent_results', {
            agentResultCount: agentResults.length,
            assembledLength: finalText.length,
          });
        }
      }
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
          toolResults: [],
        });
      }
      if (e instanceof Error && e.name === 'AbortError') {
        log.error('supervisor.stream.timeout', {
          timeoutMs: this.deps.supervisorTimeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS,
          toolsCalled,
          msg: 'Supervisor streamText aborted due to timeout',
        });
        return ok({
          finalReply: {
            kind:   'final',
            text:   "The request took too long to complete. Some actions may have been partially executed. Please check and try again.",
            format: 'markdown',
          },
          toolsCalled,
          toolResults: [],
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
    if (isInternalHistoryMarker(finalText)) {
      log.error('supervisor.internal_history_marker_rejected', { reply: finalText });
      return err(new OrchestrationError({
        stage: 'synthesize',
        reason: 'llm_invalid_output',
        message: 'Supervisor returned internal conversation metadata instead of a user response.',
      }));
    }

    if (!finalText.trim()) {
      log.warn('supervisor.empty_reply', {
        toolsCalled,
        toolCount: toolsCalled.length,
        msg: 'Supervisor LLM produced no text after tool calls — falling back to "Done."',
      });
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
      phase: 'synthesis', eventType: 'synthesis_complete',
      actorType: 'synthesis', title: 'Response synthesized',
      status: 'success',
      payload: {
        replyLength: finalText.length,
        replyPreview: finalText.slice(0, 500),
      },
    });

    tracer?.emit({
      phase: 'complete', eventType: 'supervisor_complete',
      actorType: 'supervisor', title: 'Supervisor complete',
      status: 'success',
      payload: {
        toolsCalled,
        replyLength: finalText.length,
        replyPreview: finalText.slice(0, 500),
        supervisorTextEmpty: finalText === 'Done.',
      },
    });

    return ok({ finalReply, toolsCalled, toolResults });
  }

  private async runDynamicGraph(input: DynamicGraphRunInput): Promise<Result<{ finalText: string; toolsCalled: string[]; toolResults: Array<{ toolName: string; output: string }> }, OrchestrationError>> {
    if (!this.deps.agentCatalogCache) {
      return err(new OrchestrationError({
        stage: 'plan',
        reason: 'llm_invalid_output',
        message: 'Dynamic graph requested without an agent catalog cache.',
      }));
    }

    const graph = (!input.model && !input.resolveModel ? this.deps.dynamicSupervisorGraph : undefined) ?? buildDynamicSupervisorGraph({
      model: input.model ?? this.deps.model,
      ...(this.deps.defaultModel ? { defaultModel: this.deps.defaultModel } : {}),
      ...((input.resolveModel ?? this.deps.resolveModel) ? { resolveModel: (input.resolveModel ?? this.deps.resolveModel)! } : {}),
      agentCatalogCache: this.deps.agentCatalogCache,
      todoRepo: this.deps.todoRepo,
      prisma: this.deps.prisma,
      logger: this.deps.logger.child({ service: 'dynamic-supervisor-graph' }),
      clock: this.deps.clock,
      ...(this.deps.geminiApiKey ? { geminiApiKey: this.deps.geminiApiKey } : {}),
      ...(input.mem0 ? { mem0: input.mem0 } : {}),
      ...(input.tracer ? { tracer: input.tracer } : {}),
      ...(input.statusChannel ? { statusChannel: input.statusChannel } : {}),
      ...(input.aggregator ? { aggregator: input.aggregator } : {}),
      ...(this.deps.unifiedAgentMode ? { unifiedAgentMode: true } : {}),
      ...(this.deps.skillRegistry ? { skillRegistry: this.deps.skillRegistry } : {}),
      ...(this.deps.toolRegistry ? { toolRegistry: this.deps.toolRegistry } : {}),
    });

    const memoryContext = input.memoryContext ?? '';
    const groupContext = input.groupContext ?? '';

    input.tracer?.emit({
      phase: 'plan', eventType: 'supervisor_started',
      actorType: 'supervisor', title: 'Dynamic supervisor graph started',
      status: 'info',
      payload: { toolCount: input.permittedTools.length },
    });

    const graphConversationHistory = input.history.turns
      .filter(turn => turn.role === 'user' || turn.role === 'assistant')
      .map(turn => ({
        role: turn.role as 'user' | 'assistant',
        content: turn.content,
      }));

    debugGraphInvoke({
      userMessage: input.userMessage,
      conversationHistory: graphConversationHistory,
      companyId: String(input.runContext.companyId),
      memoryContext,
      groupContext,
      chatId: input.chatId ?? null,
      permittedToolCount: input.permittedTools.length,
    });

    const output = await graph.invoke({
      userMessage: input.userMessage,
      conversationHistory: graphConversationHistory,
      companyId: String(input.runContext.companyId),
      perm: input.perm,
      runContext: input.runContext,
      permittedTools: input.permittedTools,
      chatId: input.chatId ?? null,
      memoryContext,
      ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
      ...(input.groupContext ? { groupContext: input.groupContext } : {}),
      ...(input.groupContextParts?.length ? { groupContextParts: input.groupContextParts } : {}),
      ...(input.inlineImageUrls?.length ? { inlineImageUrls: input.inlineImageUrls } : {}),
      ...(input.approvalGate ? { approvalGate: input.approvalGate } : {}),
    } as any);

    debugGraphOutput({
      status: output.status,
      supervisorResult: output.supervisorResult,
      toolCallsMade: output.toolCallsMade ?? [],
      error: output.error,
    });

    if (output.status === 'error') {
      input.tracer?.emit({
        phase: 'error', eventType: 'run_failed',
        actorType: 'supervisor', title: 'Dynamic supervisor graph failed',
        status: 'error',
        payload: { stage: 'plan', reason: output.error ?? 'unknown' },
      });
      return err(new OrchestrationError({
        stage: 'plan',
        reason: 'llm_invalid_output',
        message: output.error ?? output.supervisorResult ?? 'Dynamic supervisor graph failed.',
      }));
    }

    const finalText = (output.supervisorResult ?? 'Done.').trim() || 'Done.';
    if (isInternalHistoryMarker(finalText)) {
      input.tracer?.emit({
        phase: 'error', eventType: 'run_failed', actorType: 'supervisor',
        title: 'Internal history marker rejected', status: 'error',
        payload: { stage: 'synthesis', reason: 'internal_history_marker' },
      });
      return err(new OrchestrationError({
        stage: 'synthesize',
        reason: 'llm_invalid_output',
        message: 'Supervisor returned internal conversation metadata instead of a user response.',
      }));
    }
    input.tracer?.emit({
      phase: 'complete', eventType: 'supervisor_complete',
      actorType: 'supervisor', title: 'Dynamic supervisor graph complete',
      status: 'success',
      payload: {
        toolsCalled: output.toolCallsMade,
        replyLength: finalText.length,
        replyPreview: finalText.slice(0, 500),
        supervisorTextEmpty: finalText === 'Done.',
      },
    });

    return ok({
      finalText,
      toolsCalled: output.toolCallsMade,
      toolResults: output.toolResults ?? [],
    });
  }
}
