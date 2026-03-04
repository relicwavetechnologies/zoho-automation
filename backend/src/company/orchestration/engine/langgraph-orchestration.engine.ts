import { randomUUID } from 'crypto';

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { resolveChannelAdapter } from '../../channels';
import type {
  AgentInvokeInputDTO,
  AgentResultDTO,
  ErrorDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import type { OrchestrationTaskStatus } from '../../contracts/status';
import { classifyRuntimeError } from '../../observability';
import { runtimeControlSignalsRepository } from '../../queue/runtime/control-signals.repository';
import { checkpointRepository } from '../../state/checkpoint';
import { hitlActionService } from '../../state/hitl';
import { extractJsonObject, openAiOrchestrationModels } from '../langchain';
import type { LangGraphRouteState, LangGraphState, LangGraphSynthesisState } from '../langgraph/langgraph.types';
import { orchestratorService } from '../orchestrator.service';
import {
  buildHitlSummary,
  buildPlanFromIntent,
  classifyComplexityLevel,
  detectRouteIntent,
  requiresHumanConfirmation,
  synthesizeFromAgentResults,
} from '../routing-heuristics';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

type NodeName =
  | 'route.classify'
  | 'plan.build'
  | 'hitl.gate'
  | 'agent.dispatch'
  | 'error.classify_retry'
  | 'synthesis.compose'
  | 'response.send'
  | 'finalize.task';

type LangGraphRuntimeState = LangGraphState;

const NODE_ROUTE_CLASSIFY: NodeName = 'route.classify';
const NODE_PLAN_BUILD: NodeName = 'plan.build';
const NODE_HITL_GATE: NodeName = 'hitl.gate';
const NODE_AGENT_DISPATCH: NodeName = 'agent.dispatch';
const NODE_ERROR_CLASSIFY_RETRY: NodeName = 'error.classify_retry';
const NODE_SYNTHESIS_COMPOSE: NodeName = 'synthesis.compose';
const NODE_RESPONSE_SEND: NodeName = 'response.send';
const NODE_FINALIZE_TASK: NodeName = 'finalize.task';
const MAX_AGENT_DISPATCH_RETRIES = 1;

const stateAnnotation = Annotation.Root({
  task: Annotation<OrchestrationTaskDTO>(),
  message: Annotation<NormalizedIncomingMessageDTO>(),
  route: Annotation<LangGraphRouteState>(),
  plan: Annotation<string[]>(),
  agentInvocations: Annotation<AgentInvokeInputDTO[]>(),
  agentResults: Annotation<AgentResultDTO[]>(),
  hitl: Annotation<HITLActionDTO | undefined>(),
  synthesis: Annotation<LangGraphSynthesisState | undefined>(),
  runtimeMeta: Annotation<LangGraphRuntimeState['runtimeMeta']>(),
  errors: Annotation<ErrorDTO[]>(),
  finalStatus: Annotation<OrchestrationTaskStatus | undefined>(),
});

const appendNode = (state: LangGraphRuntimeState, node: NodeName): LangGraphRuntimeState['runtimeMeta'] => {
  const history = state.runtimeMeta.stepHistory.includes(node)
    ? state.runtimeMeta.stepHistory
    : [...state.runtimeMeta.stepHistory, node];
  return {
    ...state.runtimeMeta,
    node,
    stepHistory: history,
  };
};

const extractExecutionMode = (
  value: unknown,
): LangGraphRouteState['executionMode'] => {
  if (value === 'parallel' || value === 'mixed' || value === 'sequential') {
    return value;
  }
  return 'sequential';
};

const extractIntent = (value: unknown): LangGraphRouteState['intent'] => {
  if (value === 'zoho_read' || value === 'write_intent' || value === 'general') {
    return value;
  }
  return 'general';
};

const extractComplexityLevel = (value: unknown): LangGraphRouteState['complexityLevel'] => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) {
    return value as LangGraphRouteState['complexityLevel'];
  }
  return 2;
};

const parseRouteOutput = (raw: string | null): Partial<LangGraphRouteState> | null => {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return null;
  }
  return {
    intent: extractIntent(parsed.intent),
    complexityLevel: extractComplexityLevel(parsed.complexityLevel),
    executionMode: extractExecutionMode(parsed.executionMode),
  };
};

const parsePlanOutput = (raw: string | null): string[] | null => {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return null;
  }
  const plan = parsed.plan;
  if (!Array.isArray(plan)) {
    return null;
  }
  const normalized = plan.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return normalized.length > 0 ? normalized : null;
};

const parseSynthesisOutput = (raw: string | null): LangGraphSynthesisState | null => {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.text !== 'string') {
    return null;
  }

  const status = parsed.taskStatus;
  if (status !== 'done' && status !== 'failed') {
    return null;
  }

  return {
    text: parsed.text,
    taskStatus: status,
  };
};

const toCheckpointState = (
  state: LangGraphRuntimeState,
  node: NodeName,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  step: node,
  channel: state.message.channel,
  messageId: state.message.messageId,
  chatId: state.message.chatId,
  chatType: state.message.chatType,
  timestamp: state.message.timestamp,
  userId: state.message.userId,
  text: state.message.text,
  route: state.route,
  plan: state.plan,
  runtimeMeta: state.runtimeMeta,
  ...extra,
});

const createAgentInvocations = (task: OrchestrationTaskDTO, message: NormalizedIncomingMessageDTO): AgentInvokeInputDTO[] => {
  const agentKeys = task.plan
    .filter((step) => step.startsWith('agent.invoke.'))
    .map((step) => step.replace('agent.invoke.', ''));

  return agentKeys.map((agentKey) => ({
    taskId: task.taskId,
    agentKey,
    objective: message.text,
    constraints: ['v1-langgraph-runtime'],
    contextPacket: {
      channel: message.channel,
      chatId: message.chatId,
      chatType: message.chatType,
      timestamp: message.timestamp,
    },
    correlationId: randomUUID(),
  }));
};

export class LangGraphOrchestrationEngine implements OrchestrationEngine {
  readonly id = 'langgraph' as const;

  private readonly graph: any;

  constructor() {
    this.graph = this.buildGraph();
  }

  async buildTask(taskId: string, message: NormalizedIncomingMessageDTO): Promise<OrchestrationTaskDTO> {
    const complexityLevel = classifyComplexityLevel(message.text);
    const intent = detectRouteIntent(message.text);
    return {
      taskId,
      messageId: message.messageId,
      userId: message.userId,
      chatId: message.chatId,
      status: 'running',
      complexityLevel,
      orchestratorModel: openAiOrchestrationModels.isEnabled()
        ? `langgraph-router:${config.OPENAI_ROUTER_MODEL}`
        : 'langgraph-router:fallback',
      plan: buildPlanFromIntent(intent, complexityLevel, message.text),
      executionMode: 'sequential',
    };
  }

  async executeTask(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult> {
    const { task, message, latestCheckpoint } = input;

    if (latestCheckpoint?.node === 'synthesis.complete') {
      const text =
        typeof latestCheckpoint.state.text === 'string'
          ? latestCheckpoint.state.text
          : 'Recovered from completed checkpoint';
      return {
        task,
        status: 'done',
        currentStep: 'synthesis.complete',
        latestSynthesis: text,
        runtimeMeta: {
          engine: 'langgraph',
          threadId: task.taskId,
          node: 'synthesis.complete',
          stepHistory: ['synthesis.complete'],
          routeIntent: detectRouteIntent(message.text),
        },
      };
    }

    const routeIntent = detectRouteIntent(message.text);
    const complexityLevel = classifyComplexityLevel(message.text);
    const initialState: LangGraphRuntimeState = {
      task,
      message,
      route: {
        intent: routeIntent,
        complexityLevel,
        executionMode: 'sequential',
      },
      plan: task.plan,
      agentInvocations: [],
      agentResults: [],
      runtimeMeta: {
        engine: 'langgraph',
        threadId: task.taskId,
        node: NODE_ROUTE_CLASSIFY,
        stepHistory: [],
        routeIntent,
        retryCount: 0,
      },
      errors: [],
    };

    const result = (await this.graph.invoke(initialState)) as LangGraphRuntimeState;
    const status = result.finalStatus ?? result.synthesis?.taskStatus ?? 'failed';
    const runtimeMeta = result.runtimeMeta;

    return {
      task: {
        ...result.task,
        complexityLevel: result.route.complexityLevel,
        executionMode: result.route.executionMode,
      },
      status,
      currentStep: runtimeMeta.node,
      latestSynthesis: result.synthesis?.text,
      agentResults: result.agentResults,
      hitlAction: result.hitl,
      runtimeMeta: {
        engine: 'langgraph',
        threadId: runtimeMeta.threadId,
        node: runtimeMeta.node,
        stepHistory: runtimeMeta.stepHistory,
        routeIntent: runtimeMeta.routeIntent,
      },
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  }

  private buildGraph(): any {
    return (new StateGraph(stateAnnotation as any) as any)
      .addNode(NODE_ROUTE_CLASSIFY, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const prompt = [
          'Classify this user request and return JSON only.',
          'Shape: {"intent":"zoho_read|write_intent|general","complexityLevel":1-5,"executionMode":"sequential|parallel|mixed"}',
          `Text: ${state.message.text}`,
        ].join('\n');

        const routed = parseRouteOutput(await openAiOrchestrationModels.invokePrompt('router', prompt));
        const intent = routed?.intent ?? detectRouteIntent(state.message.text);
        const complexityLevel = routed?.complexityLevel ?? classifyComplexityLevel(state.message.text);
        const executionMode = routed?.executionMode ?? 'sequential';

        const runtimeMeta = appendNode(state, NODE_ROUTE_CLASSIFY);
        await checkpointRepository.save(
          state.task.taskId,
          NODE_ROUTE_CLASSIFY,
          toCheckpointState({ ...state, runtimeMeta }, NODE_ROUTE_CLASSIFY, {
            route: { intent, complexityLevel, executionMode },
          }),
        );

        return {
          route: {
            intent,
            complexityLevel,
            executionMode,
          },
          runtimeMeta: {
            ...runtimeMeta,
            routeIntent: intent,
          },
        };
      })
      .addNode(NODE_PLAN_BUILD, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const fallbackPlan = buildPlanFromIntent(state.route.intent, state.route.complexityLevel, state.message.text);
        const prompt = [
          'Build orchestration plan steps and return JSON only.',
          'Shape: {"plan":["route.classify","agent.invoke.response","agent.invoke.lark-response","synthesis.compose"]}',
          `Intent: ${state.route.intent}`,
          `Complexity: ${state.route.complexityLevel}`,
          `Text: ${state.message.text}`,
        ].join('\n');

        const plan = parsePlanOutput(await openAiOrchestrationModels.invokePrompt('planner', prompt)) ?? fallbackPlan;
        const task = {
          ...state.task,
          complexityLevel: state.route.complexityLevel,
          executionMode: state.route.executionMode,
          plan,
          orchestratorModel: openAiOrchestrationModels.isEnabled()
            ? `langgraph-router:${config.OPENAI_ROUTER_MODEL}|planner:${config.OPENAI_PLANNER_MODEL}`
            : 'langgraph-fallback',
        };

        const runtimeMeta = appendNode(state, NODE_PLAN_BUILD);
        await checkpointRepository.save(
          state.task.taskId,
          NODE_PLAN_BUILD,
          toCheckpointState({ ...state, runtimeMeta }, NODE_PLAN_BUILD, {
            plan,
            executionMode: state.route.executionMode,
            complexityLevel: state.route.complexityLevel,
          }),
        );

        return {
          task,
          plan,
          agentInvocations: createAgentInvocations(task, state.message),
          runtimeMeta,
        };
      })
      .addNode(NODE_HITL_GATE, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_HITL_GATE);
        const needsHitl = state.route.intent === 'write_intent' || requiresHumanConfirmation(state.message.text);
        await checkpointRepository.save(
          state.task.taskId,
          NODE_HITL_GATE,
          toCheckpointState({ ...state, runtimeMeta }, NODE_HITL_GATE, { needsHitl }),
        );

        if (!needsHitl) {
          return {
            runtimeMeta,
          };
        }

        const hitlAction = await hitlActionService.createPending({
          taskId: state.task.taskId,
          actionType: 'execute',
          summary: buildHitlSummary(state.message.text),
          chatId: state.message.chatId,
        });

        await checkpointRepository.save(state.task.taskId, 'hitl.requested', {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_HITL_GATE),
          actionId: hitlAction.actionId,
          actionType: hitlAction.actionType,
          expiresAt: hitlAction.expiresAt,
        });

        const channelAdapter = resolveChannelAdapter(state.message.channel);
        await channelAdapter.sendMessage({
          chatId: state.message.chatId,
          text:
            `Confirmation required for write-intent request.\n` +
            `Action ID: ${hitlAction.actionId}\n` +
            `Reply with: CONFIRM ${hitlAction.actionId} or CANCEL ${hitlAction.actionId}\n` +
            `Expires at: ${hitlAction.expiresAt}`,
          correlationId: state.task.taskId,
        });

        const resolved = await hitlActionService.waitForResolution(hitlAction.actionId);
        await checkpointRepository.save(state.task.taskId, `hitl.${resolved.action.status}`, {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_HITL_GATE),
          actionId: resolved.action.actionId,
          status: resolved.action.status,
        });

        if (resolved.action.status !== 'confirmed') {
          const text =
            resolved.action.status === 'expired'
              ? 'Request auto-cancelled: confirmation window expired.'
              : 'Request cancelled. No write action executed.';
          await channelAdapter.sendMessage({
            chatId: state.message.chatId,
            text,
            correlationId: state.task.taskId,
          });

          return {
            hitl: resolved.action,
            synthesis: {
              text:
                resolved.action.status === 'expired'
                  ? 'Request cancelled because confirmation timed out.'
                  : 'Request cancelled by user confirmation flow.',
              taskStatus: 'cancelled',
            },
            finalStatus: 'cancelled',
            runtimeMeta,
          };
        }

        await channelAdapter.sendMessage({
          chatId: state.message.chatId,
          text: 'Confirmation received. Resuming execution.',
          correlationId: state.task.taskId,
        });

        return {
          hitl: resolved.action,
          runtimeMeta,
        };
      })
      .addNode(NODE_AGENT_DISPATCH, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_AGENT_DISPATCH);
        const agentResults = await orchestratorService.dispatchAgents(state.task, state.message);
        await checkpointRepository.save(state.task.taskId, 'agent.dispatch.complete', {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_AGENT_DISPATCH),
          count: agentResults.length,
          failed: agentResults.some((result) => result.status === 'failed'),
        });

        return {
          agentResults,
          runtimeMeta,
        };
      })
      .addNode(NODE_ERROR_CLASSIFY_RETRY, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_ERROR_CLASSIFY_RETRY);
        const retryCount = runtimeMeta.retryCount ?? 0;
        const firstFailed = state.agentResults.find((result) => result.status === 'failed');
        if (!firstFailed?.error?.retriable || retryCount >= MAX_AGENT_DISPATCH_RETRIES) {
          const errorDto = firstFailed?.error ?? {
            type: 'UNKNOWN_ERROR',
            classifiedReason: 'agent_dispatch_failed_after_retry',
            retriable: false,
          };
          const synthesis = {
            text: `Request could not be completed: ${firstFailed?.message ?? 'agent dispatch failure'}`,
            taskStatus: 'failed' as const,
          };

          await checkpointRepository.save(state.task.taskId, NODE_ERROR_CLASSIFY_RETRY, {
            ...toCheckpointState({ ...state, runtimeMeta }, NODE_ERROR_CLASSIFY_RETRY),
            retried: false,
            retryCount,
            error: errorDto.classifiedReason,
          });

          return {
            errors: [...state.errors, errorDto],
            synthesis,
            finalStatus: 'failed',
            runtimeMeta: {
              ...runtimeMeta,
              retryCount,
            },
          };
        }

        const nextRetryCount = retryCount + 1;
        const retriedResults = await orchestratorService.dispatchAgents(state.task, state.message);
        const stillFailing = retriedResults.find((result) => result.status === 'failed');

        await checkpointRepository.save(state.task.taskId, NODE_ERROR_CLASSIFY_RETRY, {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_ERROR_CLASSIFY_RETRY),
          retried: true,
          retryCount: nextRetryCount,
          failed: Boolean(stillFailing),
        });

        if (stillFailing) {
          const errorDto = stillFailing.error ?? classifyRuntimeError(new Error(stillFailing.message));
          return {
            agentResults: retriedResults,
            errors: [...state.errors, errorDto],
            synthesis: {
              text: `Request could not be completed: ${stillFailing.message}`,
              taskStatus: 'failed',
            },
            finalStatus: 'failed',
            runtimeMeta: {
              ...runtimeMeta,
              retryCount: nextRetryCount,
            },
          };
        }

        return {
          agentResults: retriedResults,
          runtimeMeta: {
            ...runtimeMeta,
            retryCount: nextRetryCount,
          },
        };
      })
      .addNode(NODE_SYNTHESIS_COMPOSE, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_SYNTHESIS_COMPOSE);
        const deterministic = state.synthesis ?? synthesizeFromAgentResults(state.task, state.message, state.agentResults);
        const prompt = [
          'Synthesize final runtime response and return JSON only.',
          'Shape: {"taskStatus":"done|failed","text":"..."}',
          `Intent: ${state.route.intent}`,
          `UserText: ${state.message.text}`,
          `AgentResults: ${JSON.stringify(state.agentResults)}`,
        ].join('\n');
        const llmOutput = parseSynthesisOutput(await openAiOrchestrationModels.invokePrompt('synthesis', prompt));
        const synthesis = llmOutput ?? deterministic;

        await checkpointRepository.save(state.task.taskId, 'synthesis.complete', {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_SYNTHESIS_COMPOSE),
          status: synthesis.taskStatus,
          text: synthesis.text,
        });

        return {
          synthesis,
          finalStatus: synthesis.taskStatus,
          runtimeMeta,
        };
      })
      .addNode(NODE_RESPONSE_SEND, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_RESPONSE_SEND);
        if (state.synthesis?.text) {
          const channelAdapter = resolveChannelAdapter(state.message.channel);
          await channelAdapter.sendMessage({
            chatId: state.message.chatId,
            text: state.synthesis.text,
            correlationId: state.task.taskId,
          });
        }

        await checkpointRepository.save(state.task.taskId, NODE_RESPONSE_SEND, {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_RESPONSE_SEND),
          sent: Boolean(state.synthesis?.text),
        });

        return {
          runtimeMeta,
        };
      })
      .addNode(NODE_FINALIZE_TASK, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_FINALIZE_TASK);
        const finalStatus = state.finalStatus ?? state.synthesis?.taskStatus ?? 'failed';
        await checkpointRepository.save(state.task.taskId, NODE_FINALIZE_TASK, {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_FINALIZE_TASK),
          status: finalStatus,
        });

        return {
          finalStatus,
          runtimeMeta,
        };
      })
      .addEdge(START, NODE_ROUTE_CLASSIFY)
      .addEdge(NODE_ROUTE_CLASSIFY, NODE_PLAN_BUILD)
      .addEdge(NODE_PLAN_BUILD, NODE_HITL_GATE)
      .addConditionalEdges(NODE_HITL_GATE, (state: any) =>
        state.finalStatus === 'cancelled' ? NODE_FINALIZE_TASK : NODE_AGENT_DISPATCH,
      )
      .addConditionalEdges(NODE_AGENT_DISPATCH, (state: any) => {
        const hasRetriableFailure = state.agentResults.some(
          (result: any) => result.status === 'failed' && Boolean(result.error?.retriable),
        );
        return hasRetriableFailure ? NODE_ERROR_CLASSIFY_RETRY : NODE_SYNTHESIS_COMPOSE;
      })
      .addEdge(NODE_ERROR_CLASSIFY_RETRY, NODE_SYNTHESIS_COMPOSE)
      .addEdge(NODE_SYNTHESIS_COMPOSE, NODE_RESPONSE_SEND)
      .addEdge(NODE_RESPONSE_SEND, NODE_FINALIZE_TASK)
      .addEdge(NODE_FINALIZE_TASK, END)
      .compile({
        name: 'zoho-automation-langgraph',
      });
  }
}

export const langGraphOrchestrationEngine = new LangGraphOrchestrationEngine();
