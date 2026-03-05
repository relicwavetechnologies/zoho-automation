import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { resolveChannelAdapter } from '../../channels';
import type {
  AgentInvokeInputDTO,
  AgentResultDTO,
  CheckpointDTO,
  ErrorDTO,
  HITLActionDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import type { HitlActionStatus, OrchestrationTaskStatus } from '../../contracts/status';
import { classifyRuntimeError } from '../../observability';
import { runtimeControlSignalsRepository } from '../../queue/runtime/control-signals.repository';
import { checkpointRepository } from '../../state/checkpoint';
import { hitlActionRepository } from '../../state/hitl/hitl-action.repository';
import { hitlActionService } from '../../state/hitl/hitl-action.service';
import { openAiOrchestrationModels } from '../langchain';
import {
  decideCheckpointRecovery,
  readCheckpointStatus,
  readCheckpointSynthesisText,
  type CheckpointRecoveryDecision,
} from '../langgraph/checkpoint-recovery';
import {
  buildLangGraphAgentInvocations,
  dispatchLangGraphAgents,
} from '../langgraph/agent-bridge';
import { resolveHitlTransition } from '../langgraph/hitl-state-machine';
import { resolvePlanContract } from '../langgraph/plan-contract';
import { resolveRouteContract } from '../langgraph/route-contract';
import { resolveSynthesisContract } from '../langgraph/synthesis-contract';
import type { LangGraphRouteState, LangGraphState, LangGraphSynthesisState } from '../langgraph/langgraph.types';
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
  planSource: Annotation<LangGraphRuntimeState['planSource']>(),
  planValidationErrors: Annotation<LangGraphRuntimeState['planValidationErrors']>(),
  agentInvocations: Annotation<AgentInvokeInputDTO[]>(),
  agentResults: Annotation<AgentResultDTO[]>(),
  hitl: Annotation<HITLActionDTO | undefined>(),
  synthesis: Annotation<LangGraphSynthesisState | undefined>(),
  synthesisSource: Annotation<LangGraphRuntimeState['synthesisSource']>(),
  responseDeliveryStatus: Annotation<LangGraphRuntimeState['responseDeliveryStatus']>(),
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
  trace: state.message.trace,
  route: state.route,
  plan: state.plan,
  planSource: state.planSource,
  planValidationErrors: state.planValidationErrors,
  synthesisSource: state.synthesisSource,
  responseDeliveryStatus: state.responseDeliveryStatus,
  runtimeMeta: state.runtimeMeta,
  ...extra,
});

const mapStoredHitlStatus = (value: string): HitlActionStatus => {
  if (value === 'confirmed' || value === 'cancelled' || value === 'expired' || value === 'pending') {
    return value;
  }
  return 'pending';
};

const mapStoredHitlAction = (stored: {
  taskId: string;
  actionId: string;
  actionType: HITLActionDTO['actionType'];
  summary: string;
  requestedAt: string;
  expiresAt: string;
  status: string;
}): HITLActionDTO => ({
  taskId: stored.taskId,
  actionId: stored.actionId,
  actionType: stored.actionType,
  summary: stored.summary,
  requestedAt: stored.requestedAt,
  expiresAt: stored.expiresAt,
  status: mapStoredHitlStatus(stored.status),
});

const readCheckpointNode = (checkpoint: CheckpointDTO): string =>
  typeof checkpoint.node === 'string' ? checkpoint.node : 'unknown';

const readTaskStatusFromCheckpoint = (checkpoint: CheckpointDTO): OrchestrationTaskStatus => {
  const status = readCheckpointStatus(checkpoint);
  if (status) {
    return status;
  }

  if (checkpoint.node === NODE_SYNTHESIS_COMPOSE || checkpoint.node === 'synthesis.complete') {
    return 'done';
  }

  return 'failed';
};

const readSynthesisTextFromCheckpoint = (checkpoint: CheckpointDTO): string | undefined => {
  const text = readCheckpointSynthesisText(checkpoint);
  return text ?? undefined;
};

const buildCompletedResultFromCheckpoint = (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  checkpoint: CheckpointDTO;
  decision: CheckpointRecoveryDecision;
}): OrchestrationExecutionResult => {
  const status = readTaskStatusFromCheckpoint(input.checkpoint);
  const step = readCheckpointNode(input.checkpoint);
  return {
    task: {
      ...input.task,
      complexityLevel: (input.checkpoint.state.route as { complexityLevel?: OrchestrationTaskDTO['complexityLevel'] } | undefined)
        ?.complexityLevel ?? input.task.complexityLevel,
      executionMode: (input.checkpoint.state.route as { executionMode?: OrchestrationTaskDTO['executionMode'] } | undefined)
        ?.executionMode ?? input.task.executionMode,
      plan: Array.isArray(input.checkpoint.state.plan)
        ? (input.checkpoint.state.plan as string[])
        : input.task.plan,
    },
    status,
    currentStep: step,
    latestSynthesis: readSynthesisTextFromCheckpoint(input.checkpoint),
    runtimeMeta: {
      engine: 'langgraph',
      threadId: input.task.taskId,
      node: step,
      stepHistory: [step],
      routeIntent: detectRouteIntent(input.message.text),
    },
    errors: status === 'failed'
      ? [
          {
            type: 'UNKNOWN_ERROR',
            classifiedReason: input.decision.resumeDecisionReason,
            retriable: false,
          },
        ]
      : undefined,
  };
};

const buildFailedSynthesis = (message: string): LangGraphSynthesisState => ({
  text: `Request could not be completed: ${message}`,
  taskStatus: 'failed',
});

const toTerminalRetryError = (input: {
  error: ErrorDTO | undefined;
  retriableFailure: boolean;
}): ErrorDTO => {
  const fallback: ErrorDTO = {
    type: 'UNKNOWN_ERROR',
    classifiedReason: 'agent_retry_exhausted',
    retriable: false,
  };

  if (!input.error) {
    return fallback;
  }

  if (!input.retriableFailure) {
    return input.error;
  }

  return {
    ...input.error,
    classifiedReason: 'agent_retry_exhausted',
    retriable: false,
  };
};

const buildBridgeExceptionError = (error: unknown): ErrorDTO => {
  const classified = classifyRuntimeError(error);
  return {
    type: classified.type,
    classifiedReason: 'agent_bridge_exception',
    rawMessage: classified.rawMessage,
    retriable: classified.retriable,
  };
};

const isRetriableAgentFailure = (result: AgentResultDTO): boolean =>
  result.status === 'failed' && Boolean(result.error?.retriable);

const mapOutboundFailureToError = (result: { error?: { type?: ErrorDTO['type']; classifiedReason?: string; rawMessage?: string; retriable?: boolean } }): ErrorDTO => ({
  type: result.error?.type ?? 'API_ERROR',
  classifiedReason: result.error?.classifiedReason ?? 'response_delivery_failed',
  rawMessage: result.error?.rawMessage,
  retriable: result.error?.retriable ?? false,
});

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

    const pendingHitlAction = latestCheckpoint?.node === 'hitl.requested'
      ? await hitlActionRepository.getByTaskId(task.taskId)
      : null;

    const recoveryDecision = decideCheckpointRecovery({
      latestCheckpoint: latestCheckpoint ?? null,
      hasPendingHitlAction: Boolean(pendingHitlAction && pendingHitlAction.status === 'pending'),
    });

    logger.info('langgraph.recovery.decision', {
      taskId: task.taskId,
      messageId: message.messageId,
      recoveryMode: recoveryDecision.recoveryMode,
      reason: recoveryDecision.resumeDecisionReason,
      recoveredFromNode: recoveryDecision.recoveredFromNode,
    });

    if (latestCheckpoint && recoveryDecision.shouldReturnCompleted) {
      return buildCompletedResultFromCheckpoint({
        task,
        message,
        checkpoint: latestCheckpoint,
        decision: recoveryDecision,
      });
    }

    if (latestCheckpoint && recoveryDecision.shouldFinalizeOnly) {
      const finalStatus = readTaskStatusFromCheckpoint(latestCheckpoint);
      const existingMeta =
        latestCheckpoint.state.runtimeMeta && typeof latestCheckpoint.state.runtimeMeta === 'object'
          ? (latestCheckpoint.state.runtimeMeta as Record<string, unknown>)
          : {};
      const node = NODE_FINALIZE_TASK;
      const stepHistory = Array.isArray(existingMeta.stepHistory)
        ? [...new Set([...(existingMeta.stepHistory as string[]), node])]
        : [latestCheckpoint.node, node];

      await checkpointRepository.save(task.taskId, node, {
        ...latestCheckpoint.state,
        status: finalStatus,
        recoveryMode: recoveryDecision.recoveryMode,
        resumeDecisionReason: recoveryDecision.resumeDecisionReason,
        runtimeMeta: {
          ...existingMeta,
          engine: 'langgraph',
          threadId: task.taskId,
          node,
          stepHistory,
        },
      });

      return {
        task,
        status: finalStatus,
        currentStep: node,
        latestSynthesis: readSynthesisTextFromCheckpoint(latestCheckpoint),
        runtimeMeta: {
          engine: 'langgraph',
          threadId: task.taskId,
          node,
          stepHistory,
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
        source: 'heuristic_fallback',
      },
      plan: task.plan,
      planSource: 'fallback',
      planValidationErrors: [],
      agentInvocations: [],
      agentResults: [],
      hitl: recoveryDecision.shouldReusePendingHitlAction && pendingHitlAction
        ? mapStoredHitlAction(pendingHitlAction)
        : undefined,
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

        const routeResolution = resolveRouteContract({
          rawLlmOutput: await openAiOrchestrationModels.invokePrompt('router', prompt),
          messageText: state.message.text,
        });

        const runtimeMeta = appendNode(state, NODE_ROUTE_CLASSIFY);
        logger.info('langgraph.route.resolved', {
          taskId: state.task.taskId,
          messageId: state.message.messageId,
          intent: routeResolution.route.intent,
          complexityLevel: routeResolution.route.complexityLevel,
          executionMode: routeResolution.route.executionMode,
          source: routeResolution.source,
          fallbackReasonCode: routeResolution.fallbackReasonCode,
        });

        if (routeResolution.source === 'heuristic_fallback') {
          logger.warn('langgraph.route.fallback', {
            taskId: state.task.taskId,
            messageId: state.message.messageId,
            fallbackReasonCode: routeResolution.fallbackReasonCode,
          });
        }

        await checkpointRepository.save(
          state.task.taskId,
          NODE_ROUTE_CLASSIFY,
          toCheckpointState(
            {
              ...state,
              route: routeResolution.route,
              runtimeMeta,
            },
            NODE_ROUTE_CLASSIFY,
            {
              route: routeResolution.route,
              routeSource: routeResolution.source,
              routeFallbackReasonCode: routeResolution.fallbackReasonCode,
            },
          ),
        );

        return {
          route: routeResolution.route,
          runtimeMeta: {
            ...runtimeMeta,
            routeIntent: routeResolution.route.intent,
          },
        };
      })
      .addNode(NODE_PLAN_BUILD, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const prompt = [
          'Build orchestration plan steps and return JSON only.',
          'Shape: {"plan":["route.classify","agent.invoke.response","agent.invoke.lark-response","synthesis.compose"]}',
          `Intent: ${state.route.intent}`,
          `Complexity: ${state.route.complexityLevel}`,
          `Text: ${state.message.text}`,
        ].join('\n');

        const planResolution = resolvePlanContract({
          rawLlmOutput: await openAiOrchestrationModels.invokePrompt('planner', prompt),
          route: state.route,
          messageText: state.message.text,
        });

        if (planResolution.source === 'fallback') {
          logger.warn('langgraph.plan.fallback', {
            taskId: state.task.taskId,
            messageId: state.message.messageId,
            validationErrors: planResolution.validationErrors,
          });
        }

        const task = {
          ...state.task,
          complexityLevel: state.route.complexityLevel,
          executionMode: state.route.executionMode,
          plan: planResolution.plan,
          orchestratorModel: openAiOrchestrationModels.isEnabled()
            ? `langgraph-router:${config.OPENAI_ROUTER_MODEL}|planner:${config.OPENAI_PLANNER_MODEL}`
            : 'langgraph-fallback',
        };

        const runtimeMeta = appendNode(state, NODE_PLAN_BUILD);
        const invocations = buildLangGraphAgentInvocations(task, state.message);

        await checkpointRepository.save(
          state.task.taskId,
          NODE_PLAN_BUILD,
          toCheckpointState(
            {
              ...state,
              task,
              plan: planResolution.plan,
              planSource: planResolution.source,
              planValidationErrors: planResolution.validationErrors,
              runtimeMeta,
            },
            NODE_PLAN_BUILD,
            {
              plan: planResolution.plan,
              executionMode: state.route.executionMode,
              complexityLevel: state.route.complexityLevel,
              planSource: planResolution.source,
              planValidationErrors: planResolution.validationErrors,
            },
          ),
        );

        return {
          task,
          plan: planResolution.plan,
          planSource: planResolution.source,
          planValidationErrors: planResolution.validationErrors,
          agentInvocations: invocations,
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

        const channelAdapter = resolveChannelAdapter(state.message.channel);
        let activeAction = state.hitl;
        if (!activeAction || activeAction.status !== 'pending') {
          const created = await hitlActionService.createPending({
            taskId: state.task.taskId,
            actionType: 'execute',
            summary: buildHitlSummary(state.message.text),
            chatId: state.message.chatId,
          });
          activeAction = created;

          await checkpointRepository.save(state.task.taskId, 'hitl.requested', {
            ...toCheckpointState({ ...state, hitl: created, runtimeMeta }, NODE_HITL_GATE),
            actionId: created.actionId,
            actionType: created.actionType,
            expiresAt: created.expiresAt,
            status: created.status,
          });

          await channelAdapter.sendMessage({
            chatId: state.message.chatId,
            text:
              `Confirmation required for write-intent request.\n` +
              `Action ID: ${created.actionId}\n` +
              `Reply with: CONFIRM ${created.actionId} or CANCEL ${created.actionId}\n` +
              `Expires at: ${created.expiresAt}`,
            correlationId: state.task.taskId,
          });
        }

        await checkpointRepository.save(state.task.taskId, 'hitl.waiting', {
          ...toCheckpointState({ ...state, hitl: activeAction, runtimeMeta }, NODE_HITL_GATE),
          actionId: activeAction.actionId,
          status: activeAction.status,
        });

        const resolved = await hitlActionService.waitForResolution(activeAction.actionId);
        const transition = resolveHitlTransition('pending', resolved.action.status);
        if (!transition.allowed) {
          throw new Error(`Invalid HITL transition pending -> ${resolved.action.status}`);
        }

        await checkpointRepository.save(state.task.taskId, `hitl.${resolved.action.status}`, {
          ...toCheckpointState({ ...state, hitl: resolved.action, runtimeMeta }, NODE_HITL_GATE),
          actionId: resolved.action.actionId,
          status: resolved.action.status,
          transition,
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
        const invocations = state.agentInvocations.length > 0
          ? state.agentInvocations
          : buildLangGraphAgentInvocations(state.task, state.message);

        const agentResults = await dispatchLangGraphAgents({
          task: state.task,
          message: state.message,
          invocations,
          attempt: (runtimeMeta.retryCount ?? 0) + 1,
        });

        await checkpointRepository.save(state.task.taskId, 'agent.dispatch.complete', {
          ...toCheckpointState({ ...state, agentInvocations: invocations, agentResults, runtimeMeta }, NODE_AGENT_DISPATCH),
          count: agentResults.length,
          failed: agentResults.some((result) => result.status === 'failed'),
        });

        return {
          agentInvocations: invocations,
          agentResults,
          runtimeMeta,
        };
      })
      .addNode(NODE_ERROR_CLASSIFY_RETRY, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_ERROR_CLASSIFY_RETRY);
        const retryCount = runtimeMeta.retryCount ?? 0;
        const firstFailed = state.agentResults.find((result) => result.status === 'failed');
        const retriableFailure = Boolean(firstFailed && isRetriableAgentFailure(firstFailed));

        if (!retriableFailure || retryCount >= MAX_AGENT_DISPATCH_RETRIES) {
          const errorDto = toTerminalRetryError({
            error: firstFailed?.error,
            retriableFailure,
          });
          const synthesis = buildFailedSynthesis(firstFailed?.message ?? 'agent dispatch failure');

          await checkpointRepository.save(state.task.taskId, NODE_ERROR_CLASSIFY_RETRY, {
            ...toCheckpointState(
              {
                ...state,
                runtimeMeta,
              },
              NODE_ERROR_CLASSIFY_RETRY,
            ),
            retried: false,
            retryCount,
            error: errorDto.classifiedReason,
          });

          return {
            errors: [...state.errors, errorDto],
            synthesis,
            synthesisSource: 'deterministic_fallback',
            finalStatus: 'failed',
            runtimeMeta: {
              ...runtimeMeta,
              retryCount,
            },
          };
        }

        const nextRetryCount = retryCount + 1;
        const invocations = state.agentInvocations.length > 0
          ? state.agentInvocations
          : buildLangGraphAgentInvocations(state.task, state.message);

        let retriedResults: AgentResultDTO[];
        try {
          retriedResults = await dispatchLangGraphAgents({
            task: state.task,
            message: state.message,
            invocations,
            attempt: nextRetryCount + 1,
          });
        } catch (error) {
          const errorDto = buildBridgeExceptionError(error);
          await checkpointRepository.save(state.task.taskId, NODE_ERROR_CLASSIFY_RETRY, {
            ...toCheckpointState({ ...state, runtimeMeta }, NODE_ERROR_CLASSIFY_RETRY),
            retried: true,
            retryCount: nextRetryCount,
            failed: true,
            error: errorDto.classifiedReason,
          });
          return {
            errors: [...state.errors, errorDto],
            synthesis: buildFailedSynthesis('agent dispatch exception'),
            synthesisSource: 'deterministic_fallback',
            finalStatus: 'failed',
            runtimeMeta: {
              ...runtimeMeta,
              retryCount: nextRetryCount,
            },
          };
        }

        const stillFailing = retriedResults.find((result) => result.status === 'failed');

        await checkpointRepository.save(state.task.taskId, NODE_ERROR_CLASSIFY_RETRY, {
          ...toCheckpointState({ ...state, runtimeMeta }, NODE_ERROR_CLASSIFY_RETRY),
          retried: true,
          retryCount: nextRetryCount,
          failed: Boolean(stillFailing),
        });

        if (stillFailing) {
          const retryExhaustedError: ErrorDTO = {
            type: stillFailing.error?.type ?? 'TOOL_ERROR',
            classifiedReason: 'agent_retry_exhausted',
            rawMessage: stillFailing.error?.rawMessage ?? stillFailing.message,
            retriable: false,
          };

          return {
            agentResults: retriedResults,
            errors: [...state.errors, retryExhaustedError],
            synthesis: buildFailedSynthesis(stillFailing.message),
            synthesisSource: 'deterministic_fallback',
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

        const synthesisResolution = resolveSynthesisContract({
          rawLlmOutput: await openAiOrchestrationModels.invokePrompt('synthesis', prompt),
          deterministicFallback: deterministic,
        });

        const synthesis = synthesisResolution.synthesis;
        await checkpointRepository.save(state.task.taskId, 'synthesis.complete', {
          ...toCheckpointState(
            {
              ...state,
              synthesis,
              synthesisSource: synthesisResolution.source,
              runtimeMeta,
            },
            NODE_SYNTHESIS_COMPOSE,
          ),
          status: synthesis.taskStatus,
          text: synthesis.text,
          synthesisSource: synthesisResolution.source,
          synthesisValidationErrors: synthesisResolution.validationErrors,
        });

        return {
          synthesis,
          synthesisSource: synthesisResolution.source,
          finalStatus: synthesis.taskStatus,
          runtimeMeta,
        };
      })
      .addNode(NODE_RESPONSE_SEND, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_RESPONSE_SEND);
        const synthesisText = state.synthesis?.text?.trim() ?? '';
        if (synthesisText.length === 0) {
          await checkpointRepository.save(state.task.taskId, NODE_RESPONSE_SEND, {
            ...toCheckpointState(
              {
                ...state,
                responseDeliveryStatus: 'skipped',
                runtimeMeta,
              },
              NODE_RESPONSE_SEND,
            ),
            sent: false,
            responseDeliveryStatus: 'skipped',
            responseDeliveryReason: 'empty_synthesis',
          });

          return {
            responseDeliveryStatus: 'skipped',
            runtimeMeta,
          };
        }

        const channelAdapter = resolveChannelAdapter(state.message.channel);

        try {
          const outbound = await channelAdapter.sendMessage({
            chatId: state.message.chatId,
            text: synthesisText,
            correlationId: state.task.taskId,
          });

          if (outbound.status === 'failed') {
            const deliveryError = mapOutboundFailureToError(outbound);
            await checkpointRepository.save(state.task.taskId, NODE_RESPONSE_SEND, {
              ...toCheckpointState(
                {
                  ...state,
                  responseDeliveryStatus: 'failed',
                  runtimeMeta,
                },
                NODE_RESPONSE_SEND,
              ),
              sent: false,
              responseDeliveryStatus: 'failed',
              responseDeliveryReason: deliveryError.classifiedReason,
            });

            return {
              errors: [...state.errors, deliveryError],
              responseDeliveryStatus: 'failed',
              finalStatus: 'failed',
              runtimeMeta,
            };
          }

          await checkpointRepository.save(state.task.taskId, NODE_RESPONSE_SEND, {
            ...toCheckpointState(
              {
                ...state,
                responseDeliveryStatus: 'sent',
                runtimeMeta,
              },
              NODE_RESPONSE_SEND,
            ),
            sent: true,
            responseDeliveryStatus: 'sent',
            responseMessageId: outbound.messageId,
          });

          return {
            responseDeliveryStatus: 'sent',
            runtimeMeta,
          };
        } catch (error) {
          const deliveryError = classifyRuntimeError(error);
          await checkpointRepository.save(state.task.taskId, NODE_RESPONSE_SEND, {
            ...toCheckpointState(
              {
                ...state,
                responseDeliveryStatus: 'failed',
                runtimeMeta,
              },
              NODE_RESPONSE_SEND,
            ),
            sent: false,
            responseDeliveryStatus: 'failed',
            responseDeliveryReason: deliveryError.classifiedReason,
          });

          return {
            errors: [
              ...state.errors,
              {
                type: deliveryError.type,
                classifiedReason: deliveryError.classifiedReason,
                rawMessage: deliveryError.rawMessage,
                retriable: deliveryError.retriable,
              },
            ],
            responseDeliveryStatus: 'failed',
            finalStatus: 'failed',
            runtimeMeta,
          };
        }
      })
      .addNode(NODE_FINALIZE_TASK, async (state: LangGraphRuntimeState) => {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(state.task.taskId);

        const runtimeMeta = appendNode(state, NODE_FINALIZE_TASK);
        const finalStatus = state.finalStatus
          ?? (state.responseDeliveryStatus === 'failed' ? 'failed' : state.synthesis?.taskStatus)
          ?? 'failed';

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
        const hasFailure = state.agentResults.some((result: any) => result.status === 'failed');
        return hasFailure ? NODE_ERROR_CLASSIFY_RETRY : NODE_SYNTHESIS_COMPOSE;
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
