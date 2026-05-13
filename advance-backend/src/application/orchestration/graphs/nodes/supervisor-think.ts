import { streamText, generateText, stepCountIs } from 'ai';
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
import { buildSynthesisSupervisorPrompt } from '../../agents/supervisor.prompt';

const SUPERVISOR_TIMEOUT_MS = 180_000;

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
      ...(state.approvalGate ? { approvalGate: state.approvalGate } : {}),
      ...(deps.geminiApiKey ? { geminiApiKey: deps.geminiApiKey } : {}),
      ...(state.chatId ? { chatId: state.chatId } : {}),
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
    const systemPrompt = state.memoryContext
      ? `${rootAgent.systemPrompt}\n\nMEMORY CONTEXT - facts learned from past conversations. Use when relevant, but do not repeat verbatim to the user:\n${state.memoryContext}`
      : rootAgent.systemPrompt;

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

    const usingMock = !!deps.executeText;
    const outcome = usingMock
      ? { ...await deps.executeText!({
          system: systemPrompt,
          messages,
          tools,
          maxSteps: rootAgent.maxSteps,
          temperature: rootAgent.temperature,
        }), textAfterLastTool: '', toolResults: [] as Array<{ toolName: string; output: string }> }
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

    // Phase 2 — mandatory synthesis pass after any agent delegation.
    // The supervisor's Phase 1 text is often pre-delegation narration or
    // internal tool-call echoes — never trust it as the user-facing reply.
    // No tools are available in this call, so the model must produce text.
    const hadAgentDelegation = outcome.toolCalls.some(n => n.startsWith('agent_'));
    const needsSynthesis = !usingMock && hadAgentDelegation;

    let finalText = outcome.text;
    if (needsSynthesis) {
      finalText = await runSynthesisPass({
        model: rootModel,
        originalMessages: messages,
        toolResults: outcome.toolResults,
        logger: deps.logger,
      });
    }

    const agentDelegations = outcome.toolCalls
      .filter(name => name.startsWith('agent_'))
      .map(name => ({ slug: name.slice('agent_'.length), task: '', result: '' }));

    return {
      supervisorResult: finalText.trim() || 'Done.',
      toolCallsMade: outcome.toolCalls,
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
}): Promise<{
  readonly text: string;
  readonly textAfterLastTool: string;
  readonly toolCalls: string[];
  readonly toolResults: Array<{ toolName: string; output: string }>;
}> {
  const result = streamText({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: [stepCountIs(input.maxSteps)],
    temperature: input.temperature,
    abortSignal: AbortSignal.timeout(SUPERVISOR_TIMEOUT_MS),
  });

  const toolCalls: string[] = [];
  const toolResults: Array<{ toolName: string; output: string }> = [];
  let text = '';
  let textAfterLastTool = '';
  let lastToolResultSeen = false;
  let statusHandle: Awaited<ReturnType<StatusChannel['sendStatus']>> = null;

  for await (const chunk of result.fullStream) {
    if (chunk.type === 'tool-call') {
      toolCalls.push(chunk.toolName);
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
      toolResults.push({ toolName: chunk.toolName, output });
      lastToolResultSeen = true;
      textAfterLastTool = ''; // reset — we track text generated after THIS result
      input.tracer?.emit({
        phase: 'execute', eventType: 'tool_call_finished',
        actorType: 'supervisor', actorKey: chunk.toolName,
        title: `${chunk.toolName} completed`,
        status: 'success',
        payload: { toolName: chunk.toolName, resultLength: output.length },
      });
      if (input.aggregator && input.statusChannel) {
        input.aggregator.recordResult(chunk.toolName, output);
        statusHandle = await input.statusChannel.editStatus(statusHandle, {
          kind: 'status', terminal: false, timeline: input.aggregator.snapshot(),
        });
      }
    }
    if (chunk.type === 'text-delta') {
      text += chunk.text;
      if (lastToolResultSeen) textAfterLastTool += chunk.text;
    }
  }

  input.logger?.info('supervisor.stream.done', {
    textLength: text.length,
    textAfterLastToolLength: textAfterLastTool.length,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
  });

  return { text, textAfterLastTool, toolCalls, toolResults };
}

const SYNTHESIS_TIMEOUT_MS = 60_000;

async function runSynthesisPass(input: {
  readonly model: LanguageModel;
  readonly originalMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  readonly toolResults: Array<{ toolName: string; output: string }>;
  readonly logger?: Logger;
}): Promise<string> {
  const successResults = input.toolResults.filter(r => !r.output.startsWith('error:'));
  const failedResults  = input.toolResults.filter(r =>  r.output.startsWith('error:'));

  const resultBlock = [
    ...successResults.map(r => `[${r.toolName}]:\n${r.output}`),
    ...failedResults.map(r  => `[${r.toolName} — failed]: ${r.output}`),
  ].join('\n\n---\n\n');

  const synthesisMessages = [
    ...input.originalMessages,
    {
      role: 'assistant' as const,
      content: `I have completed all delegations. Here are the full results from my sub-agents:\n\n${resultBlock}`,
    },
    {
      role: 'user' as const,
      content: 'Write your final reply to the user based on these results.',
    },
  ];

  input.logger?.info('supervisor.synthesis_pass.start', {
    toolResultCount: input.toolResults.length,
    successCount: successResults.length,
    failedCount: failedResults.length,
  });

  const result = await generateText({
    model: input.model,
    system: buildSynthesisSupervisorPrompt(),
    messages: synthesisMessages,
    temperature: 0.3,
    abortSignal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
  });

  input.logger?.info('supervisor.synthesis_pass.done', {
    textLength: result.text.length,
    textPreview: result.text.slice(0, 200),
  });

  return result.text.trim();
}
