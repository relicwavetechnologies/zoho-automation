import { randomUUID } from 'crypto';

import { generateText, stepCountIs } from 'ai';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { CircuitBreakerOpenError, runWithCircuitBreaker } from '../../observability/circuit-breaker';
import { resolveChannelAdapter } from '../../channels';
import { retrievalOrchestratorService } from '../../retrieval';
import type { ChannelAdapter } from '../../channels/base/channel-adapter';
import type { AgentResultDTO, NormalizedIncomingMessageDTO, OrchestrationTaskDTO } from '../../contracts';
import { conversationMemoryStore } from '../../state/conversation';
import type { OrchestrationExecutionResult } from '../engine/types';
import { resolveVercelLanguageModel } from '../vercel/model-factory';
import type { VercelRuntimeRequestContext } from '../vercel/types';
import {
  buildClassifierPrompt,
  buildDeterministicSynthesis,
  buildInputMessages,
  buildReadOnlyRuntimeContext,
  buildResearchSystemPrompt,
  buildSynthesisJsonPrompt,
  collectEvidenceFromToolOutput,
  findPendingApproval,
  selectToolFamilies,
  shouldDelegateToCompatibility,
} from './core/runtime';
import { GraphToolFacade } from './graph-tool-facade';
import { GRAPH_TOOL_FAMILY_MAP } from './graph-tool-facade';
import { resolveRouteContract } from './route-contract';
import { resolveSynthesisContract } from './synthesis-contract';
import { runtimeLoopGuards } from './runtime.loop-guards';
import { runtimeToolPolicy } from './runtime.tool-policy';
import type {
  RuntimeDeliveryEnvelope,
  RuntimeEvidenceItem,
  RuntimeExecutionStepState,
  RuntimeGroundedEvidence,
} from './runtime.types';
import type { RuntimeState } from './runtime.state';
import { runtimeConversationRepository } from './runtime-conversation.repository';
import { runtimeRunRepository } from './runtime-run.repository';

type GraphExecutionMode =
  | {
    kind: 'graph';
    result: OrchestrationExecutionResult;
    state: RuntimeState;
  }
  | {
    kind: 'compatibility';
    reason: string;
    routeIntent: string;
    state: RuntimeState;
  };

const LARK_VERCEL_MODE: VercelRuntimeRequestContext['mode'] = 'fast';
const GEMINI_CIRCUIT_BREAKER = {
  failureThreshold: 5,
  windowMs: 60_000,
  openMs: 120_000,
};

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const runWithModelCircuitBreaker = async <T>(
  provider: string,
  operation: string,
  run: () => Promise<T> | T,
): Promise<T> => {
  if (provider !== 'google') {
    return Promise.resolve(run());
  }
  try {
    return await runWithCircuitBreaker('gemini', operation, GEMINI_CIRCUIT_BREAKER, async () => Promise.resolve(run()));
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
    }
    throw error;
  }
};

const buildStatusText = (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  phase: 'processing' | 'tool_running' | 'tool_done' | 'delegating' | 'processed' | 'failed';
  detail?: string;
  history: string[];
}): string => {
  if (input.phase === 'processed') {
    return 'Completed request.';
  }

  const lines: string[] = [];
  const mode = input.task.executionMode ?? 'sequential';
  if (input.phase === 'processing') {
    lines.push(`Processing request (${input.task.taskId.slice(0, 8)})...`);
  } else if (input.phase === 'tool_running') {
    lines.push(`Running (${mode}) for message ${input.message.messageId}.`);
  } else if (input.phase === 'tool_done') {
    lines.push(`Updated (${mode}) for message ${input.message.messageId}.`);
  } else if (input.phase === 'delegating') {
    lines.push(`Switching execution path (${input.task.taskId.slice(0, 8)})...`);
  } else {
    lines.push(`Failed (${mode}) for message ${input.message.messageId}.`);
  }
  lines.push(`Plan: ${input.task.plan.join(' -> ')}`);
  if (input.detail) {
    lines.push(input.detail);
  }
  if (input.history.length > 0) {
    lines.push('Logs:');
    lines.push(...input.history.slice(-6));
  }
  return lines.join('\n');
};

const incrementCounter = (bucket: Record<string, number> | undefined, key: string) => {
  if (!bucket) return;
  bucket[key] = (bucket[key] ?? 0) + 1;
};

const buildAgentResultsFromExecution = (
  taskId: string,
  steps: RuntimeExecutionStepState[],
): AgentResultDTO[] =>
  steps.map((step) => ({
    taskId,
    agentKey: step.toolName,
    status: step.status === 'completed' ? 'success' : 'failed',
    message: step.summary ?? `${step.toolName} ${step.status}`,
    result: step.output,
    error: step.status === 'completed'
      ? undefined
      : {
        type: 'TOOL_ERROR',
        classifiedReason: step.status,
        rawMessage: step.summary,
        retriable: step.status === 'failed',
      },
    metrics: { apiCalls: 1 },
  }));

const buildDeliveryEnvelope = (input: {
  channel: 'lark';
  payloadType: RuntimeDeliveryEnvelope['payloadType'];
  text: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
}): RuntimeDeliveryEnvelope => ({
  channel: input.channel,
  payloadType: input.payloadType,
  text: input.text,
  dedupeKey: input.dedupeKey,
  metadata: input.metadata,
});

export class RuntimeGraphExecutor {
  private async persistNodeState(state: RuntimeState, nodeName: string) {
    state.run.currentNode = nodeName;
    state.run.stepIndex += 1;
    incrementCounter(state.diagnostics.nodeTransitionCount, nodeName);

    await runtimeRunRepository.update(state.run.id, {
      currentNode: nodeName,
      stepCount: state.run.stepIndex,
    });
    await runtimeRunRepository.createSnapshot({
      runId: state.run.id,
      stepIndex: state.run.stepIndex,
      nodeName,
      stateJson: state as unknown as Record<string, unknown>,
    });
  }

  async execute(input: {
    task: OrchestrationTaskDTO;
    message: NormalizedIncomingMessageDTO;
    state: RuntimeState;
  }): Promise<GraphExecutionMode> {
    const { task, message } = input;
    const state = input.state;
    const channelAdapter = resolveChannelAdapter(message.channel) as ChannelAdapter;
    const conversationKey = state.conversation.key;
    const statusHistory: string[] = [];
    let statusMessageId = state.delivery.statusMessageId;

    conversationMemoryStore.addUserMessage(conversationKey, message.messageId, message.text);

    const updateStatus = async (
      phase: 'processing' | 'tool_running' | 'tool_done' | 'delegating' | 'processed' | 'failed',
      detail?: string,
    ) => {
      const dedupeKey = `status:${state.run.id}:${phase}:${state.run.stepIndex}`;
      const deliveryCheck = runtimeLoopGuards.registerDelivery(state.diagnostics, state.run.channel, dedupeKey);
      if (deliveryCheck.blocked) {
        return;
      }

      const text = buildStatusText({ task, message, phase, detail, history: statusHistory });
      if (statusMessageId) {
        const outbound = await channelAdapter.updateMessage({
          messageId: statusMessageId,
          text,
          correlationId: task.taskId,
        });
        if (outbound.status !== 'failed') {
          statusMessageId = outbound.messageId ?? statusMessageId;
        }
      } else {
        const outbound = await channelAdapter.sendMessage({
          chatId: message.chatId,
          text,
          correlationId: task.taskId,
        });
        if (outbound.status !== 'failed') {
          statusMessageId = outbound.messageId ?? undefined;
        }
      }

      state.delivery.statusMessageId = statusMessageId;
      state.delivery.sentDedupeKeys.push(dedupeKey);
      state.delivery.outbox.push(buildDeliveryEnvelope({
        channel: 'lark',
        payloadType: 'status',
        text,
        dedupeKey,
      }));
    };

    await updateStatus('processing');

    const classifierModel = await resolveVercelLanguageModel(LARK_VERCEL_MODE);
    const classifierOutput = await runWithModelCircuitBreaker(classifierModel.effectiveProvider, 'langgraph_classifier', () => generateText({
      model: classifierModel.model,
      system: 'Return JSON only.',
      prompt: buildClassifierPrompt(message.text),
      temperature: 0,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: false,
            thinkingLevel: classifierModel.thinkingLevel,
          },
        },
      },
    })).catch((error) => {
      logger.warn('langgraph.classifier.failed', {
        taskId: task.taskId,
        messageId: message.messageId,
        error: error instanceof Error ? error.message : 'unknown_classifier_error',
      });
      return null;
    });

    const routeContract = resolveRouteContract({
      rawLlmOutput: classifierOutput?.text ?? null,
      messageText: message.text,
    });

    state.classification = {
      intent: routeContract.route.intent,
      complexity: routeContract.route.complexity,
      freshnessNeed: routeContract.route.freshnessNeed,
      risk: routeContract.route.risk,
      domains: routeContract.route.domains,
      knowledgeNeeds: routeContract.route.knowledgeNeeds,
      preferredStrategy: routeContract.route.preferredStrategy,
      source: routeContract.source,
      fallbackReasonCode: routeContract.fallbackReasonCode,
    };
    const classification = state.classification;
    await this.persistNodeState(state, 'route.classify');

    incrementCounter(state.diagnostics.retrievalRouteCount, routeContract.route.retrievalMode);
    state.retrieval = {
      mode: routeContract.route.retrievalMode,
      rationale: routeContract.source === 'model'
        ? 'Classifier supplied retrieval mode.'
        : `Heuristic route for ${routeContract.route.intent}.`,
      source: routeContract.source === 'model' ? 'model' : 'heuristic_fallback',
      query: message.text,
      knowledgeNeeds: routeContract.route.knowledgeNeeds,
      preferredStrategy: routeContract.route.preferredStrategy,
      toolFamilies: [],
    };
    const retrieval = state.retrieval;
    await this.persistNodeState(state, 'policy.gate');
    await this.persistNodeState(state, 'route.retrieval');

    const compatibilityReason = shouldDelegateToCompatibility({
      task,
      classification,
      retrieval,
      planSteps: task.plan,
    });
    if (compatibilityReason) {
      state.plan = {
        kind: 'compatibility_delegate',
        reason: compatibilityReason,
        steps: ['compat.execute_vercel'],
      };
      state.execution = {
        delegatedTo: 'vercel',
        steps: [],
      };
      statusHistory.push(`Delegating to compatibility runtime: ${compatibilityReason}`);
      await updateStatus('delegating', compatibilityReason);
      await this.persistNodeState(state, 'compat.execute_vercel');
      return {
        kind: 'compatibility',
        reason: compatibilityReason,
        routeIntent: classification.intent,
        state,
      };
    }

    const runtime = buildReadOnlyRuntimeContext({
      state,
      threadId: state.conversation.key,
      chatId: message.chatId,
      executionId: task.taskId,
      sourceUserId: message.userId,
      mode: LARK_VERCEL_MODE,
    });
    const retrievalPortfolio = retrievalOrchestratorService.planExecution({
      messageText: message.text,
      intent: classification.intent,
      domains: classification.domains,
      freshnessNeed: classification.freshnessNeed,
      retrievalMode: retrieval.mode,
      hasAttachments: (message.attachedFiles ?? []).length > 0,
    });
    retrieval.portfolioPlan = retrievalPortfolio.plan;
    retrieval.systemDirectives = retrievalPortfolio.systemDirectives;
    retrieval.toolFamilies = retrievalPortfolio.toolFamilies;
    const selectedFamilies = selectToolFamilies({
      classification,
      retrieval,
      hasAttachments: (message.attachedFiles ?? []).length > 0,
    });
    state.plan = {
      kind: 'tool_loop',
      steps: ['research.execute', 'synthesis.compose', 'deliver.response'],
    };
    state.execution = {
      steps: [],
    };
    const execution = state.execution;

    const toolIndexByActivityId = new Map<string, number>();
    const evidence: RuntimeEvidenceItem[] = [];
    const groundedEvidence: RuntimeGroundedEvidence[] = [];
    const facade = new GraphToolFacade(runtime, {
      onToolStart: async (toolName, activityId, title, toolInput) => {
        const inputGuard = runtimeLoopGuards.registerToolCall(state.diagnostics, toolName, toolInput ?? {});
        if (inputGuard.blocked) {
          throw new Error(`Tool loop guard triggered for ${toolName}.`);
        }
        const candidateToolIds = GRAPH_TOOL_FAMILY_MAP[toolName as keyof typeof GRAPH_TOOL_FAMILY_MAP] ?? [toolName];
        const authorized = candidateToolIds.some((toolId) =>
          runtimeToolPolicy.authorize({
            toolId,
            actionGroup: 'read',
            allowedToolIds: runtime.allowedToolIds,
            allowedActionsByTool: runtime.allowedActionsByTool ?? {},
            engineMode: 'primary',
          }).allowed,
        );
        if (!authorized) {
          throw new Error(`Runtime tool policy blocked ${toolName}.`);
        }
        toolIndexByActivityId.set(activityId, execution.steps.length);
        execution.steps.push({
          id: activityId,
          toolName,
          actionGroup: 'read',
          status: 'running',
          summary: title,
          input: toolInput,
        });
        statusHistory.push(`Running: ${title}`);
        await runtimeConversationRepository.appendMessage({
          conversationId: state.conversation.id,
          runId: state.run.id,
          role: 'tool',
          messageKind: 'tool_call',
          sourceChannel: state.run.channel,
          dedupeKey: `tool_call:${state.run.id}:${activityId}`,
          contentText: title,
          toolCallJson: {
            toolName,
            input: toolInput ?? null,
          },
          visibility: 'internal',
        });
        await updateStatus('tool_running', title);
      },
      onToolFinish: async (toolName, activityId, title, output) => {
        const index = toolIndexByActivityId.get(activityId);
        if (index !== undefined && execution.steps[index]) {
          execution.steps[index] = {
            ...execution.steps[index],
            status: output.pendingApprovalAction ? 'approval_required' : output.success ? 'completed' : 'failed',
            summary: output.summary,
            output: output.fullPayload ?? output.keyData,
            citations: (output.citations ?? []) as Array<Record<string, unknown>>,
          };
        }
        evidence.push(...collectEvidenceFromToolOutput(toolName, {
          summary: output.summary,
          fullPayload: output.fullPayload ?? output.keyData,
          citations: output.citations ?? [],
        }));
        groundedEvidence.push(...retrievalOrchestratorService.collectGroundedEvidence(toolName, {
          summary: output.summary,
          fullPayload: (output.fullPayload ?? output.keyData) as Record<string, unknown> | undefined,
          citations: (output.citations ?? []) as Array<Record<string, unknown>>,
        }));
        statusHistory.push(`${output.success ? 'Completed' : 'Failed'} ${toolName}: ${summarizeText(output.summary, 180) ?? output.summary}`);
        await runtimeConversationRepository.appendMessage({
          conversationId: state.conversation.id,
          runId: state.run.id,
          role: 'tool',
          messageKind: 'tool_result',
          sourceChannel: state.run.channel,
          dedupeKey: `tool_result:${state.run.id}:${activityId}`,
          contentText: output.summary,
          toolResultJson: {
            toolName,
            success: output.success,
            summary: output.summary,
            citations: output.citations ?? [],
          },
          visibility: 'internal',
        });
        await updateStatus('tool_done', `${title}: ${summarizeText(output.summary, 180) ?? output.summary}`);
      },
    });

    const researchTools = facade.selectFamilies(selectedFamilies);
    const inputMessages = await buildInputMessages({
      state,
      messageText: message.text,
      runtime,
      attachedFiles: (message.attachedFiles ?? []) as Array<{
        fileAssetId: string;
        cloudinaryUrl: string;
        mimeType: string;
        fileName: string;
      }>,
    });
    const researchModel = await resolveVercelLanguageModel(runtime.mode);
    const researchResult = await runWithModelCircuitBreaker(researchModel.effectiveProvider, 'langgraph_research', () => generateText({
      model: researchModel.model,
      system: buildResearchSystemPrompt({
        state,
        classification,
        retrieval,
        toolFamilies: selectedFamilies,
      }),
      messages: inputMessages,
      tools: researchTools,
      temperature: config.OPENAI_TEMPERATURE,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: researchModel.thinkingLevel,
          },
        },
      },
      stopWhen: [stepCountIs(12)],
    }));
    logger.info('vercel.tool_loop.summary', {
      mode: runtime.mode,
      modelId: researchModel.effectiveModelId,
      stepCount: Array.isArray(researchResult.steps) ? researchResult.steps.length : 0,
      stepLimit: 12,
      hitStepLimit: Array.isArray(researchResult.steps) ? researchResult.steps.length >= 12 : false,
      channel: message.channel,
    });

    state.evidence = evidence;
    state.groundedEvidence = groundedEvidence;
    await this.persistNodeState(state, 'research.execute');

    const researchSteps = researchResult.steps as Array<{ toolResults?: Array<{ output?: unknown }> }>;
    const pendingApproval = findPendingApproval(researchSteps);
    if (pendingApproval) {
      execution.steps.push({
        id: randomUUID(),
        toolName: pendingApproval.toolId ?? pendingApproval.kind,
        actionGroup: pendingApproval.actionGroup ?? 'execute',
        status: 'approval_required',
        summary: pendingApproval.kind === 'tool_action' ? pendingApproval.summary : pendingApproval.title,
        output: pendingApproval.kind === 'tool_action' ? pendingApproval.payload : undefined,
      });
      state.plan = {
        kind: 'compatibility_delegate',
        reason: 'approval_required_in_read_path',
        steps: ['compat.execute_vercel'],
      };
      execution.delegatedTo = 'vercel';
      statusHistory.push('Read path requested an approval-gated action, delegating to compatibility runtime.');
      await updateStatus('delegating', 'approval required');
      await this.persistNodeState(state, 'compat.execute_vercel');
      return {
        kind: 'compatibility',
        reason: 'approval_required_in_read_path',
        routeIntent: classification.intent,
        state,
      };
    }

    const deterministicFallback = buildDeterministicSynthesis({
      answerDraft: researchResult.text,
      evidence,
    });

    const synthesisModel = await resolveVercelLanguageModel(runtime.mode);
    const synthesisOutput = await runWithModelCircuitBreaker(synthesisModel.effectiveProvider, 'langgraph_synthesis', () => generateText({
      model: synthesisModel.model,
      system: 'Return JSON only.',
      prompt: buildSynthesisJsonPrompt({
        classification,
        answerDraft: researchResult.text,
        evidence,
        groundedEvidence,
      }),
      temperature: 0,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: false,
            thinkingLevel: synthesisModel.thinkingLevel,
          },
        },
      },
    })).catch((error) => {
      logger.warn('langgraph.synthesis.failed', {
        taskId: task.taskId,
        messageId: message.messageId,
        error: error instanceof Error ? error.message : 'unknown_synthesis_error',
      });
      return null;
    });

    const synthesisContract = resolveSynthesisContract({
      rawLlmOutput: synthesisOutput?.text ?? null,
      deterministicFallback,
    });

    const finalText = synthesisContract.synthesis.text.trim();
    statusHistory.push('Completed request.');
    await this.persistNodeState(state, 'synthesis.compose');

    const finalDedupeKey = `final:${state.run.id}`;
    const deliveryCheck = runtimeLoopGuards.registerDelivery(state.diagnostics, state.run.channel, finalDedupeKey);
    if (!deliveryCheck.blocked) {
      await channelAdapter.sendMessage({
        chatId: message.chatId,
        text: finalText,
        correlationId: task.taskId,
      });
      state.delivery.sentDedupeKeys.push(finalDedupeKey);
      state.delivery.outbox.push(buildDeliveryEnvelope({
        channel: 'lark',
        payloadType: 'final',
        text: finalText,
        dedupeKey: finalDedupeKey,
      }));
    }
    await updateStatus('processed', summarizeText(finalText, 180) ?? undefined);
    await this.persistNodeState(state, 'deliver.response');

    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, finalText);
    state.parity = {
      baselineEngine: 'vercel',
      candidateEngine: 'langgraph',
      diffSummary: classification.source === 'model' ? 'graph_read_path_model_routed' : 'graph_read_path_heuristic_routed',
      metrics: {
        retrievalMode: retrieval.mode,
        toolFamilies: selectedFamilies,
        evidenceCount: evidence.length,
        groundedEvidenceCount: groundedEvidence.length,
        synthesisSource: synthesisContract.source,
      },
    };
    await this.persistNodeState(state, 'persist_and_finish');

    return {
      kind: 'graph',
      state,
      result: {
        task,
        status: synthesisContract.synthesis.taskStatus,
        currentStep: 'persist_and_finish',
        latestSynthesis: finalText,
        agentResults: buildAgentResultsFromExecution(task.taskId, execution.steps),
        runtimeMeta: {
          engine: 'langgraph',
          threadId: state.conversation.id,
          node: 'persist_and_finish',
          stepHistory: ['route.classify', 'policy.gate', 'route.retrieval', 'research.execute', 'synthesis.compose', 'deliver.response', 'persist_and_finish'],
          routeIntent: classification.intent,
          canonicalIntent: task.canonicalIntent,
        },
      },
    };
  }
}

export const runtimeGraphExecutor = new RuntimeGraphExecutor();
