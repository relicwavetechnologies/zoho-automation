import { streamText, stepCountIs } from 'ai';
import type { LanguageModel, ToolSet } from 'ai';
import type { PrismaClient } from '../../../../generated/prisma';
import type { Logger } from '../../../../shared/logger';
import type { Clock } from '../../../../shared/clock';
import type { AgentCatalogCache } from '../../../agents/agent-catalog.cache';
import type { SupervisorTodoRepository } from '../../../../infrastructure/persistence/supervisor-todo.repository';
import type { ApprovalGateService } from '../../../approval/approval-gate.service';
import { buildCapabilitiesForAgent } from '../../agent-runners/dynamic/agent-as-tool';
import { createManageTodosTool } from '../../tools/orchestration/manage-todos.tool';
import { createScheduleTaskTool } from '../../tools/orchestration/schedule-task.tool';
import { createListScheduledTasksTool } from '../../tools/orchestration/list-scheduled-tasks.tool';
import { createCancelScheduledTaskTool } from '../../tools/orchestration/cancel-scheduled-task.tool';
import { createRunScheduledNowTool } from '../../tools/orchestration/run-scheduled-now.tool';
import { createRememberFactTool } from '../../tools/orchestration/remember-fact.tool';
import type { SupervisorGraphStateValue } from '../dynamic-supervisor.state';
import type { Mem0Service } from '../../../memory/mem0.service';
import type { OrchestrationTracer } from '../../../observability/orchestration-tracer';
import type { StatusChannel } from '../../engine/status-channel';
import type { RunStatusAggregator } from '../../run-status.aggregator';
import { redModelSelection } from '../../../../shared/model-selection-log';
import { buildToolFinishedPayload, isErrorOutput } from '../../agent-runners/tool-trace';

// Must be longer than DYNAMIC_AGENT_TIMEOUT_MS (300s) + buffer for retries.
// A failed agent + retry can take 300s+300s; supervisor must outlast that.
const SUPERVISOR_TIMEOUT_MS = 660_000;

export interface SupervisorThinkDeps {
  readonly model: LanguageModel;
  readonly defaultModel?: {
    provider: string;
    modelId:  string;
  };
  readonly resolveModel?: (input: {
    provider: string;
    modelId: string;
    companyId: string;
    agentSlug?: string;
  }) => Promise<LanguageModel> | LanguageModel;
  readonly agentCatalogCache: AgentCatalogCache;
  readonly todoRepo: SupervisorTodoRepository;
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly geminiApiKey?: string;
  readonly approvalGate?: ApprovalGateService;
  readonly mem0?: Mem0Service;
  readonly tracer?: OrchestrationTracer;
  readonly statusChannel?: StatusChannel;
  readonly aggregator?: RunStatusAggregator;
  readonly executeText?: (input: {
    readonly system: string;
    readonly messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    readonly tools: ToolSet;
    readonly maxSteps: number;
    readonly temperature: number;
  }) => Promise<{ readonly text: string; readonly toolCalls: string[] }>;
}

export async function supervisorThink(
  state: SupervisorGraphStateValue,
  deps: SupervisorThinkDeps,
): Promise<Partial<SupervisorGraphStateValue>> {
  try {
    const allAgents = await deps.agentCatalogCache.getForCompany(state.companyId);
    const rootAgent = allAgents.find(agent => agent.isRootAgent && agent.parentId === null);
    if (!rootAgent) {
      return {
        status: 'error',
        error: 'No active root dynamic agent is configured for this company.',
        supervisorResult: 'No active root dynamic agent is configured for this company.',
      };
    }

    let statusHandle: Awaited<ReturnType<NonNullable<typeof deps.statusChannel>['sendStatus']>> = null;
    const onProgress = deps.aggregator && deps.statusChannel
      ? (message: string) => {
          deps.aggregator!.updateActivity(message);
          void deps.statusChannel!.editStatus(statusHandle, {
            kind: 'status', terminal: false, timeline: deps.aggregator!.snapshot(),
          }).then(h => { statusHandle = h; });
        }
      : undefined;

    const agentCtx = {
      model: deps.model,
      ...(deps.defaultModel ? { defaultModel: deps.defaultModel } : {}),
      ...(deps.resolveModel ? { resolveModel: deps.resolveModel } : {}),
      allTools: state.permittedTools,
      toolById: new Map(state.permittedTools.map(tool => [String(tool.id), tool])),
      perm: state.perm,
      runContext: state.runContext,
      logger: deps.logger,
      clock: deps.clock,
      ...(deps.tracer ? { tracer: deps.tracer } : {}),
      ...(state.approvalGate ? { approvalGate: state.approvalGate } : {}),
      ...(deps.geminiApiKey ? { geminiApiKey: deps.geminiApiKey } : {}),
      ...(state.chatId ? { chatId: state.chatId } : {}),
      ...(state.groupContext ? { groupContext: state.groupContext } : {}),
      ...(onProgress ? { onProgress } : {}),
    };

    deps.logger.info('dynamic_graph.think.context', {
      rootAgentSlug: rootAgent.slug,
      rootAgentToolIds: rootAgent.toolIds,
      allAgentSlugs: allAgents.map(a => a.slug),
      permittedToolCount: state.permittedTools.length,
      permittedToolIds: state.permittedTools.map(t => String(t.id)),
      allowedToolIds: [...state.perm.allowedToolIds],
      companyId: state.runContext.companyId,
    });

    const dynamicCapabilities = buildCapabilitiesForAgent(rootAgent, allAgents, agentCtx);

    deps.logger.info('dynamic_graph.think.capabilities_built', {
      capabilityNames: Object.keys(dynamicCapabilities),
      capabilityCount: Object.keys(dynamicCapabilities).length,
    });

    const orchestrationTools = {
      manageTodos: createManageTodosTool(deps.todoRepo, state.runContext),
      scheduleTask: createScheduleTaskTool(deps.prisma, state.runContext),
      listScheduledTasks: createListScheduledTasksTool(deps.prisma, state.runContext),
      cancelScheduledTask: createCancelScheduledTaskTool(deps.prisma, state.runContext),
      runScheduledTaskNow: createRunScheduledNowTool(deps.prisma, state.runContext),
      ...(deps.mem0 ? { rememberFact: createRememberFactTool(deps.mem0, state.runContext) } : {}),
    } as unknown as ToolSet;

    const tools = {
      ...dynamicCapabilities,
      ...orchestrationTools,
    } as unknown as ToolSet;

    const messages = [
      ...state.conversationHistory,
      { role: 'user' as const, content: state.userMessage },
    ];
    const systemPrompt = [
      rootAgent.systemPrompt,
      state.memoryContext
        ? `MEMORY CONTEXT - facts learned from past conversations. Use when relevant, but do not repeat verbatim to the user. IMPORTANT: memories about past failures or errors are informational only — if the user asks you to do something, ALWAYS attempt it regardless of what memory says about previous outcomes. Never refuse an action because a past attempt failed.\n${state.memoryContext}`
        : '',
      state.groupContext,
    ].filter(Boolean).join('\n\n');

    const selectedProvider = rootAgent.provider ?? deps.defaultModel?.provider ?? 'default';
    const selectedModelId = rootAgent.modelId ?? deps.defaultModel?.modelId ?? 'default';
    const modelSource = rootAgent.provider && rootAgent.modelId && deps.resolveModel ? 'agent_override' : 'company_default';
    deps.logger.warn('ai.model.selected', {
      provider: selectedProvider,
      modelId: selectedModelId,
      source: modelSource,
      selection: redModelSelection({
        provider:  selectedProvider,
        modelId:   selectedModelId,
        source:    modelSource,
        agentSlug: rootAgent.slug,
      }),
    });

    const rootModel = rootAgent.provider && rootAgent.modelId && deps.resolveModel
      ? await deps.resolveModel({
        provider:  rootAgent.provider,
        modelId:   rootAgent.modelId,
        companyId: rootAgent.companyId,
        agentSlug: rootAgent.slug,
      })
      : deps.model;

    const rawOutcome = deps.executeText
      ? await deps.executeText({
        system: systemPrompt,
        messages,
        tools,
        maxSteps: rootAgent.maxSteps,
        temperature: rootAgent.temperature,
      })
      : null;
    const outcome = rawOutcome
      ? { ...rawOutcome, toolResults: [] as Array<{ toolName: string; output: string }> }
      : await runSupervisorStream({
        model: rootModel,
        system: systemPrompt,
        messages,
        tools,
        maxSteps: rootAgent.maxSteps,
        temperature: rootAgent.temperature,
        logger: deps.logger,
        ...(deps.tracer ? { tracer: deps.tracer } : {}),
        ...(deps.statusChannel ? { statusChannel: deps.statusChannel } : {}),
        ...(deps.aggregator ? { aggregator: deps.aggregator } : {}),
      });

    const agentDelegations = outcome.toolCalls
      .filter(name => name.startsWith('agent_'))
      .map(name => ({ slug: name.slice('agent_'.length), task: '', result: '' }));

    return {
      supervisorResult: outcome.text.trim() || 'Done.',
      toolCallsMade: outcome.toolCalls,
      toolResults: outcome.toolResults,
      agentDelegations,
      status: 'done',
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error('dynamic_supervisor_graph.think_failed', { error: message });
    return {
      supervisorResult: `Supervisor graph failed: ${message}`,
      status: 'error',
      error: message,
    };
  }
}

async function runSupervisorStream(input: {
  readonly model: LanguageModel;
  readonly system: string;
  readonly messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly temperature: number;
  readonly logger?: Logger;
  readonly tracer?: OrchestrationTracer;
  readonly statusChannel?: StatusChannel;
  readonly aggregator?: RunStatusAggregator;
}): Promise<{ readonly text: string; readonly toolCalls: string[]; readonly toolResults: Array<{ toolName: string; output: string }> }> {
  const result = streamText({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: [stepCountIs(input.maxSteps)],
    temperature: input.temperature,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(SUPERVISOR_TIMEOUT_MS),
  });

  const toolCalls: string[] = [];
  const toolResults: Array<{ toolName: string; output: string }> = [];
  const toolTimers = new Map<string, number>();
  let text = '';
  let statusHandle: Awaited<ReturnType<StatusChannel['sendStatus']>> = null;
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'tool-call') {
      toolCalls.push(chunk.toolName);
      toolTimers.set(chunk.toolName, Date.now());
      input.tracer?.emit({
        phase: 'execute', eventType: 'tool_call_started',
        actorType: 'supervisor', actorKey: chunk.toolName,
        title: `Calling ${chunk.toolName}`,
        status: 'info',
        payload: { toolName: chunk.toolName, args: chunk.input },
      });
      if (input.aggregator && input.statusChannel) {
        input.aggregator.recordCall(chunk.toolName);
        statusHandle = await input.statusChannel.editStatus(statusHandle, {
          kind: 'status', terminal: false, timeline: input.aggregator.snapshot(),
        });
      }
    }
    if (chunk.type === 'tool-result') {
      const output = String(chunk.output);
      const isError = isErrorOutput(output);
      const startMs = toolTimers.get(chunk.toolName);
      toolResults.push({ toolName: chunk.toolName, output });
      input.tracer?.emit({
        phase: 'execute', eventType: 'tool_call_finished',
        actorType: 'supervisor', actorKey: chunk.toolName,
        title: `${chunk.toolName} ${isError ? 'failed' : 'completed'}`,
        status: isError ? 'error' : 'success',
        payload: buildToolFinishedPayload(chunk.toolName, output, startMs),
      });
      if (input.aggregator && input.statusChannel) {
        if (isError) {
          input.aggregator.recordFailure(chunk.toolName, output);
        } else {
          input.aggregator.recordResult(chunk.toolName, output);
        }
        statusHandle = await input.statusChannel.editStatus(statusHandle, {
          kind: 'status', terminal: false, timeline: input.aggregator.snapshot(),
        });
      }
    }
    if (chunk.type === 'text-delta') text += chunk.text;
  }

  const agentResults = toolResults
    .filter(r => r.toolName.startsWith('agent_') && r.output && !r.output.startsWith('error:'))
    .map(r => r.output);

  // Single agent delegation: use the agent's reply directly.
  // The agent is the specialist — its output is always richer than
  // the supervisor's summary. Supervisor only adds value when
  // synthesizing across multiple agents.
  if (agentResults.length === 1) {
    const agentReply = agentResults[0]!;
    const supervisorText = text.trim();

    if (!supervisorText || agentReply.length > supervisorText.length * 1.5) {
      input.logger?.info('supervisor.stream.using_agent_reply', {
        agentReplyLength: agentReply.length,
        supervisorTextLength: supervisorText.length,
        reason: !supervisorText ? 'empty_supervisor_text' : 'agent_reply_richer',
      });
      return { text: agentReply, toolCalls, toolResults };
    }
  }

  // Multiple agents or no agents: use supervisor text if available
  if (text.trim()) {
    return { text, toolCalls, toolResults };
  }

  // Empty supervisor text with multiple agent results: assemble them
  if (agentResults.length > 1) {
    const assembled = agentResults.join('\n\n');
    input.logger?.info('supervisor.stream.assembled_multi_agent', {
      agentResultCount: agentResults.length,
      assembledLength: assembled.length,
    });
    return { text: assembled, toolCalls, toolResults };
  }

  // No agent results and empty text
  input.logger?.warn('supervisor.stream.empty_final', {
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
  });

  return { text, toolCalls, toolResults };
}
