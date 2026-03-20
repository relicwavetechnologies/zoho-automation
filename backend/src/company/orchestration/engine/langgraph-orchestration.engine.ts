import { logger } from '../../../utils/logger';
import { hitlActionRepository } from '../../state/hitl';
import type { ToolActionGroup } from '../../tools/tool-action-groups';
import { runtimeGraphExecutor, runtimeRunRepository, runtimeService } from '../langgraph';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import { vercelOrchestrationEngine } from './vercel-orchestration.engine';

const resolveCompanyId = (input: OrchestrationExecutionInput): string | null =>
  typeof input.message.trace?.companyId === 'string' && input.message.trace.companyId.trim().length > 0
    ? input.message.trace.companyId.trim()
    : null;

const buildRuntimeActor = (input: OrchestrationExecutionInput) => ({
  userId: input.message.userId,
  linkedUserId: input.message.trace?.linkedUserId,
  requesterEmail: input.message.trace?.requesterEmail,
  aiRole: input.message.trace?.userRole ?? 'MEMBER',
  larkUserId: input.message.trace?.larkUserId,
  larkOpenId: input.message.trace?.larkOpenId,
  larkTenantKey: input.message.trace?.larkTenantKey,
});

const resolveEntrypoint = (input: OrchestrationExecutionInput): 'lark_message' => 'lark_message';

const maybeMirrorPendingApproval = async (input: {
  execution: OrchestrationExecutionInput;
  conversationId: string;
  runId: string;
}) => {
  const pending = await hitlActionRepository.getByTaskId(input.execution.task.taskId);
  if (!pending || pending.status !== 'pending') {
    return null;
  }

  const hydrated = await hitlActionRepository.getHydratedByActionId(pending.actionId);
  if (!hydrated) {
    return null;
  }

  return runtimeService.mirrorLegacyApproval({
    conversationId: input.conversationId,
    runId: input.runId,
    channel: 'lark',
    legacyAction: hydrated,
  });
};

const wrapCompatibilityResult = async (input: {
  execution: OrchestrationExecutionInput;
  conversationId: string;
  runId: string;
  compatibilityResult: OrchestrationExecutionResult;
  routeIntent?: string;
}): Promise<OrchestrationExecutionResult> => {
  const mirroredApproval = await maybeMirrorPendingApproval({
    execution: input.execution,
    conversationId: input.conversationId,
    runId: input.runId,
  });

  if (mirroredApproval) {
    await runtimeRunRepository.createSnapshot({
      runId: input.runId,
      stepIndex: input.compatibilityResult.task.plan.length,
      nodeName: 'await_approval',
      stateJson: {
        status: 'hitl',
        approvalId: mirroredApproval.id,
        externalActionId: mirroredApproval.externalActionId,
      },
    });

    return {
      ...input.compatibilityResult,
      status: 'hitl',
      currentStep: 'await_approval',
      runtimeMeta: {
        engine: 'langgraph',
        threadId: input.conversationId,
        node: 'await_approval',
        stepHistory: ['load_run_context', 'compat.execute_vercel', 'await_approval'],
        routeIntent: input.routeIntent ?? input.compatibilityResult.runtimeMeta?.routeIntent,
      },
      hitlAction: {
        taskId: input.execution.task.taskId,
        actionId: mirroredApproval.externalActionId ?? mirroredApproval.id,
        actionType: 'write',
        summary: mirroredApproval.summary,
        toolId: mirroredApproval.toolId,
        actionGroup: mirroredApproval.actionGroup as ToolActionGroup,
        channel: 'lark',
        subject: mirroredApproval.subject ?? undefined,
        requestedAt: mirroredApproval.createdAt.toISOString(),
        expiresAt: mirroredApproval.expiresAt?.toISOString() ?? mirroredApproval.createdAt.toISOString(),
        status: 'pending',
      },
    };
  }

  await runtimeRunRepository.createSnapshot({
    runId: input.runId,
    stepIndex: input.compatibilityResult.task.plan.length,
    nodeName: 'persist_and_finish',
    stateJson: {
      status: input.compatibilityResult.status,
      currentStep: input.compatibilityResult.currentStep ?? null,
      latestSynthesis: input.compatibilityResult.latestSynthesis ?? null,
    },
  });

  return {
    ...input.compatibilityResult,
    runtimeMeta: {
      engine: 'langgraph',
      threadId: input.conversationId,
      node: input.compatibilityResult.currentStep ?? 'persist_and_finish',
      stepHistory: ['load_run_context', 'compat.execute_vercel', input.compatibilityResult.currentStep ?? 'persist_and_finish'],
      routeIntent: input.routeIntent ?? input.compatibilityResult.runtimeMeta?.routeIntent,
    },
  };
};

export const langgraphOrchestrationEngine: OrchestrationEngine = {
  id: 'langgraph',
  async buildTask(taskId, message) {
    return legacyOrchestrationEngine.buildTask(taskId, message);
  },
  async executeTask(input) {
    const companyId = resolveCompanyId(input);
    if (!companyId) {
      logger.warn('langgraph.engine.company_missing_fallback', {
        taskId: input.task.taskId,
        messageId: input.message.messageId,
        channel: input.message.channel,
      });
      return vercelOrchestrationEngine.executeTask(input);
    }

    if (input.message.channel !== 'lark') {
      logger.warn('langgraph.engine.channel_fallback', {
        taskId: input.task.taskId,
        messageId: input.message.messageId,
        channel: input.message.channel,
      });
      return vercelOrchestrationEngine.executeTask(input);
    }

    const started = await runtimeService.startRun({
      companyId,
      channel: 'lark',
      entrypoint: resolveEntrypoint(input),
      actor: buildRuntimeActor(input),
      chatId: input.message.chatId,
      incomingMessage: {
        sourceMessageId: input.message.messageId,
        text: input.message.text,
        attachments: input.message.attachedFiles,
      },
      traceJson: {
        requestId: input.message.trace?.requestId,
        eventId: input.message.trace?.eventId,
        larkTenantKey: input.message.trace?.larkTenantKey,
      },
      metadataJson: {
        taskId: input.task.taskId,
        plan: input.task.plan,
      },
    });

    try {
      const graphExecution = await runtimeGraphExecutor.execute({
        task: input.task,
        message: input.message,
        state: started.state,
      });

      if (graphExecution.kind === 'compatibility') {
        const compatibilityResult = await vercelOrchestrationEngine.executeTask(input);
        const wrapped = await wrapCompatibilityResult({
          execution: input,
          conversationId: started.conversationId,
          runId: started.runId,
          compatibilityResult,
          routeIntent: graphExecution.routeIntent,
        });

        await runtimeService.createShadowParityReport({
          conversationId: started.conversationId,
          runId: started.runId,
          channel: 'lark',
          baselineSummary: compatibilityResult.latestSynthesis ?? null,
          candidateSummary: null,
          diffSummary: graphExecution.reason,
          metricsJson: {
            delegated: true,
            routeIntent: graphExecution.routeIntent,
            reason: graphExecution.reason,
          },
        });

        if (wrapped.status === 'hitl') {
          return wrapped;
        }

        if (wrapped.status === 'failed' || wrapped.status === 'cancelled') {
          await runtimeService.failRun({
            conversationId: started.conversationId,
            runId: started.runId,
            code: wrapped.status === 'cancelled' ? 'langgraph_cancelled' : 'langgraph_failed',
            message: wrapped.latestSynthesis ?? wrapped.currentStep ?? 'LangGraph compatibility execution failed.',
            retriable: wrapped.status !== 'cancelled',
            stopReason: wrapped.status === 'cancelled' ? 'manual_stop' : 'tool_execution_failure',
          });
        } else {
          await runtimeService.completeRun({
            conversationId: started.conversationId,
            runId: started.runId,
            channel: 'lark',
            summary: wrapped.latestSynthesis,
          });
        }

        return wrapped;
      }

      await runtimeService.createShadowParityReport({
        conversationId: started.conversationId,
        runId: started.runId,
        channel: 'lark',
        baselineSummary: null,
        candidateSummary: graphExecution.result.latestSynthesis ?? null,
        diffSummary: graphExecution.state.parity?.diffSummary ?? null,
        metricsJson: graphExecution.state.parity?.metrics ?? null,
      });

      if (graphExecution.result.status === 'failed' || graphExecution.result.status === 'cancelled') {
        await runtimeService.failRun({
          conversationId: started.conversationId,
          runId: started.runId,
          code: graphExecution.result.status === 'cancelled' ? 'langgraph_cancelled' : 'langgraph_failed',
          message: graphExecution.result.latestSynthesis ?? graphExecution.result.currentStep ?? 'LangGraph execution failed.',
          retriable: graphExecution.result.status !== 'cancelled',
          stopReason: graphExecution.result.status === 'cancelled' ? 'manual_stop' : 'tool_execution_failure',
        });
      } else {
        await runtimeService.completeRun({
          conversationId: started.conversationId,
          runId: started.runId,
          channel: 'lark',
          summary: graphExecution.result.latestSynthesis,
        });
      }

      return graphExecution.result;
    } catch (error) {
      await runtimeService.failRun({
        conversationId: started.conversationId,
        runId: started.runId,
        code: 'langgraph_engine_exception',
        message: error instanceof Error ? error.message : 'Unknown langgraph engine failure.',
        retriable: true,
        stopReason: 'tool_execution_failure',
      });
      throw error;
    }
  },
};

export const langGraphOrchestrationEngine = langgraphOrchestrationEngine;
