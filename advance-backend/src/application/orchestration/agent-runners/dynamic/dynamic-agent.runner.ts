import { generateText, stepCountIs } from 'ai';
import type { ToolSet } from 'ai';
import type { DynamicAgentDescriptor } from '../../../agents/dynamic-agent-descriptor';
import type { AgentRunCtx } from '../agent-run-ctx';
import { resolveToolsByIdFiltered } from '../../tools/tool-resolver';
import { resolveAgentHook } from './agent-hook';
import {
  runWithCircuitBreaker,
  CircuitBreakerOpenError,
  GEMINI_CIRCUIT_OPTIONS,
} from '../../../../shared/circuit-breaker';
import { getISTDateTime } from '../../agents/supervisor.prompt';

const DYNAMIC_AGENT_TIMEOUT_MS = 60_000;

export interface RunDynamicAgentInput {
  readonly task: string;
  readonly agent: DynamicAgentDescriptor;
  readonly ctx: AgentRunCtx;
  readonly additionalTools?: ToolSet;
  readonly depth?: number;
  readonly path?: readonly string[];
}

export type DynamicAgentRunResult =
  | { readonly status: 'success'; readonly result: string }
  | { readonly status: 'failed'; readonly result: string; readonly error: string };

export async function runDynamicAgent(input: RunDynamicAgentInput): Promise<DynamicAgentRunResult> {
  const depth = input.depth ?? 0;
  const path = input.path ?? [];
  const { agent, ctx } = input;
  const log = ctx.logger.child({ runner: 'dynamic', agentId: agent.id, agentSlug: agent.slug });

  if (depth > 3) {
    return { status: 'failed', result: 'error: dynamic agent depth limit exceeded', error: 'depth_limit' };
  }

  if (path.includes(agent.id)) {
    return { status: 'failed', result: 'error: dynamic agent cycle detected', error: 'cycle_detected' };
  }

  const hook = resolveAgentHook(agent.hookId);
  const hookCtx = { agent, task: input.task, ctx, depth, path };

  try {
    const pre = hook?.preExecute ? await hook.preExecute(hookCtx) : {};
    if (pre.shortCircuitResult) {
      return { status: 'success', result: pre.shortCircuitResult };
    }

    const adapterCtx = {
      runContext: ctx.runContext,
      perm:       ctx.perm,
      logger:     ctx.logger,
      clock:      ctx.clock,
      ...(ctx.approvalGate ? { approvalGate: ctx.approvalGate } : {}),
      ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
    };

    const directTools = resolveToolsByIdFiltered(
      agent.toolIds,
      ctx.perm.allowedToolIds,
      ctx.allTools,
      adapterCtx,
    );
    const tools = {
      ...directTools,
      ...(input.additionalTools ?? {}),
      ...(pre.additionalTools ?? {}),
    } as unknown as ToolSet;

    const system = [
      `Current date/time: ${getISTDateTime()}`,
      agent.systemPrompt,
      agent.capabilityDescription ? `Capability: ${agent.capabilityDescription}` : '',
      pre.additionalSystemPrompt ?? '',
    ].filter(Boolean).join('\n\n');

    const task = pre.modifiedTask ?? input.task;

    const toolNames = Object.keys(tools);
    log.info('dynamic_agent.start', {
      task: task.slice(0, 200),
      toolCount: toolNames.length,
      toolNames,
      maxSteps: agent.maxSteps,
      systemPromptLength: system.length,
      hookId: agent.hookId,
      depth,
    });

    const genResult = await runWithCircuitBreaker(
      'gemini',
      `dynamic-agent:${agent.slug}`,
      GEMINI_CIRCUIT_OPTIONS,
      () => generateText({
        model:       ctx.model,
        system,
        prompt:      task,
        tools,
        stopWhen:    [stepCountIs(agent.maxSteps)],
        temperature: agent.temperature,
        abortSignal: AbortSignal.timeout(DYNAMIC_AGENT_TIMEOUT_MS),
      }),
      log,
    );

    const { text, steps, finishReason } = genResult;

    log.info('dynamic_agent.generateText.done', {
      textLength: text?.length ?? 0,
      finishReason,
      stepCount: steps?.length ?? 0,
      toolCalls: steps?.flatMap(s => s.toolCalls?.map(tc => tc.toolName) ?? []) ?? [],
      toolResults: steps?.flatMap(s => s.toolResults?.map(tr => ({
        toolName: tr.toolName,
        resultLength: String(tr.output).length,
        resultPreview: String(tr.output).substring(0, 300),
      })) ?? []) ?? [],
      hasText: (text?.trim().length ?? 0) > 0,
    });

    const result = hook?.postExecute
      ? await hook.postExecute(hookCtx, text || 'Done.')
      : text || 'Done.';

    log.info('dynamic_agent.done', { replyLength: result.length, replyPreview: result.substring(0, 300) });
    return { status: 'success', result };
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) {
      log.warn('dynamic_agent.circuit_open', { retryAt: e.retryAt });
      return {
        status: 'failed',
        result: 'error: AI service temporarily unavailable, please try again shortly.',
        error:  'circuit_open',
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error('dynamic_agent.error', { error: msg });
    return { status: 'failed', result: `error: ${msg}`, error: msg };
  }
}
