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
import { redModelSelection } from '../../../../shared/model-selection-log';
import { getISTDateTime } from '../../agents/supervisor.prompt';
import {
  appendToolTrace,
  emitSpecialistFinished,
  emitSpecialistStarted,
  emitSpecialistStepToolResults,
} from '../tool-trace';
import { debugAgentStart, debugAgentResult } from '../../../../shared/debug-run-log';

const DYNAMIC_AGENT_TIMEOUT_MS = 600_000;

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
  const runnerStartMs = Date.now();

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
      ctx.toolById,
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
      ctx.groupContext ?? '',
    ].filter(Boolean).join('\n\n');

    const task = pre.modifiedTask ?? input.task;
    const selectedProvider = agent.provider ?? ctx.defaultModel?.provider ?? 'default';
    const selectedModelId = agent.modelId ?? ctx.defaultModel?.modelId ?? 'default';
    const modelSource = agent.provider && agent.modelId && ctx.resolveModel ? 'agent_override' : 'company_default';
    log.warn('ai.model.selected', {
      provider: selectedProvider,
      modelId: selectedModelId,
      source: modelSource,
      selection: redModelSelection({
        provider:  selectedProvider,
        modelId:   selectedModelId,
        source:    modelSource,
        agentSlug: agent.slug,
      }),
    });

    const model = agent.provider && agent.modelId && ctx.resolveModel
      ? await ctx.resolveModel({
        provider:  agent.provider,
        modelId:   agent.modelId,
        companyId: agent.companyId,
        agentSlug: agent.slug,
      })
      : ctx.model;

    const toolNames = Object.keys(tools);
    const agentStartMs = Date.now();
    debugAgentStart({
      agentSlug: agent.slug,
      task,
      toolCount: toolNames.length,
      toolNames,
      depth,
      model: `${selectedProvider}/${selectedModelId}`,
      systemPrompt: system,
    });
    log.info('dynamic_agent.start', {
      task: task.slice(0, 200),
      toolCount: toolNames.length,
      toolNames,
      maxSteps: agent.maxSteps,
      systemPromptLength: system.length,
      hookId: agent.hookId,
      provider: agent.provider,
      modelId: agent.modelId,
      depth,
    });

    emitSpecialistStarted({
      tracer: ctx.tracer,
      actorKey: agent.slug,
      toolName: agent.slug,
      task,
      toolCount: toolNames.length,
      depth,
    });

    const circuitProvider = agent.provider ?? 'gemini';
    const genResult = await runWithCircuitBreaker(
      circuitProvider,
      `dynamic-agent:${agent.slug}`,
      GEMINI_CIRCUIT_OPTIONS,
      () => generateText({
        model,
        system,
        prompt:      task,
        tools,
        stopWhen:    [stepCountIs(agent.maxSteps)],
        temperature: agent.temperature,
        maxRetries:  1,
        abortSignal: AbortSignal.timeout(DYNAMIC_AGENT_TIMEOUT_MS),
      }),
      log,
    );

    const { text, steps, finishReason } = genResult;
    emitSpecialistStepToolResults({
      tracer: ctx.tracer,
      actorKey: agent.slug,
      steps,
    });

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

    // If the agent's LLM produced no text but tools returned data,
    // run a presentation pass — a separate LLM call with NO tools that
    // formats the full tool output for the user. This preserves all data.
    let agentText = text || '';
    if (!agentText.trim() && steps && steps.length > 0) {
      const allToolOutputs = steps.flatMap(s =>
        (s.toolResults ?? []).map(tr => `[${tr.toolName}]:\n${String(tr.output)}`)
      );
      if (allToolOutputs.length > 0) {
        log.info('dynamic_agent.presentation_pass.start', { agentSlug: agent.slug, toolOutputCount: allToolOutputs.length });
        try {
          const presentation = await generateText({
            model,
            system: `You are presenting data returned by tools to the user. Rules:
- Present ALL data completely — do NOT summarize, truncate, or omit any items.
- Format clearly: use tables, bullet points, or structured lists for readability.
- Include every record, every number, every detail from the tool output.
- If there are many items, structure them but keep ALL of them.
- Do not mention tools, agents, or internal processes.
- Be direct — no filler phrases.`,
            prompt: `Original request: ${task}\n\nTool results:\n\n${allToolOutputs.join('\n\n---\n\n')}`,
            temperature: 0.2,
            maxRetries: 1,
            abortSignal: AbortSignal.timeout(60_000),
          });
          agentText = presentation.text || agentText;
          log.info('dynamic_agent.presentation_pass.done', { agentSlug: agent.slug, textLength: agentText.length });
        } catch (e) {
          log.warn('dynamic_agent.presentation_pass.failed', { agentSlug: agent.slug, error: String(e) });
        }
      }
    }

    const result = hook?.postExecute
      ? await hook.postExecute(hookCtx, agentText || 'Done.')
      : agentText || 'Done.';

    const traced = appendToolTrace(result, steps);
    debugAgentResult({
      agentSlug: agent.slug,
      status: 'success',
      result: traced,
      durationMs: Date.now() - agentStartMs,
      steps: steps as any,
    });
    log.info('dynamic_agent.done', { replyLength: traced.length, replyPreview: traced.substring(0, 300) });
    emitSpecialistFinished({
      tracer: ctx.tracer,
      actorKey: agent.slug,
      toolName: agent.slug,
      output: traced,
      startMs: runnerStartMs,
    });
    return { status: 'success', result: traced };
  } catch (e) {
    if (e instanceof CircuitBreakerOpenError) {
      log.warn('dynamic_agent.circuit_open', { retryAt: e.retryAt });
      emitSpecialistFinished({
        tracer: ctx.tracer,
        actorKey: agent.slug,
        toolName: agent.slug,
        output: 'error: AI service temporarily unavailable, please try again shortly.',
        startMs: runnerStartMs,
      });
      return {
        status: 'failed',
        result: 'error: AI service temporarily unavailable, please try again shortly.',
        error:  'circuit_open',
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error('dynamic_agent.error', { error: msg });
    emitSpecialistFinished({
      tracer: ctx.tracer,
      actorKey: agent.slug,
      toolName: agent.slug,
      output: `error: ${msg}`,
      startMs: runnerStartMs,
    });
    return { status: 'failed', result: `error: ${msg}`, error: msg };
  }
}
